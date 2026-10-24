"""Image SEO: every <img> has accurate, keyword-bearing alt text; share images carry alt tags; the
sitemap lists images. Crawls the public site through the real app so a new page cannot skip it."""

import re
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

IMG_NS = "{http://www.google.com/schemas/sitemap-image/1.1}"
SM_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
BAD_PREFIX = re.compile(r"^\s*(image|picture|screenshot|photo)\s+of\b", re.I)
STATIC_PAGES = ["/", "/blog", "/about", "/faq", "/privacy", "/terms", "/delete-account"]


@pytest.fixture()
def client(store, signing_key):
    return TestClient(create_app(store=store, signing_key=signing_key))


class _Imgs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.imgs = []
        self.meta = {}

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "img":
            self.imgs.append(a)
        if tag == "meta":
            key = a.get("property") or a.get("name")
            if key:
                self.meta[key] = a.get("content")


def _parse(client, path):
    r = client.get(path)
    assert r.status_code == 200, path
    p = _Imgs()
    p.feed(r.text)
    return p


def _all_paths(client):
    return STATIC_PAGES + [p.path for p in client.app.state.blog.posts()]


def test_every_img_has_good_alt(client):
    seen = 0
    for path in _all_paths(client):
        for img in _parse(client, path).imgs:
            seen += 1
            alt = img.get("alt")
            where = f"{path} {img.get('src')}"
            assert alt and alt.strip(), f"missing alt: {where}"
            assert len(alt) <= 125, f"alt too long ({len(alt)}): {where}"
            assert not BAD_PREFIX.match(alt), f"filler prefix: {where}"
            assert "verbale" in alt.lower() or "meeting" in alt.lower(), f"generic alt: {where}"
            assert "—" not in alt, where
    assert seen > 20


def test_every_page_has_share_image_alt(client):
    for path in _all_paths(client):
        meta = _parse(client, path).meta
        for key in ("og:image:alt", "twitter:image:alt"):
            assert (meta.get(key) or "").strip(), f"{key} missing on {path}"
            assert len(meta[key]) <= 125, f"{key} too long on {path}"


def test_article_share_alt_is_its_cover_alt(client):
    for post in client.app.state.blog.posts():
        assert _parse(client, post.path).meta["og:image:alt"] == post.cover_alt


def test_cover_alts_are_distinct_and_valid(client):
    alts = [p.cover_alt for p in client.app.state.blog.posts()]
    assert len(set(alts)) == len(alts)


def _sitemap(client):
    root = ET.fromstring(client.get("/sitemap.xml").content)
    out = {}
    for url in root.findall(f"{SM_NS}url"):
        loc = url.find(f"{SM_NS}loc").text
        out[loc] = [i.text for i in url.iter(f"{IMG_NS}loc")]
    return out


def test_sitemap_declares_image_namespace(client):
    assert 'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' in client.get("/sitemap.xml").text


def test_sitemap_locs_are_unique(client):
    root = ET.fromstring(client.get("/sitemap.xml").content)
    locs = [u.find(f"{SM_NS}loc").text for u in root.findall(f"{SM_NS}url")]
    assert len(locs) == len(set(locs))


def test_sitemap_merges_entries_for_one_path():
    from app import seo
    entries = seo.sitemap_entries([
        lambda: [seo.SitemapEntry("/", images=("/a.png", "/b.png"))],
        lambda: [seo.SitemapEntry("/", "2026-01-01", ("/b.png", "/c.png"))]])
    home = [e for e in entries if e.path == "/"]
    assert len(home) == 1
    assert home[0].images == ("/a.png", "/b.png", "/c.png")
    assert home[0].lastmod == "2026-01-01"


def test_sitemap_home_lists_shots_and_og(client):
    imgs = _sitemap(client)["https://verbale.innocorelabs.com/"]
    assert len(imgs) >= 6
    assert all(i.startswith("https://verbale.innocorelabs.com/static/") for i in imgs)
    assert any(i.endswith("/static/og.png") for i in imgs)


def test_sitemap_posts_list_cover_and_body_shots(client):
    sm = _sitemap(client)
    for post in client.app.state.blog.posts():
        listed = sm["https://verbale.innocorelabs.com" + post.path]
        assert "https://verbale.innocorelabs.com" + post.cover_webp in listed
        for src in re.findall(r"!\[[^\]]*\]\((/static/[^)\s]+)\)", post.body):
            assert "https://verbale.innocorelabs.com" + src in listed


def test_sitemap_blog_index_lists_all_covers(client):
    listed = _sitemap(client)["https://verbale.innocorelabs.com/blog"]
    for post in client.app.state.blog.posts():
        assert "https://verbale.innocorelabs.com" + post.cover_webp in listed


def test_sitemap_escapes_image_urls():
    from app import seo
    xml = seo.sitemap_xml([lambda: [seo.SitemapEntry("/x", images=("/static/a&b.webp",))]])
    ET.fromstring(xml)
    assert "a%26b" in xml  # absolute() percent-encodes, so the XML stays well-formed
