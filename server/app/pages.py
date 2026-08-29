"""
The web front end.

Server-rendered, because there are five pages and none of them has state worth a client-side
framework. It also keeps the whole thing one deployable process: an app that promises no cloud
should have as little cloud as possible to run.

These pages are the ONLY place a subscription is sold. The Android app never links here -- that is
what keeps the arrangement inside store policy -- so this has to stand on its own for somebody
arriving from an email or a browser bookmark.
"""

from __future__ import annotations

import html
import time
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from . import mailer
from .billing import start_subscription
from .entitlement import is_entitled
from .store import DEVICE_LIMIT, PASSWORD_RESET_TTL_SECONDS, Store

CSS = """
  :root { color-scheme: light dark; --ink:#16192C; --dim:#6B7185; --line:#E4E7F1;
          --primary:#4A56D2; --card:#fff; --bg:#F4F6FB; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#F2F4FA; --dim:#A2A8BC; --line:#2A2F45; --card:#191D2E; --bg:#11131F; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font: 16px/1.6 -apple-system,
         BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 48px 20px 80px; }
  h1 { font-size: 30px; line-height:1.2; margin: 0 0 8px; letter-spacing:-0.5px; }
  h2 { font-size: 18px; margin: 32px 0 8px; }
  p { color: var(--dim); margin: 0 0 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px;
          padding: 22px; margin: 18px 0; }
  label { display:block; font-size:13px; color:var(--dim); margin: 12px 0 6px; }
  input { width:100%; padding: 12px 14px; border:1px solid var(--line); border-radius:10px;
          background:transparent; color:var(--ink); font-size:16px; }
  button { width:100%; margin-top:18px; padding: 13px; border:0; border-radius:10px;
           background: var(--primary); color:#fff; font-size:16px; font-weight:600; cursor:pointer; }
  button.secondary { background: transparent; color: var(--primary); border:1px solid var(--line); }
  a { color: var(--primary); }
  .err { color:#C2410C; font-size:14px; margin-top:12px; }
  .ok { color:#12A870; font-size:14px; margin-top:12px; }
  .muted { font-size:13px; color:var(--dim); }
  ul { color: var(--dim); padding-left: 20px; }
"""


def layout(title: str, body: str) -> str:
    return (
        "<!doctype html>\n<html lang=\"en\"><head>\n"
        "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        f"<title>{html.escape(title)} · AudioNotes</title><style>{CSS}</style>\n"
        f"</head><body><div class=\"wrap\">{body}</div></body></html>"
    )


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def _page(title: str, body: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(layout(title, body), status_code=status)


def _date(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%-d %B %Y")


def register_pages(app: FastAPI, store: Store) -> None:
    @app.get("/", response_class=HTMLResponse)
    def home() -> HTMLResponse:
        return _page(
            "Meeting notes that never leave your phone",
            f"""<h1>AudioNotes</h1>
         <p>Records a meeting, writes the minutes, and does all of it on your phone. No recording,
            no transcript and no summary is ever uploaded &mdash; there is no server here that could
            hold one.</p>

         <div class="card">
           <h2 style="margin-top:0">Free, forever</h2>
           <ul>
             <li>Record any meeting</li>
             <li>Full transcript, separated by speaker</li>
             <li>Decisions, actions and open questions, pulled from what was actually said</li>
           </ul>
           <p class="muted">No account needed. Nothing expires.</p>
         </div>

         <div class="card">
           <h2 style="margin-top:0">Pro</h2>
           <ul>
             <li>Everything above</li>
             <li>The summary and the minutes, written in plain English by a model that runs on
                 your own phone</li>
             <li>Up to {DEVICE_LIMIT} devices on one subscription</li>
           </ul>
           <p class="muted">Your notes stay yours if you stop paying &mdash; every summary already
              written stays readable, and you can export everything at any time.</p>
           <a href="/signup"><button>Create an account</button></a>
           <p class="muted" style="text-align:center;margin-top:14px">
             Already have one? <a href="/account">Sign in</a>
           </p>
         </div>""",
        )

    @app.get("/signup", response_class=HTMLResponse)
    def signup_form() -> HTMLResponse:
        return _page(
            "Create an account",
            """<h1>Create an account</h1>
         <p>Only an email and a password. We never ask for anything about your meetings, because
            we have nowhere to put it.</p>
         <form class="card" method="post" action="/signup">
           <label for="email">Email</label>
           <input id="email" name="email" type="email" required autocomplete="email">
           <label for="password">Password</label>
           <input id="password" name="password" type="password" required minlength="8"
                  autocomplete="new-password">
           <button type="submit">Create account</button>
         </form>""",
        )

    @app.post("/signup", response_class=HTMLResponse)
    async def signup(request: Request) -> HTMLResponse:
        form = await request.form()
        email = str(form.get("email") or "")
        password = str(form.get("password") or "")
        if "@" not in email or len(password) < 8:
            return _page(
                "Create an account",
                """<h1>Check that again</h1>
          <p class="err">A valid email and a password of at least 8 characters are required.</p>
          <a href="/signup">Back</a>""",
                status=400,
            )
        if store.account_by_email(email):
            return _page(
                "Create an account",
                """<h1>Already registered</h1>
        <p>That email already has an account. <a href="/account">Sign in</a> instead.</p>""",
                status=409,
            )
        store.create_account(email, password)
        return _page(
            "Account created",
            """<h1>Account created</h1>
         <p class="ok">You can sign in on your phone now &mdash; Settings, then Subscription.</p>
         <div class="card">
           <p>To use Pro, add a subscription from your account page.</p>
           <a href="/account"><button>Go to my account</button></a>
         </div>""",
        )

    # The account page.
    #
    # Password on the form rather than a session cookie: there are two actions here and no
    # long-lived browsing to protect. A session would mean cookie handling, CSRF and expiry --
    # complexity that buys nothing on a page you visit twice a year.
    @app.get("/account", response_class=HTMLResponse)
    def account_form() -> HTMLResponse:
        return _page(
            "Your account",
            """<h1>Your account</h1>
         <form class="card" method="post" action="/account">
           <label for="email">Email</label>
           <input id="email" name="email" type="email" required autocomplete="email">
           <label for="password">Password</label>
           <input id="password" name="password" type="password" required autocomplete="current-password">
           <button type="submit">Sign in</button>
         </form>
         <p class="muted">No account? <a href="/signup">Create one</a>.
            Forgotten your password? <a href="/forgot">Reset it</a>.</p>""",
        )

    def _signed_out() -> HTMLResponse:
        return _page(
            "Your account",
            """<h1>Sign in</h1>
          <p class="err">Email or password is incorrect.</p><a href="/account">Try again</a>""",
            status=401,
        )

    @app.post("/account", response_class=HTMLResponse)
    async def account(request: Request) -> HTMLResponse:
        form = await request.form()
        email = str(form.get("email") or "")
        password = str(form.get("password") or "")
        acct = store.authenticate(email, password)
        if acct is None:
            return _signed_out()

        sub = store.subscription(acct.id)
        now = int(time.time())
        active = is_entitled(sub, now)
        devices = store.devices(acct.id)
        renews = _date(sub.current_period_end) if sub.current_period_end else None

        if active:
            plan_block = (
                f"<p>Cancelled &mdash; Pro continues until {renews}.</p>"
                if sub.status == "cancelled"
                else f"<p>Renews {renews}.</p>"
            )
        else:
            plan_block = f"""<p>The summary and written minutes need a subscription. Everything else in the
                    app keeps working without one.</p>
                  <form method="post" action="/subscribe">
                    <input type="hidden" name="email" value="{esc(acct.email)}">
                    <label for="p">Confirm your password</label>
                    <input id="p" name="password" type="password" required autocomplete="current-password">
                    <button type="submit">Subscribe</button>
                  </form>"""

        if devices:
            device_rows = "".join(
                f"""<form method="post" action="/devices/forget"
                                 style="display:flex;gap:10px;align-items:center;margin:10px 0">
                             <span class="muted" style="flex:1">{esc(d.device_id[:8])}&hellip; &mdash;
                               last seen {_date(d.last_seen)}</span>
                             <input type="hidden" name="email" value="{esc(acct.email)}">
                             <input type="hidden" name="password" value="{esc(password)}">
                             <input type="hidden" name="deviceId" value="{esc(d.device_id)}">
                             <button class="secondary" style="width:auto;margin:0;padding:8px 14px"
                                     type="submit">Remove</button>
                           </form>"""
                for d in devices
            )
        else:
            device_rows = '<p class="muted">No devices yet. Sign in from the app to add one.</p>'

        return _page(
            "Your account",
            f"""<h1>{esc(acct.email)}</h1>
         <div class="card">
           <h2 style="margin-top:0">{"Pro" if active else "Free"}</h2>
           {plan_block}
         </div>
         <div class="card">
           <h2 style="margin-top:0">Devices</h2>
           <p class="muted">{len(devices)} of {DEVICE_LIMIT} in use.</p>
           {device_rows}
           <p class="muted">Removing a device does not delete anything on it. Its meetings stay
              where they are; it simply stops renewing this subscription.</p>
         </div>""",
        )

    # Remove a device from an account.
    #
    # The limit is meaningless without this. A person who replaces a phone three times would
    # otherwise be locked out of their own subscription with no way through but an email to
    # support -- which is a bad experience and, at any volume, a bad business.
    #
    # Re-authenticated rather than trusted from the form: this page carries no session, so the
    # password comes back with the request. That is also why the button is a POST and not a link --
    # a GET that deletes something will eventually be prefetched by a browser.
    @app.post("/devices/forget", response_class=HTMLResponse)
    async def forget_device(request: Request) -> HTMLResponse:
        form = await request.form()
        acct = store.authenticate(
            str(form.get("email") or ""), str(form.get("password") or "")
        )
        if acct is None:
            return _signed_out()
        store.forget_device(acct.id, str(form.get("deviceId") or ""))
        return _page(
            "Device removed",
            """<h1>Device removed</h1>
        <p class="ok">That device will stop renewing this subscription. Nothing on it was
           deleted.</p>
        <a href="/account"><button>Back to my account</button></a>""",
        )

    # ---- password reset ----
    #
    # The one thing this server sends email for. Everything about the flow below is shaped by two
    # rules: the page may never reveal whether an address has an account, and a link that has been
    # used or has aged out is worth nothing.

    @app.get("/forgot", response_class=HTMLResponse)
    def forgot_form() -> HTMLResponse:
        return _page(
            "Reset your password",
            """<h1>Reset your password</h1>
         <p>We will email you a link. It works once, and for an hour.</p>
         <form class="card" method="post" action="/forgot">
           <label for="email">Email</label>
           <input id="email" name="email" type="email" required autocomplete="email">
           <button type="submit">Send the link</button>
         </form>
         <p class="muted"><a href="/account">Back to sign in</a></p>""",
        )

    @app.post("/forgot", response_class=HTMLResponse)
    async def forgot(request: Request) -> HTMLResponse:
        form = await request.form()
        email = str(form.get("email") or "")
        account = store.account_by_email(email) if "@" in email else None

        if account is not None:
            token = store.create_password_reset(account.id)
            base = mailer.public_base_url(str(request.base_url))
            mailer.send(
                account.email,
                "Reset your AudioNotes password",
                f"""Someone asked to reset the password for this account.

Open this link to choose a new one:

  {base}/reset?token={token}

It works once, and stops working in {PASSWORD_RESET_TTL_SECONDS // 60} minutes.

If it was not you, nothing has happened and you can ignore this. Your password has not changed.
""",
            )

        # The same answer either way, and no hint in the timing worth chasing: telling the two
        # apart turns this page into a way to ask whether somebody has an account here.
        return _page(
            "Check your email",
            """<h1>Check your email</h1>
         <p class="ok">If that address has an account, a reset link is on its way.</p>
         <p class="muted">It works once, and for an hour. <a href="/account">Back to sign in</a></p>""",
        )

    def _dead_link() -> HTMLResponse:
        return _page(
            "Reset your password",
            """<h1>That link has expired</h1>
         <p class="err">Reset links work once, and for an hour.</p>
         <a href="/forgot"><button>Send me a new one</button></a>""",
            status=400,
        )

    @app.get("/reset", response_class=HTMLResponse)
    def reset_form(token: str = "") -> HTMLResponse:
        # Checked but not spent: a mail client that prefetches links would otherwise burn the
        # token before the person ever saw the form.
        if not token or store.peek_password_reset(token) is None:
            return _dead_link()
        return _page(
            "Choose a new password",
            f"""<h1>Choose a new password</h1>
         <form class="card" method="post" action="/reset">
           <input type="hidden" name="token" value="{esc(token)}">
           <label for="password">New password</label>
           <input id="password" name="password" type="password" required minlength="8"
                  autocomplete="new-password">
           <button type="submit">Save it</button>
         </form>
         <p class="muted">Your phones will ask you to sign in again afterwards.</p>""",
        )

    @app.post("/reset", response_class=HTMLResponse)
    async def reset(request: Request) -> HTMLResponse:
        form = await request.form()
        token = str(form.get("token") or "")
        password = str(form.get("password") or "")

        if len(password) < 8:
            return _page(
                "Choose a new password",
                f"""<h1>Too short</h1>
             <p class="err">A password of at least 8 characters, please.</p>
             <a href="/reset?token={esc(token)}">Back</a>""",
                status=400,
            )

        account_id = store.consume_password_reset(token)
        if account_id is None:
            return _dead_link()

        store.set_password(account_id, password)
        # A reset is the moment to evict anyone who got in. The password alone does not do that:
        # a device that already signed in holds a refresh key that is not derived from it.
        store.clear_refresh_keys(account_id)

        return _page(
            "Password changed",
            """<h1>Password changed</h1>
         <p class="ok">You can sign in with it now.</p>
         <div class="card">
           <p>Every device signed into this account has been signed out, including your own.
              Open the app, go to Settings then Subscription, and sign in once more.</p>
           <a href="/account"><button>Sign in</button></a>
         </div>""",
        )

    @app.post("/subscribe")
    async def subscribe(request: Request):
        """Kick off Razorpay checkout from the account page."""
        form = await request.form()
        result = start_subscription(
            store, str(form.get("email") or ""), str(form.get("password") or "")
        )
        if result.checkout_url is None:
            return _page(
                "Subscribe",
                f"""<h1>Could not start the subscription</h1>
            <p class="err">{esc(result.error or "Unknown error")}</p>
            <a href="/account">Back to my account</a>""",
                status=result.status,
            )
        # 303, so the browser turns this POST into a GET of the checkout page. A 302 leaves the
        # method up to the browser, and a POST to Razorpay's hosted page is not what we mean.
        return RedirectResponse(result.checkout_url, status_code=303)
