"""AI-assistant readiness: /about, /faq, /llms.txt, /llms-full.txt, sitemap, footer, head link."""

import html
import json
import re

import pytest
from fastapi.testclient import TestClient

from app import about, landing
from app.main import create_app

SITE = "https://verbale.innocorelabs.com"
BANNED = re.compile(r"\b(whisper|qwen|llama|gpt|otter|fireflies)\b", re.I)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.delenv("PUBLIC_BASE_URL", raising=False)
    monkeypatch.delenv("PLAY_URL", raising=False)


@pytest.fixture
def client(store, signing_key):
    # The real content dir (blog_dir=None), so the tests see the posts that will ship.
    return TestClient(create_app(store=store, signing_key=signing_key))


def _blocks(html):
    return [json.loads(m) for m in
            re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)]


def _posts(client):
    posts = client.app.state.blog.posts()
    assert posts
    return posts


def test_about_has_h1_definition_and_prices(client):
    r = client.get("/about")
    assert r.status_code == 200
    assert "<h1>What is Verbale?</h1>" in r.text
    assert "Verbale is an Android app by InnoCore Labs that" in r.text
    assert html.escape(about.DEFINITION) in r.text
    for price in ("299", "2,499", "4.99", "39.99"):
        assert price in r.text
    assert f'<link rel="canonical" href="{SITE}/about">' in r.text
    assert "Last updated" in r.text
    for heading in ("Who it is for", "What it does", "What it does not do", "Pricing",
                    "Requirements", "Privacy", "The company"):
        assert f">{heading}</h2>" in r.text
    assert 'href="/privacy"' in r.text and "https://innocorelabs.com" in r.text


def test_about_prices_come_from_PRICES(client, monkeypatch):
    monkeypatch.setitem(landing.PRICES["monthly"], "USD", "7.77")
    assert "7.77" in client.get("/about").text


def test_about_jsonld(client):
    types = {b["@type"]: b for b in _blocks(client.get("/about").text)}
    assert {"AboutPage", "Organization", "BreadcrumbList"} <= set(types)
    assert types["AboutPage"]["mainEntity"]["@type"] == "SoftwareApplication"
    assert types["AboutPage"]["mainEntity"]["name"] == "Verbale"
    assert types["Organization"]["url"] == landing.ORG_URL


def test_faq_page(client):
    r = client.get("/faq")
    assert r.status_code == 200
    assert "<h1>" in r.text
    for q, _ in landing.FAQ:
        assert html.unescape(q) in html.unescape(r.text)
    types = [b["@type"] for b in _blocks(r.text)]
    assert "FAQPage" in types and "BreadcrumbList" in types
    assert f'<link rel="canonical" href="{SITE}/faq">' in r.text
    assert 'href="/about"' in r.text and 'href="/blog"' in r.text


def test_llms_txt_shape(client):
    r = client.get("/llms.txt")
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/plain; charset=utf-8"
    t = r.text
    assert t.startswith("# Verbale")
    assert re.search(r"^> .+", t, re.M)
    for h in ("## Docs", "## Blog", "## Optional"):
        assert h in t
    for p in _posts(client):
        assert f"]({SITE}/blog/{p.slug}.md)" in t
        assert p.title in t
    for path in ("/about", "/faq", "/privacy", "/terms", "/llms-full.txt", "/sitemap.xml",
                 "/blog/feed.xml"):
        assert f"]({SITE}{path})" in t


def test_every_llms_url_resolves(client):
    urls = re.findall(r"\]\((https?://[^)]+)\)", client.get("/llms.txt").text)
    assert len(urls) >= 4 + len(_posts(client))
    for u in urls:
        assert u.startswith(SITE)
        assert client.get(u[len(SITE):]).status_code == 200, u


def test_llms_full(client):
    r = client.get("/llms-full.txt")
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/plain; charset=utf-8"
    for p in _posts(client):
        assert f"# {p.title}" in r.text
        assert f"{SITE}/blog/{p.slug}" in r.text
    for q, _ in landing.FAQ:
        assert q in r.text
    assert "# What is Verbale?" in r.text


def test_llms_full_has_no_front_matter_blocks(client):
    # A front-matter block is `---` / key: value lines / `---`.
    assert not re.search(r"^---\ntitle:", client.get("/llms-full.txt").text, re.M)


def test_sitemap_lists_about_and_faq(client):
    t = client.get("/sitemap.xml").text
    assert f"<loc>{SITE}/about</loc>" in t and f"<loc>{SITE}/faq</loc>" in t


def test_landing_footer_links_and_alternate(client):
    t = client.get("/").text
    foot = t[t.index("<footer"):]
    for href in ("/about", "/faq", "/blog", "/llms.txt"):
        assert f'href="{href}"' in foot
    alt = '<link rel="alternate" type="text/plain" title="LLM summary" href="/llms.txt">'
    assert alt in t.split("</head>")[0]
    assert alt in client.get("/blog").text.split("</head>")[0]


def test_prose_pages_have_footer(client):
    for p in ("/about", "/faq"):
        t = client.get(p).text
        assert "<footer" in t and 'href="/llms.txt"' in t and 'href="/terms"' in t


@pytest.mark.parametrize("path", ["/about", "/faq", "/llms.txt", "/llms-full.txt"])
def test_no_banned_words(client, path):
    assert not BANNED.search(client.get(path).text)


def test_faq_answer_md_keeps_links_entities_and_drops_tags():
    out = about.faq_answer_md(
        "A &mdash; <b>B</b> <a class=\"x\" href='/delete-account'>see <em>this</em></a>.")
    assert out == f"A \u2014 B [see this]({SITE}/delete-account)."


@pytest.mark.parametrize("path", ["/llms.txt", "/llms-full.txt"])
def test_llms_files_are_clean_markdown(client, path):
    t = client.get(path).text
    assert "&mdash;" not in t and "&amp;" not in t
    assert "](/" not in t
    if path == "/llms.txt":
        assert "<" not in t


def test_about_pages_are_cacheable(client):
    for p in ("/about", "/faq", "/llms.txt", "/llms-full.txt"):
        assert client.get(p).headers["cache-control"] == "public, max-age=3600"


def test_about_text_links_are_restricted_to_safe_targets():
    assert about._inline_html("[x](javascript:evil) [y](/a)") == 'x <a href="/a">y</a>'


def test_every_public_page_has_one_shared_footer(client):
    slug = _posts(client)[0].slug
    for p in ("/", "/blog", f"/blog/{slug}", "/about", "/faq", "/privacy", "/terms",
              "/delete-account"):
        t = client.get(p).text
        assert t.count("<footer") == 1, p
        foot = t[t.index("<footer"):t.index("</footer>")]
        assert 'href="/privacy"' in foot and 'href="/terms"' in foot, p


def test_cache_headers(client):
    slug = _posts(client)[0].slug
    cc = lambda p: client.get(p).headers.get("cache-control")  # noqa: E731
    assert cc("/blog") == cc(f"/blog/{slug}") == "public, max-age=600"
    assert cc("/static/blog.css") == "public, max-age=3600"
    assert cc("/static/logo.svg") == "public, max-age=3600"
    img = next(p.cover_webp for p in _posts(client) if p.cover)
    assert cc(img) == "public, max-age=604800"
    assert cc("/static/shots/mom.webp") == "public, max-age=604800"
    assert client.get("/static/nope.png").headers.get("cache-control") is None
