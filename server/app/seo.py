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

#: The production origin. Canonical URLs must be absolute and must not depend on the Host header
#: of whoever asked, so this is the fallback when PUBLIC_BASE_URL is unset (as in tests and dev).
DEFAULT_SITE_URL = "https://verbale.innocorelabs.com"


def site_url() -> str:
    """The absolute origin of the site, without a trailing slash."""
    return (os.environ.get("PUBLIC_BASE_URL") or DEFAULT_SITE_URL).rstrip("/")


def absolute(path: str) -> str:
    return site_url() + path


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
AI_BOTS = [
    "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot",
    "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot",
    "Bingbot",
]


def robots_txt() -> str:
    rules = "Allow: /\nDisallow: /admin\nDisallow: /api/\n"
    # The marketing site is meant to be found and quoted, by search engines and by AI assistants
    # answering "what app records meetings on-device". Say so explicitly rather than leaving it to
    # each crawler's default. Only the admin console and the API are kept out.
    groups = "".join(f"User-agent: {bot}\n{rules}\n" for bot in AI_BOTS)
    return f"User-agent: *\n{rules}\n{groups}Sitemap: {absolute('/sitemap.xml')}\n"


@dataclass(frozen=True)
class SitemapEntry:
    path: str
    lastmod: str | None = None  # YYYY-MM-DD


_STATIC_PAGES = ["/", "/privacy", "/terms", "/delete-account"]
_providers: list[Callable[[], list[SitemapEntry]]] = []


def register_sitemap_entries(provider: Callable[[], list[SitemapEntry]]) -> None:
    """Add a source of sitemap entries (e.g. the blog's posts). Called when building the sitemap."""
    _providers.append(provider)


def sitemap_entries() -> list[SitemapEntry]:
    entries = [SitemapEntry(p) for p in _STATIC_PAGES]
    for provider in _providers:
        entries.extend(provider())
    return entries


def sitemap_xml() -> str:
    rows = ""
    for e in sitemap_entries():
        lastmod = f"<lastmod>{html.escape(e.lastmod)}</lastmod>" if e.lastmod else ""
        rows += f"<url><loc>{html.escape(absolute(e.path))}</loc>{lastmod}</url>\n"
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"{rows}</urlset>\n")
