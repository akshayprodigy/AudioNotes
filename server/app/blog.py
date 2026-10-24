"""
The blog: markdown files in, server-rendered pages, a feed and structured data out.

Posts are plain files in app/content/blog/ rather than rows in the database, so a post is written,
reviewed and deployed like code, and the repository is the single source of truth. Everything is
parsed and rendered ONCE at startup and held in memory: a malformed post stops the server from
booting (naming the file) instead of surfacing as a 500 to the first reader, and a request never
touches the disk or the markdown library.

Other modules (the sitemap, a future llms.txt) read posts through `Blog.posts()` / `Blog.get()`,
and `Post.raw` is the file as written, which is what the `.md` route and llms.txt serve.

Posts dated in the future are shown like any other: there is no scheduler here, so hiding them would
need a second source of "now" in every test and a deploy to publish. Set the date you want live.
"""

from __future__ import annotations

import html
import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from typing import Callable

import markdown
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, Response

from . import landing, seo
from .branding import PRODUCT_NAME
from .theme import site_header

DEFAULT_DIR = Path(__file__).parent / "content" / "blog"

SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_DESCRIPTION = 160
WORDS_PER_MINUTE = 220
RELATED_COUNT = 3

#: Cover images are produced as `<cover>.webp` (1600x900, shown on the page) and `<cover>-og.png`
#: (1200x630, what link previews fetch). Fixed sizes let the <img> carry width/height, which stops
#: the page jumping when the image arrives.
COVER_W, COVER_H = 1600, 900

BLOG_TITLE = f"The {PRODUCT_NAME} blog"
BLOG_INTRO = "Notes on meetings, minutes and keeping your recordings on your own phone."
BLOG_DESCRIPTION = (
    f"Practical writing on meeting notes, action items and private, on-device transcription "
    f"from the team behind {PRODUCT_NAME}."
)

_IMG_TAG = re.compile(r"<img\b([^>]*?)(/?)>", re.I)
_TABLE = re.compile(r"(<table\b.*?</table>)", re.I | re.S)


class BlogError(ValueError):
    """A post that cannot be loaded. The message always starts with the file name."""


@dataclass(frozen=True)
class Post:
    slug: str
    title: str
    description: str
    date: str                      # YYYY-MM-DD
    updated: str | None
    tags: list[str]
    cover: str | None
    cover_alt: str
    shot: str | None               # read by the image generator, not by any page
    raw: str                       # the file exactly as written, front matter included
    body: str                      # the markdown after the front matter, split at load
    html: str                      # rendered body
    minutes: int
    toc: list[tuple[str, str]] = field(default_factory=list)  # (id, text) of each h2

    @property
    def modified(self) -> str:
        return self.updated or self.date

    @property
    def path(self) -> str:
        return f"/blog/{self.slug}"

    @property
    def cover_webp(self) -> str | None:
        return f"/static/blog/{self.cover}.webp" if self.cover else None

    @property
    def og_image(self) -> str | None:
        return seo.absolute(f"/static/blog/{self.cover}-og.png") if self.cover else None


def reading_minutes(text: str) -> int:
    """Whole minutes at 220 words a minute, never less than one -- "0 min read" reads as a bug."""
    return max(1, math.ceil(len(text.split()) / WORDS_PER_MINUTE))


def _unquote(value: str) -> str:
    """Drop one matching pair of surrounding quotes, as authors write `title: "A: B"` out of habit."""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _split_front_matter(raw: str, name: str) -> tuple[dict[str, str], str]:
    """
    Parse the block between the leading `---` lines as simple `key: value` lines.

    Hand-rolled on purpose: the format is six flat fields, and a YAML dependency would add a
    parser (and its edge cases) to a server that otherwise ships four packages.
    """
    lines = raw.lstrip("﻿").splitlines()
    if not lines or lines[0].strip() != "---":
        raise BlogError(f"{name}: must start with a '---' front-matter block")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        raise BlogError(f"{name}: front-matter block is never closed with '---'") from None
    meta: dict[str, str] = {}
    for n, line in enumerate(lines[1:end], start=2):
        if not line.strip():
            continue
        key, sep, value = line.partition(":")
        if not sep or not key.strip():
            raise BlogError(f"{name}: line {n} of the front matter is not 'key: value'")
        meta[key.strip().lower()] = _unquote(value.strip())
    return meta, "\n".join(lines[end + 1:]).strip() + "\n"


def _check_date(value: str, label: str, name: str) -> str:
    if not DATE_RE.match(value):
        raise BlogError(f"{name}: {label} must be YYYY-MM-DD, got {value!r}")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise BlogError(f"{name}: {label} {value!r} is not a real date") from None
    return value


def _lazy_images(rendered: str) -> str:
    """
    Add loading=lazy and decoding=async to every <img> that does not already say otherwise.

    Regex, not an HTML parser: it assumes markdown-generated markup, where an <img> is a single
    tag with escaped attribute values (so no `>` inside an attribute, as raw HTML could write).
    """
    def patch(m: re.Match) -> str:
        attrs, slash = m.group(1), m.group(2)
        for attr, val in (("loading", "lazy"), ("decoding", "async")):
            if not re.search(rf"\s{attr}\s*=", attrs, re.I):
                attrs += f' {attr}="{val}"'
        return f"<img{attrs}{slash}>"
    return _IMG_TAG.sub(patch, rendered)


def _wrap_tables(rendered: str) -> str:
    """
    Wrap each <table> in a scroll container.

    A table cannot scroll itself without shrinking to its content, so the wrapper carries the
    overflow, border and radius: a table that fits stays full width, a wide one scrolls inside
    the column instead of being clipped by the page.

    Regex, so it assumes markdown-generated markup: tables are never nested (raw HTML with a table
    inside a table would be wrapped wrongly).
    """
    return _TABLE.sub(r'<div class="table-wrap">\1</div>', rendered)


def _h2s(tokens: list[dict]) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for t in tokens:
        if t["level"] == 2:
            found.append((t["id"], t["name"]))
        found.extend(_h2s(t.get("children", [])))
    return found


def _load(path: Path) -> Post:
    name, slug = path.name, path.stem
    if not SLUG_RE.match(slug):
        raise BlogError(f"{name}: file name must be a lowercase slug like 'my-first-post' "
                        "(letters, digits, single hyphens)")
    raw = path.read_text(encoding="utf-8").lstrip("\ufeff")
    meta, body = _split_front_matter(raw, name)
    for key in ("title", "description", "date"):
        if not meta.get(key):
            raise BlogError(f"{name}: missing required front-matter field '{key}'")
    if len(meta["description"]) > MAX_DESCRIPTION:
        raise BlogError(f"{name}: description is {len(meta['description'])} characters; "
                        f"the limit is {MAX_DESCRIPTION}")
    published = _check_date(meta["date"], "date", name)
    updated = _check_date(meta["updated"], "updated", name) if meta.get("updated") else None
    md = markdown.Markdown(
        extensions=["extra", "toc", "sane_lists"],
        extension_configs={"toc": {"permalink": False, "toc_depth": "2-3"}},
    )
    rendered = _wrap_tables(_lazy_images(md.convert(body)))
    return Post(
        slug=slug, title=meta["title"], description=meta["description"], date=published,
        updated=updated,
        tags=[t.strip() for t in meta.get("tags", "").split(",") if t.strip()],
        cover=meta.get("cover") or None, cover_alt=meta.get("cover_alt", ""),
        shot=meta.get("shot") or None, raw=raw, body=body, html=rendered,
        minutes=reading_minutes(body), toc=_h2s(md.toc_tokens),
    )


def load_posts(directory: Path) -> list[Post]:
    """Every post in `directory`, newest first (ties broken by slug so the order is stable)."""
    directory = Path(directory)
    posts = [_load(p) for p in sorted(directory.glob("*.md"))] if directory.is_dir() else []
    return sorted(posts, key=lambda p: (p.date, p.slug), reverse=True)


class Blog:
    """The loaded set of posts; the one object other modules need."""

    def __init__(self, directory: Path | str = DEFAULT_DIR) -> None:
        self._posts = load_posts(Path(directory))
        self._by_slug = {p.slug: p for p in self._posts}

    def posts(self) -> list[Post]:
        return list(self._posts)

    def get(self, slug: str) -> Post | None:
        return self._by_slug.get(slug)

    def related(self, post: Post) -> list[Post]:
        """Posts sharing the most tags with `post`, topped up with the newest if too few share any."""
        others = [p for p in self._posts if p.slug != post.slug]
        shared = [(len(set(p.tags) & set(post.tags)), p) for p in others]
        picked = [p for n, p in sorted(shared, key=lambda x: -x[0]) if n > 0]  # stable: newest first
        chosen = {p.slug for p in picked}
        picked += [p for p in others if p.slug not in chosen]
        return picked[:RELATED_COUNT]


# ---- markup ----

def _pretty_date(iso: str) -> str:
    return date.fromisoformat(iso).strftime("%-d %B %Y")


def _head_links(extra: str = "") -> str:
    return (
        '<link rel="stylesheet" href="/static/blog.css">\n'
        f'<link rel="alternate" type="application/rss+xml" title="{html.escape(BLOG_TITLE)}" '
        'href="/blog/feed.xml">\n' + extra
    )


def _card(post: Post) -> str:
    """A post card. The cover's alt is empty: the title beside it already says what the post is."""
    media = (
        f'<img src="{html.escape(post.cover_webp)}" alt="" width="{COVER_W}" height="{COVER_H}" '
        'loading="lazy" decoding="async">' if post.cover else ""
    )
    tag = f'<span class="tag">{html.escape(post.tags[0])}</span>' if post.tags else ""
    return (
        f'<a class="post-card" href="{html.escape(post.path)}">'
        f'<span class="post-card-media">{media}</span>'
        f'<span class="post-card-body">{tag}'
        f'<span class="post-card-title">{html.escape(post.title)}</span>'
        f'<span class="post-card-desc">{html.escape(post.description)}</span>'
        f'<span class="post-card-meta">{_pretty_date(post.date)} &middot; {post.minutes} min read</span>'
        '</span></a>'
    )


def breadcrumb(trail: list[tuple[str, str | None]]) -> str:
    items = []
    for label, href in trail:
        text = html.escape(label)
        items.append(f'<li><a href="{html.escape(href)}">{text}</a></li>' if href
                     else f'<li aria-current="page">{text}</li>')
    return f'<nav class="crumbs" aria-label="Breadcrumb"><ol>{"".join(items)}</ol></nav>'


def breadcrumb_jsonld(trail: list[tuple[str, str]]) -> dict:
    return {
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i, "name": name, "item": seo.absolute(path)}
            for i, (name, path) in enumerate(trail, start=1)
        ],
    }


def _publisher() -> dict:
    return {"@type": "Organization", "name": landing.ORG_NAME, "url": landing.ORG_URL,
            "logo": {"@type": "ImageObject", "url": seo.absolute("/static/logo.svg")}}


def _cta() -> str:
    url = landing.play_url() or "/#how"
    label = "Get it on Google Play" if landing.play_url() else "See how it works"
    return (
        '<aside class="cta"><div>'
        f'<h2>Try {html.escape(PRODUCT_NAME)}</h2>'
        '<p>Record a meeting and get the transcript, speakers and action items, all on your '
        'phone. Nothing is uploaded.</p></div>'
        f'<a class="cta-btn" href="{html.escape(url)}">{label}</a></aside>'
    )


def render_index(posts: list[Post]) -> str:
    if posts:
        grid = '<div class="post-grid">' + "".join(_card(p) for p in posts) + "</div>"
    else:
        grid = ('<p class="empty">First posts coming soon. In the meantime, '
                '<a href="/">see what Verbale does</a>.</p>')
    return (
        site_header(html.escape(PRODUCT_NAME))
        + '<main class="blog-wrap">'
        + breadcrumb([("Home", "/"), ("Blog", None)])
        + f'<header class="blog-head"><h1>Blog</h1><p>{html.escape(BLOG_INTRO)}</p>'
          '<a class="rss" href="/blog/feed.xml">RSS feed</a></header>'
        + grid + "</main>"
    )


def render_article(post: Post, related: list[Post]) -> str:
    cover = ""
    if post.cover:
        cover = (
            '<figure class="cover"><picture>'
            f'<source srcset="{html.escape(post.cover_webp)}" type="image/webp">'
            f'<img src="{html.escape(post.cover_webp)}" alt="{html.escape(post.cover_alt)}" '
            f'width="{COVER_W}" height="{COVER_H}" decoding="async" fetchpriority="high">'
            '</picture></figure>'
        )
    toc = ""
    if len(post.toc) >= 3:
        links = "".join(f'<li><a href="#{html.escape(i)}">{html.escape(t)}</a></li>'
                        for i, t in post.toc)
        toc = f'<nav class="toc" aria-label="In this article"><h2>In this article</h2><ol>{links}</ol></nav>'
    updated = (f' &middot; <span>Updated <time datetime="{post.updated}">'
               f'{_pretty_date(post.updated)}</time></span>') if post.updated else ""
    tags = "".join(f'<span class="tag">{html.escape(t)}</span>' for t in post.tags)
    more = ""
    if related:
        more = ('<section class="related"><h2>Keep reading</h2><div class="post-grid">'
                + "".join(_card(p) for p in related) + "</div></section>")
    return (
        site_header(html.escape(PRODUCT_NAME))
        + '<main class="blog-wrap"><article class="post">'
        + breadcrumb([("Home", "/"), ("Blog", "/blog"), (post.title, None)])
        + f'<header class="post-head">{tags}<h1>{html.escape(post.title)}</h1>'
          f'<p class="byline"><time datetime="{post.date}">{_pretty_date(post.date)}</time>'
          f'{updated} &middot; {post.minutes} min read</p></header>'
        + cover + toc
        + f'<div class="prose">{post.html}</div>' + _cta() + "</article>" + more + "</main>"
    )


# ---- feed ----

def _rfc822(iso: str) -> str:
    d = date.fromisoformat(iso)
    return format_datetime(datetime(d.year, d.month, d.day, tzinfo=timezone.utc))


def render_feed(posts: list[Post]) -> str:
    """RSS 2.0. Every value passes through html.escape, which is also correct for XML text."""
    items = "".join(
        "<item>"
        f"<title>{html.escape(p.title)}</title>"
        f"<link>{html.escape(seo.absolute(p.path))}</link>"
        f'<guid isPermaLink="true">{html.escape(seo.absolute(p.path))}</guid>'
        f"<pubDate>{_rfc822(p.date)}</pubDate>"
        f"<description>{html.escape(p.description)}</description>"
        + "".join(f"<category>{html.escape(t)}</category>" for t in p.tags)
        + "</item>\n"
        for p in posts
    )
    last = f"<lastBuildDate>{_rfc822(max(p.modified for p in posts))}</lastBuildDate>" if posts else ""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>'
        f"<title>{html.escape(BLOG_TITLE)}</title>"
        f"<link>{html.escape(seo.absolute('/blog'))}</link>"
        f"<description>{html.escape(BLOG_DESCRIPTION)}</description>"
        "<language>en</language>"
        f'<atom:link href="{html.escape(seo.absolute("/blog/feed.xml"))}" rel="self" '
        'type="application/rss+xml"/>'
        f"{last}\n{items}</channel></rss>\n"
    )


# ---- routes ----

def register_blog(app: FastAPI, layout: Callable[..., str],
                  content_dir: Path | str | None = None) -> Blog:
    """
    Mount the blog on `app` and register its pages with the sitemap.

    `layout` is passed in (as legal.py does) because pages.py imports this module. The loaded Blog
    is also kept on `app.state.blog` for anything else that wants the posts.
    """
    blog = Blog(content_dir if content_dir is not None else DEFAULT_DIR)
    app.state.blog = blog

    def sitemap() -> list[seo.SitemapEntry]:
        latest = max((p.modified for p in blog.posts()), default=None)
        return [seo.SitemapEntry("/blog", latest)] + [
            seo.SitemapEntry(p.path, p.modified) for p in blog.posts()]

    seo.register_sitemap_entries(app, sitemap)

    @app.get("/blog", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        posts = blog.posts()
        return HTMLResponse(layout(
            "Blog", render_index(posts), BLOG_DESCRIPTION, path="/blog",
            head_extra=_head_links(), wrap=False,
            jsonld=[
                {"@context": "https://schema.org", "@type": "Blog", "name": BLOG_TITLE,
                 "description": BLOG_DESCRIPTION, "url": seo.absolute("/blog"),
                 "publisher": _publisher(),
                 "blogPost": [{"@type": "BlogPosting", "headline": p.title,
                               "url": seo.absolute(p.path), "datePublished": p.date}
                              for p in posts]},
                breadcrumb_jsonld([("Home", "/"), ("Blog", "/blog")]),
            ],
        ))

    @app.get("/blog/feed.xml")
    def feed() -> Response:
        return Response(render_feed(blog.posts()), media_type="application/rss+xml")

    @app.get("/blog/{name}")
    def article(name: str) -> Response:
        """
        An article, or its raw markdown when the name ends in `.md`.

        One route for both so that nothing between the URL and the lookup is a filesystem path: the
        name is only ever a dictionary key, so `..` and encoded slashes simply find nothing and fall
        through to the styled 404.
        """
        raw_wanted = name.endswith(".md")
        post = blog.get(name[:-3] if raw_wanted else name)
        if post is None:
            raise HTTPException(status_code=404)
        if raw_wanted:
            # Indexable on purpose (AI crawlers are meant to read it), but the canonical header
            # tells search engines the HTML article is the page that should rank.
            return Response(post.raw, media_type="text/markdown; charset=utf-8",
                            headers={"Link": f'<{seo.absolute(post.path)}>; rel="canonical"'})
        head = (
            f'<meta property="article:published_time" content="{post.date}">\n'
            + (f'<meta property="article:modified_time" content="{post.updated}">\n'
               if post.updated else "")
            + "".join(f'<meta property="article:tag" content="{html.escape(t)}">\n' for t in post.tags)
            + f'<link rel="alternate" type="text/markdown" href="/blog/{post.slug}.md">\n'
        )
        posting = {
            "@context": "https://schema.org", "@type": "BlogPosting",
            "headline": post.title, "description": post.description,
            "datePublished": post.date, "dateModified": post.modified,
            "author": {"@type": "Organization", "name": landing.ORG_NAME, "url": landing.ORG_URL},
            "publisher": _publisher(), "mainEntityOfPage": seo.absolute(post.path),
            "url": seo.absolute(post.path), "inLanguage": "en",
        }
        if post.og_image:
            posting["image"] = post.og_image
        if post.tags:
            posting["keywords"] = ", ".join(post.tags)
        return HTMLResponse(layout(
            post.title, render_article(post, blog.related(post)), post.description,
            path=post.path, og_type="article", image=post.og_image,
            head_extra=_head_links(head), wrap=False,
            jsonld=[posting, breadcrumb_jsonld(
                [("Home", "/"), ("Blog", "/blog"), (post.title, post.path)])],
        ))

    return blog
