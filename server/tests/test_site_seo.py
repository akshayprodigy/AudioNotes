"""Canonical URLs, structured data, robots, sitemap and the 404 page."""

import json
import re
import xml.etree.ElementTree as ET

import pytest
from fastapi.testclient import TestClient

from app import landing, seo
from app.main import create_app
from app.pages import layout

SITE = "https://verbale.innocorelabs.com"
PAGES = ["/", "/privacy", "/terms", "/delete-account"]


@pytest.fixture
def client(store, signing_key):
    return TestClient(create_app(store=store, signing_key=signing_key))


@pytest.fixture(autouse=True)
def _no_site_env(monkeypatch):
    monkeypatch.delenv("PUBLIC_BASE_URL", raising=False)
    monkeypatch.delenv("PLAY_URL", raising=False)


def jsonld(html):
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
    return [json.loads(b) for b in blocks]


@pytest.mark.parametrize("path", PAGES)
def test_canonical_and_og_url_are_absolute(client, path):
    html = client.get(path).text
    url = SITE + ("" if path == "/" else path)
    url = url if path != "/" else SITE + "/"
    assert f'<link rel="canonical" href="{url}">' in html
    assert f'<meta property="og:url" content="{url}">' in html
    assert f'<meta property="og:image" content="{SITE}/static/og.png">' in html


def test_public_base_url_env_overrides_the_site(client, monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://example.test/")
    html = client.get("/terms").text
    assert '<link rel="canonical" href="https://example.test/terms">' in html


def test_og_type_and_image_are_overridable():
    html = layout("T", "b", path="/x", og_type="article", image="https://img.test/a.png")
    assert '<meta property="og:type" content="article">' in html
    assert '<meta property="og:image" content="https://img.test/a.png">' in html


def test_home_jsonld_has_the_four_types(client):
    data = jsonld(client.get("/").text)
    assert {d["@type"] for d in data} == {
        "Organization", "WebSite", "SoftwareApplication", "FAQPage"}
    app = next(d for d in data if d["@type"] == "SoftwareApplication")
    assert app["operatingSystem"] == "Android"
    assert app["applicationCategory"] == "BusinessApplication"
    prices = {(o["priceCurrency"], o["price"]) for o in app["offers"]}
    assert {("INR", "0"), ("INR", "299"), ("INR", "2499"),
            ("USD", "4.99"), ("USD", "39.99")} <= prices
    org = next(d for d in data if d["@type"] == "Organization")
    assert org["logo"] == f"{SITE}/static/logo.svg"


def test_faq_jsonld_matches_the_faq_data(client):
    faq = next(d for d in jsonld(client.get("/").text) if d["@type"] == "FAQPage")
    assert len(faq["mainEntity"]) == len(landing.FAQ)
    for item in faq["mainEntity"]:
        assert "<" not in item["acceptedAnswer"]["text"]
        assert "&mdash;" not in item["acceptedAnswer"]["text"]


def test_jsonld_cannot_break_out_of_its_script_tag():
    html = layout("T", "b", path="/", jsonld=[{"name": "</script><b>&"}])
    block = re.search(r'<script type="application/ld\+json">(.*?)</script>', html, re.S).group(1)
    assert "</script>" not in block and "<" not in block
    assert json.loads(block)["name"] == "</script><b>&"
    assert html.count("</script>") == html.replace("</script><b>", "").count("</script>")


def test_play_url_toggles_download_url_and_hero_button(client, monkeypatch):
    html = client.get("/").text
    assert "downloadUrl" not in html and "Get it on Google Play" not in html
    monkeypatch.setenv("PLAY_URL", "https://play.google.com/store/apps/details?id=x")
    html = client.get("/").text
    app = next(d for d in jsonld(html) if d["@type"] == "SoftwareApplication")
    assert app["downloadUrl"] == app["installUrl"] == "https://play.google.com/store/apps/details?id=x"
    assert "Get it on Google Play" in html


def test_robots_txt(client):
    body = client.get("/robots.txt").text
    star = body.split("User-agent: *")[1].split("User-agent:")[0]
    assert "Allow: /\n" in star and "Disallow: /admin" in star and "Disallow: /api/" in star
    for bot in ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User",
                "Claude-SearchBot", "PerplexityBot", "Perplexity-User", "Google-Extended",
                "Applebot-Extended", "CCBot", "Bingbot"]:
        group = body.split(f"User-agent: {bot}\n")[1].split("User-agent:")[0]
        assert "Allow: /\n" in group and "Disallow: /admin" in group and "Disallow: /api/" in group
    assert f"Sitemap: {SITE}/sitemap.xml" in body


def test_sitemap_lists_exactly_the_registry(client):
    r = client.get("/sitemap.xml")
    assert r.headers["content-type"].startswith("application/xml")
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = [e.text for e in ET.fromstring(r.content).findall("s:url/s:loc", ns)]
    assert locs == [SITE + e.path for e in seo.sitemap_entries()]
    assert locs == [SITE + "/", SITE + "/privacy", SITE + "/terms", SITE + "/delete-account"]
    assert not any("/admin" in l or "/api" in l for l in locs)


def test_sitemap_registry_accepts_entries_with_lastmod(client):
    seo.register_sitemap_entries(lambda: [seo.SitemapEntry("/blog/x", "2026-10-01")])
    try:
        text = client.get("/sitemap.xml").text
        assert f"<loc>{SITE}/blog/x</loc>" in text and "<lastmod>2026-10-01</lastmod>" in text
    finally:
        seo._providers.pop()


def test_unknown_path_is_a_styled_404(client):
    r = client.get("/nope")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("text/html")
    assert "site-header" in r.text and "data-theme-toggle" in r.text
    assert 'href="/"' in r.text
    assert 'rel="canonical"' not in r.text and 'og:url' not in r.text
    assert '<meta name="robots" content="noindex, nofollow">' in r.text


def test_admin_pages_are_noindex_without_canonical(client):
    html = client.get("/admin/signin").text
    assert '<meta name="robots" content="noindex, nofollow">' in html
    assert 'rel="canonical"' not in html


@pytest.mark.parametrize("path", PAGES)
def test_public_pages_are_indexable(client, path):
    assert "noindex" not in client.get(path).text


def test_pro_offers_carry_a_unit_price_specification(client):
    app = next(d for d in jsonld(client.get("/").text) if d["@type"] == "SoftwareApplication")
    pro = [o for o in app["offers"] if o["name"].startswith("Pro")]
    assert len(pro) == 4
    for o in pro:
        spec = o["priceSpecification"]
        assert o["category"] == "subscription" and spec["@type"] == "UnitPriceSpecification"
        assert (spec["price"], spec["priceCurrency"]) == (o["price"], o["priceCurrency"])
        assert (spec["billingDuration"], spec["unitText"]) in {("P1M", "month"), ("P1Y", "year")}
    assert {o["priceCurrency"] for o in app["offers"] if o["name"] == "Free"} == {"INR", "USD"}


def test_unknown_api_path_stays_json(client):
    r = client.get("/api/nope")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")
