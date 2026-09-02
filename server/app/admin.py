"""
The admin console: who has subscribed.

Read-only, deliberately and completely. Nothing here writes to `subscriptions`, because a route
that can mark an account paid is reachable — by a session bug, a borrowed laptop, a cookie left on
a shared machine — and the rule the whole billing design rests on is that only a purchase Google
has verified may grant entitlement. Seeding a test account stays `deploy/seed-test-account.sh`:
something a person runs on purpose, over ssh, with a comment explaining why it is the exception.

When the console is not configured, every route here answers **404**, including the sign-in page.
Not 403: a disabled console should not tell a stranger that there is a console.
"""

from __future__ import annotations

import csv
import io
import time

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse

from . import admin_auth
from .pages import _date, _page, esc
from .store import AdminRow, Store

COOKIE_NAME = "verbale_admin"

#: Rate limit on sign-in, per IP. nginx limits the public auth routes; this is the same idea for a
#: route nginx does not know about, and it costs one dict.
_ATTEMPTS: dict[str, list[float]] = {}
_MAX_ATTEMPTS = 8
_WINDOW_SECONDS = 300

STATUSES = ("active", "past_due", "cancelled", "none")


def _rate_limited(ip: str, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    recent = [t for t in _ATTEMPTS.get(ip, []) if now - t < _WINDOW_SECONDS]
    _ATTEMPTS[ip] = recent
    return len(recent) >= _MAX_ATTEMPTS


def _note_attempt(ip: str, now: float | None = None) -> None:
    _ATTEMPTS.setdefault(ip, []).append(time.time() if now is None else now)


def _client_ip(request: Request) -> str:
    # X-Forwarded-For is set by our own nginx; the left-most entry is the client.
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _signed_in(request: Request) -> str | None:
    return admin_auth.read_cookie(request.cookies.get(COOKIE_NAME))


def _status_pill(status: str) -> str:
    colour = {"active": "#0a7d33", "past_due": "#a56200", "cancelled": "#8a8a8a"}.get(
        status, "#8a8a8a"
    )
    return (
        f'<span style="color:{colour};font-weight:600">{esc(status.replace("_", " "))}</span>'
    )


def _row_html(row: AdminRow) -> str:
    renews = _date(row.current_period_end) if row.current_period_end else "&mdash;"
    seen = _date(row.last_seen) if row.last_seen else "&mdash;"
    # An account created by a Play purchase has no email. Saying so is more useful than a blank.
    email = esc(row.email) if row.email else '<span class="muted">no email (Play)</span>'
    return f"""<tr>
      <td><a href="/admin/accounts/{esc(row.account_id)}">{email}</a></td>
      <td>{_date(row.created_at)}</td>
      <td>{_status_pill(row.status)}</td>
      <td>{esc(row.plan)}</td>
      <td>{renews}</td>
      <td style="text-align:center">{row.device_count}</td>
      <td>{seen}</td>
    </tr>"""


TABLE_CSS = """
<style>
  table.admin { width:100%; border-collapse:collapse; margin-top:18px; font-size:14px }
  table.admin th, table.admin td { padding:9px 8px; border-bottom:1px solid #e5e5e5;
                                   text-align:left; vertical-align:top }
  table.admin th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:#666 }
  .cards { display:flex; flex-wrap:wrap; gap:12px; margin:18px 0 }
  .card { flex:1 1 120px; border:1px solid #e5e5e5; border-radius:8px; padding:12px 14px }
  .card .n { font-size:26px; font-weight:700; line-height:1.1 }
  .card .l { font-size:12px; color:#666; text-transform:uppercase; letter-spacing:.04em }
  .filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:16px }
  .admin-bar { display:flex; justify-content:space-between; align-items:center; gap:12px }
</style>
"""


def register_admin(app: FastAPI, store: Store) -> None:
    """
    Mount the console.

    Registered unconditionally so that turning the console on is a restart with two environment
    variables rather than a different build — but every handler re-checks `enabled()`, so a server
    without them serves 404s from these paths.
    """

    def _guard() -> HTMLResponse | None:
        """404 unless the console is configured. Returned, not raised, so callers stay flat."""
        if not admin_auth.enabled():
            return _page("Not found", "<h1>Not found</h1>", status=404)
        return None

    def _require(request: Request) -> tuple[str | None, HTMLResponse | RedirectResponse | None]:
        off = _guard()
        if off is not None:
            return None, off
        email = _signed_in(request)
        if email is None:
            return None, RedirectResponse("/admin/signin", status_code=303)
        return email, None

    # ---- signing in ----

    @app.get("/admin/signin", response_class=HTMLResponse)
    def admin_signin_form(request: Request):
        off = _guard()
        if off is not None:
            return off
        if _signed_in(request):
            return RedirectResponse("/admin", status_code=303)
        return _page(
            "Admin",
            """<h1>Admin</h1>
             <form method="post" action="/admin/signin">
               <label for="e">Email</label>
               <input id="e" name="email" type="email" required autocomplete="username">
               <label for="p">Password</label>
               <input id="p" name="password" type="password" required
                      autocomplete="current-password">
               <button type="submit">Sign in</button>
             </form>""",
        )

    @app.post("/admin/signin", response_class=HTMLResponse)
    async def admin_signin(request: Request):
        off = _guard()
        if off is not None:
            return off

        ip = _client_ip(request)
        if _rate_limited(ip):
            return _page(
                "Admin",
                """<h1>Too many attempts</h1>
                 <p class="err">Wait a few minutes and try again.</p>""",
                status=429,
            )

        form = await request.form()
        email = str(form.get("email") or "")
        account = store.authenticate(email, str(form.get("password") or ""))

        # One message whether the password was wrong or the account simply is not an admin.
        # Telling them apart turns this form into a way to discover who the operators are.
        if account is None or not admin_auth.is_admin(account.email):
            _note_attempt(ip)
            return _page(
                "Admin",
                """<h1>Admin</h1>
                 <p class="err">Email or password is incorrect.</p>
                 <p><a href="/admin/signin">Try again</a></p>""",
                status=401,
            )

        response = RedirectResponse("/admin", status_code=303)
        response.set_cookie(
            COOKIE_NAME,
            admin_auth.make_cookie(account.email or email),
            max_age=admin_auth.SESSION_SECONDS,
            httponly=True,
            secure=True,
            samesite="strict",
            path="/admin",
        )
        return response

    @app.post("/admin/signout")
    def admin_signout(request: Request):
        off = _guard()
        if off is not None:
            return off
        response = RedirectResponse("/admin/signin", status_code=303)
        response.delete_cookie(COOKIE_NAME, path="/admin")
        return response

    # ---- the console ----

    @app.get("/admin", response_class=HTMLResponse)
    def admin_overview(request: Request):
        email, stop = _require(request)
        if stop is not None:
            return stop

        c = store.admin_overview()
        cards = "".join(
            f'<div class="card"><div class="n">{c[key]}</div><div class="l">{label}</div></div>'
            for key, label in (
                ("accounts", "accounts"),
                ("active", "active"),
                ("past_due", "past due"),
                ("cancelled", "cancelled"),
                ("never_subscribed", "never subscribed"),
                ("new_7d", "new this week"),
                ("new_30d", "new this month"),
            )
        )
        return _page(
            "Admin",
            f"""{TABLE_CSS}
             <div class="admin-bar">
               <h1>Admin</h1>
               <form method="post" action="/admin/signout"><button type="submit">Sign out</button></form>
             </div>
             <p class="muted">Signed in as {esc(email or "")}.</p>
             <div class="cards">{cards}</div>
             <p><a href="/admin/accounts">All accounts &rarr;</a></p>
             <p class="muted">Trials are not counted here: the free trial runs entirely on the
                device and never contacts this server. Revenue lives in Play Console.</p>""",
        )

    @app.get("/admin/accounts", response_class=HTMLResponse)
    def admin_accounts(request: Request, status: str = "", q: str = "", page: int = 1):
        email, stop = _require(request)
        if stop is not None:
            return stop

        status = status if status in STATUSES else ""
        page = max(1, page)
        per_page = 50
        rows = store.admin_accounts(status=status or None, search=q or None,
                                    limit=per_page, offset=(page - 1) * per_page)
        total = store.admin_account_count(status=status or None, search=q or None)

        options = "".join(
            f'<option value="{s}"{" selected" if status == s else ""}>{s.replace("_", " ")}</option>'
            for s in ("",) + STATUSES
        )
        # The query string is rebuilt rather than passed through, so a crafted parameter cannot
        # ride along into the next page's links.
        carry = f"status={esc(status)}&q={esc(q)}"
        prev_link = (f'<a href="/admin/accounts?{carry}&page={page - 1}">&larr; previous</a>'
                     if page > 1 else "")
        next_link = (f'<a href="/admin/accounts?{carry}&page={page + 1}">next &rarr;</a>'
                     if page * per_page < total else "")

        body = "".join(_row_html(r) for r in rows) or (
            '<tr><td colspan="7" class="muted">Nothing matches.</td></tr>'
        )
        return _page(
            "Accounts",
            f"""{TABLE_CSS}
             <div class="admin-bar">
               <h1>Accounts</h1>
               <a href="/admin">&larr; overview</a>
             </div>
             <form class="filters" method="get" action="/admin/accounts">
               <input name="q" value="{esc(q)}" placeholder="search email" style="flex:1">
               <select name="status">{options}</select>
               <button type="submit">Filter</button>
               <a href="/admin/accounts.csv?{carry}">CSV</a>
             </form>
             <p class="muted">{total} account{"" if total == 1 else "s"}.</p>
             <table class="admin">
               <tr><th>Email</th><th>Signed up</th><th>Status</th><th>Plan</th>
                   <th>Renews</th><th>Devices</th><th>Last seen</th></tr>
               {body}
             </table>
             <p class="filters">{prev_link} {next_link}</p>""",
        )

    @app.get("/admin/accounts.csv")
    def admin_accounts_csv(request: Request, status: str = "", q: str = ""):
        email, stop = _require(request)
        if stop is not None:
            return stop

        status = status if status in STATUSES else ""
        rows = store.admin_accounts(status=status or None, search=q or None, limit=500)

        buffer = io.StringIO()
        writer = csv.writer(buffer, quoting=csv.QUOTE_ALL)
        writer.writerow(["account_id", "email", "signed_up", "plan", "status", "provider",
                         "period_end", "devices", "last_seen"])
        for r in rows:
            writer.writerow([r.account_id, r.email or "", r.created_at, r.plan, r.status,
                             r.provider, r.current_period_end, r.device_count, r.last_seen])
        buffer.seek(0)
        return StreamingResponse(
            buffer,
            media_type="text/csv",
            headers={"content-disposition": 'attachment; filename="verbale-accounts.csv"'},
        )

    @app.get("/admin/accounts/{account_id}", response_class=HTMLResponse)
    def admin_account(request: Request, account_id: str):
        email, stop = _require(request)
        if stop is not None:
            return stop

        row = store.admin_account(account_id)
        if row is None:
            return _page("Account", "<h1>No such account</h1>"
                                    '<p><a href="/admin/accounts">Back</a></p>', status=404)

        devices = "".join(
            f"<tr><td>{esc(d.device_id)}</td><td>{_date(d.first_seen)}</td>"
            f"<td>{_date(d.last_seen)}</td></tr>"
            for d in store.devices(account_id)
        ) or '<tr><td colspan="3" class="muted">No devices.</td></tr>'

        return _page(
            "Account",
            f"""{TABLE_CSS}
             <div class="admin-bar">
               <h1>{esc(row.email) if row.email else "Account with no email"}</h1>
               <a href="/admin/accounts">&larr; accounts</a>
             </div>
             <table class="admin">
               <tr><th>Account id</th><td>{esc(row.account_id)}</td></tr>
               <tr><th>Signed up</th><td>{_date(row.created_at)}</td></tr>
               <tr><th>Status</th><td>{_status_pill(row.status)}</td></tr>
               <tr><th>Plan</th><td>{esc(row.plan)}</td></tr>
               <tr><th>Provider</th><td>{esc(row.provider) or "&mdash;"}</td></tr>
               <tr><th>Period ends</th>
                   <td>{_date(row.current_period_end) if row.current_period_end else "&mdash;"}</td></tr>
             </table>
             <h2>Devices</h2>
             <table class="admin">
               <tr><th>Device</th><th>First seen</th><th>Last seen</th></tr>
               {devices}
             </table>""",
        )
