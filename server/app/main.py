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
from fastapi.responses import JSONResponse

from . import mailer
from .branding import PRODUCT_NAME
from .billing import link_play_purchase, refresh_play_subscription
from .entitlement import issue
from .licence import signing_key_from_env
from .admin import register_admin
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

        # A Play subscription is pulled, not pushed: there is no webhook telling us it lapsed, so
        # this is where a cancellation or expiry gets noticed. Silent on any Google failure — an
        # outage there must not revoke a paying customer.
        refresh_play_subscription(store, account_id)

        licence = issue(store, key, account_id, device_id)
        return {
            "token": licence.token if licence else None,
            "plan": licence.plan if licence else "free",
            "expiresAt": licence.expires_at if licence else 0,
        }

    # ---- billing ----

    @app.post("/api/billing/play/link")
    async def play_link(request: Request):
        """
        Exchange a Google Play purchase token for a licence.

        The Play equivalent of signing in: it identifies the buyer, registers the device and hands
        back the same token and refresh key the web path does. No email and no password, because
        Google has already established who this is.

        Safe to call repeatedly — on a reinstall, on a second device, after a plan change. Each
        call re-verifies with Google and re-registers the device, so "restore purchases" is this
        endpoint and nothing else.
        """
        body = await _json_body(request)
        purchase_token, device_id = body.get("purchaseToken"), body.get("deviceId")
        if not isinstance(purchase_token, str) or not purchase_token:
            return _error(400, "purchaseToken is required")
        if not isinstance(device_id, str) or not device_id:
            return _error(400, "deviceId is required")

        result = link_play_purchase(store, purchase_token)
        if result.account_id is None:
            return _error(result.status, result.error or "Could not verify that purchase")

        if not store.touch_device(result.account_id, device_id):
            return _error(
                409,
                f"This subscription is already on {DEVICE_LIMIT} devices. Remove one from your "
                "account page to add this one.",
            )
        refresh_key = store.issue_refresh_key(result.account_id, device_id)
        licence = issue(store, key, result.account_id, device_id)

        return {
            "accountId": result.account_id,
            "refreshKey": refresh_key,
            "token": licence.token if licence else None,
            "plan": licence.plan if licence else "free",
            "expiresAt": licence.expires_at if licence else 0,
        }

    # ---- web pages ----

    register_pages(app, store)

    # The admin console. Mounted always, but every route inside answers 404 until
    # ADMIN_SESSION_SECRET and VERBALE_ADMIN_EMAILS are both set — so turning it on is a restart,
    # not a different build, and a server that was never configured for it does not advertise it.
    register_admin(app, store)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    return app
