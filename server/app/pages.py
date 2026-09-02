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

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import mailer
from . import landing
from .billing import cancel_play_subscription
from .branding import PRODUCT_NAME
from .legal import register_legal
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


#: What search engines and link previews show. One sentence, under 160 characters, saying what the
#: product is rather than what page you are on — most pages here are forms, and "Sign in" is not
#: worth indexing.
DEFAULT_DESCRIPTION = (
    f"{PRODUCT_NAME} records meetings and writes the minutes entirely on your phone. "
    "Transcripts, speakers and action items — no cloud, no upload, no account needed."
)


def layout(title: str, body: str, description: str | None = None, *,
           head_extra: str = "", wrap: bool = True) -> str:
    """
    One page shell.

    The Open Graph block is not decoration: this URL gets pasted into WhatsApp and Slack, and
    without it the preview is a bare link, which converts far worse than a card. og:image is an
    absolute path because relative ones are ignored by most crawlers — PUBLIC_BASE_URL is what
    makes it absolute, and is the same setting the reset emails need.

    `wrap` and `head_extra` exist for the landing page, which needs the full width of the window
    and its own stylesheet. Everything above the <body> tag is shared regardless: the OG card, the
    icon and the description rules are the same job on every page, and forking the shell to give
    one page a wider column is how two subtly different sets of meta tags start to exist.
    """
    description = description or DEFAULT_DESCRIPTION
    base = mailer.public_base_url("")
    image = f"{base}/static/og.png" if base else "/static/og.png"
    full_title = f"{title} · {PRODUCT_NAME}"
    return (
        "<!doctype html>\n<html lang=\"en\"><head>\n"
        "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        f"<title>{html.escape(full_title)}</title>\n"
        f"<meta name=\"description\" content=\"{html.escape(description)}\">\n"
        "<meta name=\"theme-color\" content=\"#4A56D2\">\n"
        "<link rel=\"icon\" href=\"/static/logo.svg\" type=\"image/svg+xml\">\n"
        f"<meta property=\"og:title\" content=\"{html.escape(full_title)}\">\n"
        f"<meta property=\"og:description\" content=\"{html.escape(description)}\">\n"
        "<meta property=\"og:type\" content=\"website\">\n"
        f"<meta property=\"og:site_name\" content=\"{html.escape(PRODUCT_NAME)}\">\n"
        f"<meta property=\"og:image\" content=\"{html.escape(image)}\">\n"
        "<meta property=\"og:image:width\" content=\"1200\">\n"
        "<meta property=\"og:image:height\" content=\"630\">\n"
        "<meta name=\"twitter:card\" content=\"summary_large_image\">\n"
        f"<style>{CSS}</style>\n"
        f"{head_extra}"
        "</head><body>"
        + (f'<div class="wrap">{body}</div>' if wrap else body)
        + "</body></html>"
    )


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def _page(title: str, body: str, status: int = 200,
          description: str | None = None) -> HTMLResponse:
    return HTMLResponse(layout(title, body, description), status_code=status)


def _date(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%-d %B %Y")


def register_pages(app: FastAPI, store: Store) -> None:
    # Play requires a privacy policy at a public URL, and a subscription sold direct needs terms.
    register_legal(app, layout)

    app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")

    @app.get("/robots.txt", response_class=PlainTextResponse)
    def robots() -> PlainTextResponse:
        # The account pages are forms behind a password and have nothing to index; keeping them
        # out of results also keeps them out of the "sign in to <product>" phishing surface.
        return PlainTextResponse(
            "User-agent: *\n"
            "Allow: /$\n"
            "Allow: /privacy\n"
            "Allow: /terms\n"
            "Disallow: /account\n"
            "Disallow: /signup\n"
            "Disallow: /forgot\n"
            "Disallow: /reset\n"
            "Disallow: /api/\n"
        )

    @app.get("/", response_class=HTMLResponse)
    def home() -> HTMLResponse:
        """
        The landing page, which is the only page here with a job other than "work".

        It renders through the same layout() as the forms so that the OG card, the icon and the
        description stay identical everywhere, but takes the full window rather than the 560px
        column the forms use, and brings its own stylesheet. The markup lives in landing.py.
        """
        return HTMLResponse(
            layout(
                "Meeting notes that never leave your phone",
                landing.body(DEVICE_LIMIT),
                head_extra=(
                    '<link rel="stylesheet" href="/static/landing.css">\n'
                    '<script src="/static/landing.js" defer></script>\n'
                ),
                wrap=False,
            )
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
            # No checkout here. Subscribing happens through Google Play, inside the app, and this
            # page has no way to start it — so it says where to go rather than offering a button
            # that cannot work.
            plan_block = """<p>The summary and written minutes need a subscription. Everything else in
                    the app keeps working without one.</p>
                  <p>Subscribe in the app: open <strong>Settings</strong> and choose
                     <strong>Upgrade</strong>. Billing is handled by Google Play, and the
                     subscription is tied to the Google account that bought it.</p>"""

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
         </div>
         <div class="card">
           <h2 style="margin-top:0">Delete this account</h2>
           <p class="muted">Cancels the subscription and erases the account. Your meetings are on
              your phones and are not touched — nothing here has ever held one.</p>
           <form method="post" action="/account/delete">
             <input type="hidden" name="email" value="{esc(acct.email)}">
             <label for="dp">Confirm your password</label>
             <input id="dp" name="password" type="password" required autocomplete="current-password">
             <button class="secondary" type="submit">Delete my account</button>
           </form>
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
                f"Reset your {PRODUCT_NAME} password",
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

    # ---- deleting an account ----
    #
    # Play requires an app with accounts to offer deletion, and to offer it from the web as well as
    # in the app. It is also just correct: an account somebody cannot get rid of is not theirs.

    @app.post("/account/delete", response_class=HTMLResponse)
    async def delete_account(request: Request) -> HTMLResponse:
        form = await request.form()
        acct = store.authenticate(
            str(form.get("email") or ""), str(form.get("password") or "")
        )
        if acct is None:
            return _signed_out()

        sub = store.subscription(acct.id)
        if sub.provider_id and sub.status in ("active", "past_due"):
            # Deleting our row stops us knowing about a subscription; it does not stop Google
            # charging the card. Being billed monthly for an account you deleted is the worst
            # thing this system could do to somebody, so a failure here stops the deletion rather
            # than being logged and stepped over.
            cancelled, error = cancel_play_subscription(sub.provider_id)
            if not cancelled:
                return _page(
                    "Delete this account",
                    f"""<h1>Could not cancel the subscription</h1>
                 <p class="err">{esc(error or "Unknown error")}</p>
                 <p>Nothing has been deleted. Your account and subscription are exactly as they
                    were — we will not erase the account while the card could still be charged.</p>
                 <p class="muted">Email admin@innocorelabs.com and we will sort it out.</p>
                 <a href="/account">Back to my account</a>""",
                    status=502,
                )

        store.delete_account(acct.id)
        return _page(
            "Account deleted",
            """<h1>Account deleted</h1>
         <p class="ok">The subscription is cancelled and the account is gone. You will not be
            charged again.</p>
         <div class="card">
           <p>Your meetings were never here. They are on your phones, where they were made, and
              nothing about this has touched them — they keep working, minus the written summary.</p>
           <a href="/"><button>Done</button></a>
         </div>""",
        )
