import type { Express, Request, Response } from 'express';
import type { Store } from './store.js';
import { DEVICE_LIMIT } from './store.js';
import { isEntitled } from './entitlement.js';

/**
 * The web front end.
 *
 * Server-rendered, because there are four pages and none of them has state worth a client-side
 * framework. It also keeps the whole thing one deployable process: an app that promises no cloud
 * should have as little cloud as possible to run.
 *
 * These pages are the ONLY place a subscription is sold. The Android app never links here — that
 * is what keeps the arrangement inside store policy — so this has to stand on its own for
 * somebody arriving from an email or a browser bookmark.
 */

const css = `
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
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · AudioNotes</title><style>${css}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function pages(app: Express, store: Store): void {
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(
      layout(
        'Meeting notes that never leave your phone',
        `<h1>AudioNotes</h1>
         <p>Records a meeting, writes the minutes, and does all of it on your phone. No recording,
            no transcript and no summary is ever uploaded — there is no server here that could
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
             <li>Up to ${DEVICE_LIMIT} devices on one subscription</li>
           </ul>
           <p class="muted">Your notes stay yours if you stop paying — every summary already
              written stays readable, and you can export everything at any time.</p>
           <a href="/signup"><button>Create an account</button></a>
           <p class="muted" style="text-align:center;margin-top:14px">
             Already have one? <a href="/account">Sign in</a>
           </p>
         </div>`,
      ),
    );
  });

  app.get('/signup', (_req, res) => {
    res.type('html').send(
      layout(
        'Create an account',
        `<h1>Create an account</h1>
         <p>Only an email and a password. We never ask for anything about your meetings, because
            we have nowhere to put it.</p>
         <form class="card" method="post" action="/signup">
           <label for="email">Email</label>
           <input id="email" name="email" type="email" required autocomplete="email">
           <label for="password">Password</label>
           <input id="password" name="password" type="password" required minlength="8"
                  autocomplete="new-password">
           <button type="submit">Create account</button>
         </form>`,
      ),
    );
  });

  app.post('/signup', (req, res) => {
    const email = String(req.body?.email ?? '');
    const password = String(req.body?.password ?? '');
    if (!email.includes('@') || password.length < 8) {
      return res
        .status(400)
        .type('html')
        .send(layout('Create an account', `<h1>Check that again</h1>
          <p class="err">A valid email and a password of at least 8 characters are required.</p>
          <a href="/signup">Back</a>`));
    }
    if (store.accountByEmail(email)) {
      return res.status(409).type('html').send(layout('Create an account', `<h1>Already registered</h1>
        <p>That email already has an account. <a href="/account">Sign in</a> instead.</p>`));
    }
    store.createAccount(email, password);
    res.type('html').send(
      layout(
        'Account created',
        `<h1>Account created</h1>
         <p class="ok">You can sign in on your phone now — Settings, then Subscription.</p>
         <div class="card">
           <p>To use Pro, add a subscription from your account page.</p>
           <a href="/account"><button>Go to my account</button></a>
         </div>`,
      ),
    );
  });

  /**
   * The account page.
   *
   * Password on the form rather than a session cookie: there are two actions here and no
   * long-lived browsing to protect. A session would mean cookie handling, CSRF and expiry —
   * complexity that buys nothing on a page you visit twice a year.
   */
  app.get('/account', (_req, res) => {
    res.type('html').send(
      layout(
        'Your account',
        `<h1>Your account</h1>
         <form class="card" method="post" action="/account">
           <label for="email">Email</label>
           <input id="email" name="email" type="email" required autocomplete="email">
           <label for="password">Password</label>
           <input id="password" name="password" type="password" required autocomplete="current-password">
           <button type="submit">Sign in</button>
         </form>
         <p class="muted">No account? <a href="/signup">Create one</a>.</p>`,
      ),
    );
  });

  app.post('/account', (req, res) => {
    const email = String(req.body?.email ?? '');
    const password = String(req.body?.password ?? '');
    const account = store.authenticate(email, password);
    if (!account) {
      return res.status(401).type('html').send(
        layout('Your account', `<h1>Sign in</h1>
          <p class="err">Email or password is incorrect.</p><a href="/account">Try again</a>`),
      );
    }

    const sub = store.subscription(account.id);
    const now = Math.floor(Date.now() / 1000);
    const active = isEntitled(sub, now);
    const devices = store.devices(account.id);
    const renews = sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd * 1000).toLocaleDateString('en-IN', {
          day: 'numeric', month: 'long', year: 'numeric',
        })
      : null;

    res.type('html').send(
      layout(
        'Your account',
        `<h1>${esc(account.email)}</h1>
         <div class="card">
           <h2 style="margin-top:0">${active ? 'Pro' : 'Free'}</h2>
           ${
             active
               ? `<p>${sub.status === 'cancelled'
                   ? `Cancelled — Pro continues until ${renews}.`
                   : `Renews ${renews}.`}</p>`
               : `<p>The summary and written minutes need a subscription. Everything else in the
                    app keeps working without one.</p>
                  <form method="post" action="/subscribe">
                    <input type="hidden" name="email" value="${esc(account.email)}">
                    <label for="p">Confirm your password</label>
                    <input id="p" name="password" type="password" required autocomplete="current-password">
                    <button type="submit">Subscribe</button>
                  </form>`
           }
         </div>
         <div class="card">
           <h2 style="margin-top:0">Devices</h2>
           <p class="muted">${devices.length} of ${DEVICE_LIMIT} in use.</p>
           ${
             devices.length
               ? `<ul>${devices
                   .map(
                     d =>
                       `<li>${esc(d.deviceId.slice(0, 8))}… — last seen ${new Date(
                         d.lastSeen * 1000,
                       ).toLocaleDateString('en-IN')}</li>`,
                   )
                   .join('')}</ul>`
               : '<p class="muted">No devices yet. Sign in from the app to add one.</p>'
           }
         </div>`,
      ),
    );
  });

  /** Kick off Razorpay checkout from the account page. */
  app.post('/subscribe', async (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    try {
      const r = await fetch(`${base}/api/billing/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: req.body?.email, password: req.body?.password }),
      });
      const data = (await r.json()) as { checkoutUrl?: string; error?: string };
      if (!r.ok || !data.checkoutUrl) {
        return res.status(r.status).type('html').send(
          layout('Subscribe', `<h1>Could not start the subscription</h1>
            <p class="err">${esc(data.error ?? 'Unknown error')}</p>
            <a href="/account">Back to my account</a>`),
        );
      }
      res.redirect(data.checkoutUrl);
    } catch (e) {
      res.status(502).type('html').send(
        layout('Subscribe', `<h1>Could not reach the payment provider</h1>
          <p class="err">${esc(e instanceof Error ? e.message : 'Unknown error')}</p>
          <a href="/account">Back</a>`),
      );
    }
  });
}
