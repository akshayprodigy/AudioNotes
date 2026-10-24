"""
Light/dark theme plumbing shared by every page.

One mechanism: the `data-theme` attribute on <html>. The head script sets it before first paint
(so there is no flash), static/theme.js flips it from the toggle button. Light is the default
whatever the operating system prefers -- that is the founder's call, not an accident.
"""

from __future__ import annotations

#: Runs in <head>, before the body paints. `?theme=dark|light` wins and is remembered, so a link or
#: a headless screenshot can choose; anything else is ignored. Storage can throw (private modes),
#: hence the try/catch -- the page must still come up light.
HEAD_SCRIPT = (
    "<script>(function(){var t='light';try{"
    "var q=new URLSearchParams(location.search).get('theme');"
    "if(q==='dark'||q==='light'){localStorage.setItem('verbale-theme',q);}"
    "var s=localStorage.getItem('verbale-theme');"
    "if(s==='dark'||s==='light'){t=s;}"
    "}catch(e){}"
    "document.documentElement.dataset.theme=t;"
    # Marks "scripts run" so CSS can hide things for an entrance animation only when something
    # will certainly reveal them; with JS off or blocked, content stays visible.
    "document.documentElement.classList.add('js');"
    "var m=document.querySelector('meta[name=theme-color]');"
    "if(m){m.content=t==='dark'?'#0A0C15':'#FAFBFE';}"
    "})();</script>"
)

_SUN = ('<svg class="ic-sun" viewBox="0 0 24 24" width="18" height="18" fill="none" '
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">'
        '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4'
        'M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>')
_MOON = ('<svg class="ic-moon" viewBox="0 0 24 24" width="18" height="18" fill="none" '
         'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
         'aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>')

#: Shown in light (label says what a press will do). theme.js only keeps aria-pressed in sync; the label is static.
TOGGLE = (
    '<button type="button" class="theme-toggle" data-theme-toggle '
    'aria-label="Dark theme" aria-pressed="false">' + _SUN + _MOON + '</button>'
)


def site_header(name: str) -> str:
    """Slim header for the form/legal pages, which have no nav of their own."""
    return (
        '<header class="site-header"><div class="site-header-in">'
        f'<a class="site-brand" href="/"><img src="/static/logo.svg" alt="">{name}</a>'
        '<span class="site-header-spacer"></span><a class="site-link" href="/blog">Blog</a>'
        + TOGGLE + '</div></header>'
    )


THEME_CSS = """
  button.theme-toggle { width:36px; height:36px; margin:0; padding:0; flex:none; display:inline-flex;
          align-items:center; justify-content:center; border-radius:50%; background:transparent;
          color:var(--ink); border:1px solid var(--line); cursor:pointer; }
  button.theme-toggle:hover { border-color:var(--primary); color:var(--primary); }
  button.theme-toggle:focus-visible { outline:2px solid var(--primary); outline-offset:2px; }
  .theme-toggle .ic-moon { display:none; }
  :root[data-theme="dark"] .theme-toggle .ic-sun { display:none; }
  :root[data-theme="dark"] .theme-toggle .ic-moon { display:block; }
  .site-header-in { max-width:560px; margin:0 auto; padding:14px 20px 0; display:flex;
          align-items:center; justify-content:space-between; }
  .site-brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:18px;
          letter-spacing:-.02em; color:var(--ink); text-decoration:none; }
  .site-header-spacer { flex:1; }
  .site-link { color:var(--ink); font-size:15px; font-weight:500; text-decoration:none; margin-right:16px; }
  .site-link:hover { color:var(--primary); }
  .site-brand img { width:28px; height:28px; display:block; }
  .site-header + .wrap { padding-top:24px; }
  .site-foot { border-top:1px solid var(--line); margin-top:56px; padding:32px 0 48px; color:var(--dim);
          font-size:14.5px; }
  .site-foot-in { max-width:1080px; margin:0 auto; padding:0 24px; display:flex; flex-wrap:wrap;
          gap:8px 20px; align-items:center; }
  .wrap .site-foot-in { padding:0; max-width:none; }
  .site-foot-in span { margin-right:auto; }
  .site-foot a { color:var(--dim); text-decoration:none; }
  .site-foot a:hover { color:var(--ink); text-decoration:underline; }
  @media (max-width:600px) { .site-foot-in { padding:0 16px; } .wrap .site-foot-in { padding:0; }
          .site-foot-in span { flex-basis:100%; } }
"""
