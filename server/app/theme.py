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
    "if(q==='dark'||q==='light'){localStorage.setItem('theme',q);}"
    "var s=localStorage.getItem('theme');"
    "if(s==='dark'||s==='light'){t=s;}"
    "}catch(e){}"
    "document.documentElement.dataset.theme=t;"
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

#: Shown in light (label says what a press will do). theme.js rewrites label and aria-pressed.
TOGGLE = (
    '<button type="button" class="theme-toggle" data-theme-toggle '
    'aria-label="Switch to dark theme" aria-pressed="false">' + _SUN + _MOON + '</button>'
)


def site_header(name: str) -> str:
    """Slim header for the form/legal pages, which have no nav of their own."""
    return (
        '<header class="site-header"><div class="site-header-in">'
        f'<a class="site-brand" href="/"><img src="/static/logo.svg" alt="">{name}</a>'
        + TOGGLE + '</div></header>'
    )
