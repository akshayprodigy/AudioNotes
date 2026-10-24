"""The blog: front matter, rendering, routes, feed, structured data, sitemap."""

import json
import re
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import blog
from app.main import create_app

SITE = "https://verbale.innocorelabs.com"
FIXTURES = Path(__file__).parent / "fixtures" / "blog"
NEWEST, MIDDLE, OLDEST = "writing-action-items", "on-device-transcription", "meeting-minutes-template"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.delenv("PUBLIC_BASE_URL", raising=False)
    monkeypatch.delenv("PLAY_URL", raising=False)


def _client(store, signing_key, content_dir):
    return TestClient(create_app(store=store, signing_key=signing_key, blog_dir=content_dir))


@pytest.fixture
def client(store, signing_key):
    return _client(store, signing_key, FIXTURES)


@pytest.fixture
def empty_client(store, signing_key, tmp_path):
    return _client(store, signing_key, tmp_path)


def jsonld(html):
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
    return [json.loads(b) for b in blocks]


def write(tmp_path, name, text):
    (tmp_path / name).write_text(text)


GOOD = "---\ntitle: T\ndescription: D\ndate: 2026-01-02\n---\nBody\n"


# ---- loading ----

def test_front_matter_is_parsed():
    posts = {p.slug: p for p in blog.load_posts(FIXTURES)}
    p = posts[MIDDLE]
    assert p.title.startswith("Why on-device")
    assert p.date == "2026-09-02"
    assert p.tags == ["privacy", "on-device"]
    assert p.cover == "on-device"
    assert p.shot == "record-screen"
    assert p.updated is None
    assert posts[NEWEST].updated == "2026-10-15"


def test_posts_are_newest_first():
    assert [p.slug for p in blog.load_posts(FIXTURES)] == [NEWEST, MIDDLE, OLDEST]


def test_get_returns_post_or_none():
    store = blog.Blog(FIXTURES)
    assert store.get(MIDDLE).slug == MIDDLE
    assert store.get("nope") is None
    assert [p.slug for p in store.posts()][0] == NEWEST


def test_missing_title_names_the_file(tmp_path):
    write(tmp_path, "oops.md", "---\ndescription: D\ndate: 2026-01-02\n---\nBody")
    with pytest.raises(blog.BlogError) as e:
        blog.load_posts(tmp_path)
    assert "oops.md" in str(e.value) and "title" in str(e.value)


def test_bad_date_and_long_description_rejected(tmp_path):
    write(tmp_path, "a.md", "---\ntitle: T\ndescription: D\ndate: 2026-13-45\n---\nB")
    with pytest.raises(blog.BlogError, match="a.md"):
        blog.load_posts(tmp_path)
    (tmp_path / "a.md").unlink()
    write(tmp_path, "b.md", "---\ntitle: T\ndescription: " + "x" * 161 + "\ndate: 2026-01-02\n---\nB")
    with pytest.raises(blog.BlogError, match="b.md"):
        blog.load_posts(tmp_path)


def test_no_front_matter_rejected(tmp_path):
    write(tmp_path, "plain.md", "Just text")
    with pytest.raises(blog.BlogError, match="plain.md"):
        blog.load_posts(tmp_path)


@pytest.mark.parametrize("name", ["Bad_Slug.md", "UPPER.md", "-lead.md", "double--dash.md"])
def test_bad_slug_filename_rejected(tmp_path, name):
    write(tmp_path, name, GOOD)
    with pytest.raises(blog.BlogError) as e:
        blog.load_posts(tmp_path)
    assert name in str(e.value)


def test_bad_post_stops_app_startup(store, signing_key, tmp_path):
    write(tmp_path, "broken.md", "---\ndescription: D\ndate: 2026-01-02\n---\nB")
    with pytest.raises(blog.BlogError, match="broken.md"):
        create_app(store=store, signing_key=signing_key, blog_dir=tmp_path)


def test_reading_time_has_a_floor_of_one_minute():
    assert blog.reading_minutes("word " * 3) == 1
    assert blog.reading_minutes("") == 1
    assert blog.reading_minutes("word " * 221) == 2
    assert blog.reading_minutes("word " * 660) == 3


def test_real_content_dir_starts_empty_and_loads():
    assert blog.load_posts(blog.DEFAULT_DIR) == [] or all(
        p.slug for p in blog.load_posts(blog.DEFAULT_DIR))


@pytest.mark.parametrize("text,title,tags", [
    ("---\r\ntitle: T\r\ndescription: D\r\ndate: 2026-01-02\r\ntags: a, b\r\n---\r\nBody", "T", ["a", "b"]),
    ("\ufeff---\ntitle: T\ndescription: D\ndate: 2026-01-02\n---\nBody", "T", []),
    ('---\ntitle: "Quoted"\ndescription: D\ndate: 2026-01-02\n---\nBody', "Quoted", []),
    ("---\ntitle: 'Single'\ndescription: D\ndate: 2026-01-02\n---\nBody", "Single", []),
    ("---\ntitle: Note: a colon\ndescription: D\ndate: 2026-01-02\n---\nBody", "Note: a colon", []),
    ("---\ntitle: T\ndescription: D\ndate: 2026-01-02\ntags:\n---\nBody", "T", []),
    ("---\ntitle: T\ndescription: D\ndate: 2026-01-02\ntags: a,, b ,\n---\nBody", "T", ["a", "b"]),
], ids=["crlf", "bom", "double-quoted", "single-quoted", "colon", "empty-tags", "ragged-tags"])
def test_front_matter_edge_cases(tmp_path, text, title, tags):
    write(tmp_path, "p.md", text)
    (post,) = blog.load_posts(tmp_path)
    assert post.title == title and post.tags == tags
    assert not post.raw.startswith("\ufeff")


# ---- index ----

def test_index_lists_newest_first(client):
    html = client.get("/blog").text
    positions = [html.index(f'href="/blog/{s}"') for s in (NEWEST, MIDDLE, OLDEST)]
    assert positions == sorted(positions)
    assert "min read" in html
    assert 'href="/blog/feed.xml"' in html
    assert '<link rel="stylesheet" href="/static/blog.css">' in html


def test_index_escapes_titles(client):
    html = client.get("/blog").text
    assert "A meeting minutes template &lt;that&gt; works" in html
    assert "<that>" not in html


def test_index_without_posts_is_friendly(empty_client):
    r = empty_client.get("/blog")
    assert r.status_code == 200
    assert "First posts coming soon" in r.text


def test_index_structured_data(client):
    docs = jsonld(client.get("/blog").text)
    types = {d["@type"] for d in docs}
    assert {"Blog", "BreadcrumbList"} <= types
    crumbs = next(d for d in docs if d["@type"] == "BreadcrumbList")
    assert crumbs["itemListElement"][-1]["item"] == f"{SITE}/blog"


# ---- article ----

def test_article_renders_the_parts(client):
    html = client.get(f"/blog/{MIDDLE}").text
    assert "Why on-device transcription changes" in html
    assert "2 September 2026" in html
    assert "1 min read" in html
    assert 'class="toc"' in html and 'href="#what-leaves-the-phone"' in html
    assert 'id="what-leaves-the-phone"' in html
    assert 'class="cta"' in html and 'href="/#how"' in html
    assert 'class="related"' in html
    assert "<table>" in html and "<blockquote>" in html
    assert '<picture>' in html and 'on-device.webp' in html and 'width="1600"' in html
    assert 'alt="A phone with a sound wave inside a lock"' in html
    assert 'Home' in html and 'aria-label="Breadcrumb"' in html


def test_toc_needs_three_h2s(client):
    assert 'class="toc"' not in client.get(f"/blog/{NEWEST}").text


def test_updated_shown_only_when_set(client):
    assert re.search(r"Updated <time datetime=\"2026-10-15\">15 October 2026</time>",
                     client.get(f"/blog/{NEWEST}").text)
    assert "Updated" not in client.get(f"/blog/{MIDDLE}").text


def test_cta_uses_play_url_when_set(client, monkeypatch):
    monkeypatch.setenv("PLAY_URL", "https://play.google.com/store/apps/details?id=x")
    html = client.get(f"/blog/{MIDDLE}").text
    assert 'href="https://play.google.com/store/apps/details?id=x"' in html


def test_related_prefers_shared_tags_and_excludes_self(client):
    html = client.get(f"/blog/{NEWEST}").text
    related = html[html.index('class="related"'):]
    assert f"/blog/{OLDEST}" in related           # shares "meetings"
    assert f'href="/blog/{NEWEST}"' not in related


def test_body_images_are_lazy(client):
    html = client.get(f"/blog/{MIDDLE}").text
    assert re.search(r'<img [^>]*src="/static/shots/record.webp"[^>]*loading="lazy"', html)
    assert 'decoding="async"' in html


def test_tables_are_wrapped_for_scrolling(client):
    html = client.get(f"/blog/{MIDDLE}").text
    wraps = re.findall(r'<div class="table-wrap">(.*?)</div>', html, re.S)
    assert len(wraps) == 2
    assert all("<table" in w and "</table>" in w for w in wraps)
    assert html.count("<table") == 2


def test_cover_image_is_not_lazy(client):
    # The cover is the largest paint on the page; lazy-loading it would delay LCP.
    html = client.get(f"/blog/{MIDDLE}").text
    cover = re.search(r'<img [^>]*on-device\.webp[^>]*>', html).group(0)
    assert "lazy" not in cover


def test_article_head(client):
    html = client.get(f"/blog/{NEWEST}").text
    assert f'<link rel="canonical" href="{SITE}/blog/{NEWEST}">' in html
    assert '<meta property="og:type" content="article">' in html
    assert f'content="{SITE}/static/blog/action-items-og.png"' in html
    assert '<meta property="article:published_time" content="2026-10-10">' in html
    assert '<meta property="article:modified_time" content="2026-10-15">' in html
    assert 'rel="alternate" type="application/rss+xml"' in html
    assert f'<link rel="alternate" type="text/markdown" href="/blog/{NEWEST}.md">' in html


def test_article_without_cover_uses_default_image(client):
    html = client.get(f"/blog/{OLDEST}").text
    assert f'content="{SITE}/static/og.png"' in html
    assert "<picture>" not in html


def test_article_structured_data(client):
    docs = jsonld(client.get(f"/blog/{NEWEST}").text)
    post = next(d for d in docs if d["@type"] == "BlogPosting")
    assert post["headline"] == "How to write action items people actually do"
    assert post["datePublished"] == "2026-10-10"
    assert post["dateModified"] == "2026-10-15"
    assert post["image"] == f"{SITE}/static/blog/action-items-og.png"
    assert post["author"]["name"] == "InnoCore Labs"
    assert post["publisher"]["@type"] == "Organization" and post["publisher"]["logo"]
    assert post["mainEntityOfPage"] == f"{SITE}/blog/{NEWEST}"
    assert post["keywords"] == "meetings, productivity"
    crumbs = next(d for d in docs if d["@type"] == "BreadcrumbList")
    assert [i["name"] for i in crumbs["itemListElement"]][:2] == ["Home", "Blog"]
    assert crumbs["itemListElement"][2]["item"] == f"{SITE}/blog/{NEWEST}"


# ---- raw markdown ----

def test_markdown_route_returns_source(client):
    r = client.get(f"/blog/{MIDDLE}.md")
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/markdown; charset=utf-8"
    assert r.text == (FIXTURES / f"{MIDDLE}.md").read_text()
    assert r.text.startswith("---\ntitle:")
    assert r.headers["link"] == f'<{SITE}/blog/{MIDDLE}>; rel="canonical"'
    assert "noindex" not in r.headers.get("x-robots-tag", "")


# ---- feed ----

def test_feed_is_valid_rss(client):
    r = client.get("/blog/feed.xml")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/rss+xml")
    root = ET.fromstring(r.content)
    assert root.tag == "rss" and root.get("version") == "2.0"
    items = root.findall("./channel/item")
    assert len(items) == 3
    first = items[0]
    assert first.findtext("link") == f"{SITE}/blog/{NEWEST}"
    assert first.findtext("guid") == f"{SITE}/blog/{NEWEST}"
    assert first.findtext("pubDate") == "Sat, 10 Oct 2026 00:00:00 +0000"
    assert items[2].findtext("title") == "A meeting minutes template <that> works"


def test_feed_with_no_posts_is_still_valid(empty_client):
    root = ET.fromstring(empty_client.get("/blog/feed.xml").content)
    assert root.findall("./channel/item") == []


# ---- 404s ----

def test_unknown_slug_is_the_styled_404(client):
    r = client.get("/blog/does-not-exist")
    assert r.status_code == 404
    assert "Page not found" in r.text
    assert client.get("/blog/does-not-exist.md").status_code == 404


@pytest.mark.parametrize("path", [
    "/blog/../app/blog", "/blog/..%2f..%2fetc%2fpasswd", "/blog/%2e%2e%2fmain.md",
    "/blog/..%5cmain", "/blog/%2e%2e",
])
def test_path_traversal_is_404(client, path):
    assert client.get(path).status_code == 404


# ---- sitemap ----

def test_sitemap_lists_blog_and_posts(client):
    root = ET.fromstring(client.get("/sitemap.xml").content)
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    lastmod = {u.findtext("s:loc", namespaces=ns): u.findtext("s:lastmod", namespaces=ns)
               for u in root.findall("s:url", ns)}
    assert f"{SITE}/blog" in lastmod
    assert lastmod[f"{SITE}/blog/{NEWEST}"] == "2026-10-15"   # updated wins
    assert lastmod[f"{SITE}/blog/{MIDDLE}"] == "2026-09-02"
    assert lastmod[f"{SITE}/blog/{OLDEST}"] == "2026-08-20"


# ---- navigation ----

def test_nav_links_to_blog(client):
    assert 'href="/blog"' in client.get("/").text
    assert 'href="/blog"' in client.get("/privacy").text


BANNED_WORDS = ["whisper", "qwen", "llama", "gpt", "otter", "fireflies", "game-changer", "unlock"]


def test_real_posts_meet_the_content_bar():
    import re
    from pathlib import Path

    posts = sorted((Path(blog.__file__).parent / "content" / "blog").glob("*.md"))
    assert len(posts) >= 5
    for path in posts:
        raw = path.read_text(encoding="utf-8")
        meta, body = blog._split_front_matter(raw, path.name)
        where = path.name
        assert len(meta["description"]) <= 160, where
        assert len(re.findall(r"^## ", body, re.M)) >= 3, where
        assert re.search(r"^## FAQ\s*$", body, re.M), where
        assert "/static/shots/" in body, where
        assert len(set(re.findall(r"\]\(/blog/[\w-]+\)", body))) >= 2, where
        words = len(re.findall(r"\S+", body))
        assert 900 <= words <= 1600, f"{where}: {words} words"
        low = raw.lower()
        for bad in BANNED_WORDS:
            assert bad not in low, f"{where}: banned word {bad!r}"
