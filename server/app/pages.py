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
from datetime import datetime, timezone

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import mailer
from . import landing
from .branding import CONTACT_EMAIL, PRODUCT_NAME
from .legal import register_legal
from .store import DEVICE_LIMIT, Store

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
        # There is nothing to sign in to on this site, so the only thing worth keeping out of
        # search results is the admin console — which answers 404 to anyone who is not signed in,
        # but should not be advertised in a search index either.
        return PlainTextResponse(
            "User-agent: *\n"
            "Allow: /$\n"
            "Allow: /privacy\n"
            "Allow: /terms\n"
            "Allow: /delete-account\n"
            "Disallow: /admin\n"
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

    @app.get("/delete-account", response_class=HTMLResponse)
    def delete_account() -> HTMLResponse:
        """
        How to have an account deleted, at a URL that works without the app installed.

        Play requires a way to request deletion that is reachable from outside the app, and this is
        it. It is a page of instructions rather than a form because there is nothing here to
        authenticate against: an account is created by a Play purchase and has no password, so a
        self-service web form could only ever be a way for a stranger to delete somebody else's
        subscription by typing their address.
        """
        return _page(
            "Delete your account",
            f"""<h1>Delete your account</h1>
             <p>{esc(PRODUCT_NAME)} keeps your recordings, transcripts and notes on your phone. We
                never receive them, so there is nothing of yours on our servers to delete except
                the record that a subscription exists.</p>
             <p>To have that removed, email
                <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a> from the address you used, or
                with your Google Play order number. We will confirm within seven days.</p>
             <p>Uninstalling the app removes everything it held on the device. Cancelling the
                subscription itself is done in Google Play, under Subscriptions.</p>
             <p><a href="/">Back</a></p>""",
        )
