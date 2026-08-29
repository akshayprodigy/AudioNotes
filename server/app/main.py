"""
The licence server.

Two audiences with different needs. The Android app wants one thing -- a token for this device --
and wants it to keep working when the network does not. A person on the web wants to sign up, pay,
and see what they are paying for.

What this server is NOT is as important as what it is: it never receives a recording, a transcript,
a title or a count of anything the user made. See store.py.
"""

from __future__ import annotations

import logging
from typing import Any

from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from . import mailer
from .branding import PRODUCT_NAME
from .billing import apply_webhook, start_subscription
from .entitlement import issue
from .licence import signing_key_from_env
from .pages import register_pages
from .store import DEVICE_LIMIT, Store


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 -- any malformed body is the same answer
        return {}
    return body if isinstance(body, dict) else {}


def create_app(
    store: Store | None = None,
    signing_key: ec.EllipticCurvePrivateKey | None = None,
) -> FastAPI:
    """
    Build the app.

    A factory rather than a module-level ``app``, so uvicorn is started with ``--factory``. The
    signing key is loaded here, which means a server with no key fails at boot with one clear
    message instead of minting nothing and failing per-request later -- and the module still
    imports without a key, which is what lets the tests construct it with their own.
    """
    app = FastAPI(
        title=f"{PRODUCT_NAME} licence server",
        # No interactive docs in production: this API has five endpoints documented in the README
        # and a generated explorer is only an invitation to poke at the billing routes.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    store = Store() if store is None else store
    key = signing_key_from_env() if signing_key is None else signing_key

    # Said once at boot rather than discovered by a customer who never got their reset link.
    if not mailer.is_configured():
        logging.getLogger("audionotes").warning(
            "SMTP is not configured — password reset links will be logged, not sent."
        )

    # ---- accounts ----

    @app.post("/api/account/signup")
    async def signup(request: Request):
        body = await _json_body(request)
        email, password = body.get("email"), body.get("password")
        if not isinstance(email, str) or "@" not in email:
            return _error(400, "A valid email is required")
        if not isinstance(password, str) or len(password) < 8:
            return _error(400, "Password must be at least 8 characters")
        if store.account_by_email(email):
            # Deliberately the same shape of answer as success would give a bot, minus the account:
            # this endpoint should not become a way to test which emails are registered.
            return _error(409, "That email is already registered")
        account = store.create_account(email, password)
        return {"accountId": account.id, "email": account.email}

    @app.post("/api/account/signin")
    async def signin(request: Request):
        """
        Sign in from the app.

        Returns a licence token AND a device-scoped refresh key, so the password is typed once and
        never stored. A refresh two weeks later must not require the account password to be sitting
        on the phone, or re-typed by someone who has long since forgotten it.
        """
        body = await _json_body(request)
        email, password, device_id = body.get("email"), body.get("password"), body.get("deviceId")
        if not isinstance(email, str) or not isinstance(password, str):
            return _error(400, "Email and password are required")
        if not isinstance(device_id, str) or not device_id:
            return _error(400, "deviceId is required")

        account = store.authenticate(email, password)
        # One message for "no such account" and "wrong password": telling them apart is how an
        # attacker enumerates who has an account here.
        if account is None:
            return _error(401, "Email or password is incorrect")

        if not store.touch_device(account.id, device_id):
            return _error(
                409,
                f"This subscription is already on {DEVICE_LIMIT} devices. Remove one from your "
                "account page to add this one.",
            )
        refresh_key = store.issue_refresh_key(account.id, device_id)
        licence = issue(store, key, account.id, device_id)

        return {
            "accountId": account.id,
            "email": account.email,
            "refreshKey": refresh_key,
            # Null when the account exists but has no subscription -- a real state, not an error.
            # The app shows the free tier and says nothing further.
            "token": licence.token if licence else None,
            "plan": licence.plan if licence else "free",
            "expiresAt": licence.expires_at if licence else 0,
        }

    @app.post("/api/licence/refresh")
    async def refresh(request: Request):
        """The periodic refresh. No password: a device-scoped key it was given at sign-in."""
        body = await _json_body(request)
        device_id, refresh_key = body.get("deviceId"), body.get("refreshKey")
        if not isinstance(device_id, str) or not isinstance(refresh_key, str):
            return _error(400, "deviceId and refreshKey are required")
        account_id = store.account_for_refresh_key(device_id, refresh_key)
        if account_id is None:
            return _error(401, "Sign in again")

        licence = issue(store, key, account_id, device_id)
        return {
            "token": licence.token if licence else None,
            "plan": licence.plan if licence else "free",
            "expiresAt": licence.expires_at if licence else 0,
        }

    # ---- billing ----

    @app.post("/api/billing/subscribe")
    async def subscribe(request: Request):
        body = await _json_body(request)
        email, password = body.get("email"), body.get("password")
        if not isinstance(email, str) or not isinstance(password, str):
            return _error(400, "Sign in to subscribe")
        result = start_subscription(store, email, password)
        if result.checkout_url is None:
            return _error(result.status, result.error or "Could not start the subscription")
        return {"subscriptionId": result.subscription_id, "checkoutUrl": result.checkout_url}

    @app.post("/api/billing/webhook")
    async def webhook(request: Request):
        # The signature is over the RAW body -- a parsed and re-serialised body does not hash to
        # the same bytes, so this route reads bytes and parses them itself.
        raw = await request.body()
        status, message = apply_webhook(
            store,
            raw,
            request.headers.get("x-razorpay-signature", ""),
            request.headers.get("x-razorpay-event-id", ""),
        )
        return PlainTextResponse(message, status_code=status)

    # ---- web pages ----

    register_pages(app, store)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    return app
