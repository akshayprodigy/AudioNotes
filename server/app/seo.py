"""
What search engines and AI assistants read: the site's address, structured data, robots, sitemap.

Kept apart from pages.py because none of it is markup a person sees, and because the sitemap is a
registry other modules add to (the blog registers its posts) -- a place for that to live that is
not the page shell.
"""

from __future__ import annotations

import html
import json
import os
from dataclasses import dataclass
from typing import Callable
from urllib.parse import quote

from fastapi import FastAPI

#: The production origin. Canonical URLs must be absolute and must not depend on the Host header
#: of whoever asked, so this is the fallback when PUBLIC_BASE_URL is unset (as in tests and dev).
DEFAULT_SITE_URL = "https://verbale.innocorelabs.com"


def site_url() -> str:
    """
    The absolute origin of the site, without a trailing slash.

    Deliberately not `mailer.public_base_url`: that one has no fallback, because a reset email
    must never carry a guessed origin. Canonical and Open Graph URLs are the opposite case -- a
    wrong-but-stable production origin is better than a relative or missing one -- so this falls
    back to the production site.
    """
    return (os.environ.get("PUBLIC_BASE_URL") or DEFAULT_SITE_URL).rstrip("/")


def absolute(path: str) -> str:
    """An absolute URL for a site path; the path is percent-encoded (`/` kept) so it is URL-safe."""
    return site_url() + quote(path, safe="/")


def jsonld_script(data: dict) -> str:
    """
    One JSON-LD <script> block.

    `<`, `>` and `&` are written as \\u escapes so that text in the data (a blog title, say)
    containing `</script>` cannot close the block early. The escapes are valid JSON, so parsers
    read back exactly what was put in.
    """
    body = (json.dumps(data, ensure_ascii=False)
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))
    return f'<script type="application/ld+json">{body}</script>\n'


#: Crawlers that get an explicit group. A named group overrides `*` entirely, so each repeats the
#: disallows -- otherwise naming a bot here would quietly let it into /admin and /api/.
NAMED_CRAWLERS = [
    "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot",
    "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot",
    "Bingbot",
]


def robots_txt() -> str:
    """robots.txt: the `*` group, one explicit group per named crawler, and the sitemap line."""
    rules = "Allow: /\nDisallow: /admin\nDisallow: /api/\n"
    # The marketing site is meant to be found and quoted, by search engines and by AI assistants
    # answering "what app records meetings on-device". Say so explicitly rather than leaving it to
    # each crawler's default. Only the admin console and the API are kept out.
    groups = "".join(f"User-agent: {bot}\n{rules}\n" for bot in NAMED_CRAWLERS)
    return f"User-agent: *\n{rules}\n{groups}Sitemap: {absolute('/sitemap.xml')}\n"


@dataclass(frozen=True)
class SitemapEntry:
    path: str
    lastmod: str | None = None  # YYYY-MM-DD
    #: Site paths of images that belong on this page (Google's image sitemap extension).
    images: tuple[str, ...] = ()


_STATIC_PAGES = ["/", "/privacy", "/terms", "/delete-account"]
SitemapProvider = Callable[[], list[SitemapEntry]]


def register_sitemap_entries(app: FastAPI, provider: SitemapProvider) -> None:
    """
    Add a source of sitemap entries (e.g. the blog's posts) to this app.

    Held on the app rather than in a module global so that building several apps in one process
    (every test does) cannot pile up duplicate entries.
    """
    app.state.sitemap_providers.append(provider)


def sitemap_entries(providers: list[SitemapProvider] | None = None) -> list[SitemapEntry]:
    entries = [SitemapEntry(p) for p in _STATIC_PAGES]
    for provider in providers or []:
        entries.extend(provider())
    # A page may be listed twice (the home page is a static entry that the landing module adds
    # its images to). Merge rather than emit two <url> rows for one address, which crawlers flag.
    merged: dict[str, SitemapEntry] = {}
    for e in entries:
        prior = merged.get(e.path)
        if prior is None:
            merged[e.path] = e
        else:
            images = prior.images + tuple(i for i in e.images if i not in prior.images)
            merged[e.path] = SitemapEntry(e.path, prior.lastmod or e.lastmod, images)
    return list(merged.values())


def sitemap_xml(providers: list[SitemapProvider] | None = None) -> str:
    rows = ""
    for e in sitemap_entries(providers):
        lastmod = f"<lastmod>{html.escape(e.lastmod)}</lastmod>" if e.lastmod else ""
        # Only <image:loc>: Google stopped reading image:caption and image:title.
        images = "".join(
            f"<image:image><image:loc>{html.escape(absolute(i))}</image:loc></image:image>"
            for i in e.images)
        rows += f"<url><loc>{html.escape(absolute(e.path))}</loc>{lastmod}{images}</url>\n"
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
            'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n'
            f"{rows}</urlset>\n")
