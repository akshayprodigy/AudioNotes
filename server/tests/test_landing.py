"""The home page: nav, screenshot strip, blog teaser, single-source prices, no-JS visibility."""

import html as html_mod
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import blog, landing
from app.main import create_app
from app.theme import HEAD_SCRIPT

STATIC = Path(__file__).parent.parent / "app" / "static"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.delenv("PUBLIC_BASE_URL", raising=False)
    monkeypatch.delenv("PLAY_URL", raising=False)


@pytest.fixture
def client(store, signing_key):
    return TestClient(create_app(store=store, signing_key=signing_key))


@pytest.fixture
def empty_client(store, signing_key, tmp_path):
    return TestClient(create_app(store=store, signing_key=signing_key, blog_dir=tmp_path))


def home(c):
    return c.get("/").text


def test_nav_links(client):
    nav = re.search(r'<nav class="nav">.*?</nav>', home(client), re.S).group(0)
    for href in ("#how", "#pricing", "/blog", "/faq"):
        assert f'href="{href}"' in nav
    assert 'id="pricing"' in home(client)
    # Blog must stay reachable on phones: it is the one link that is not an in-page anchor.
    blog_link = re.search(r'<a [^>]*href="/blog"[^>]*>', nav).group(0)
    assert "hide-sm" not in blog_link


def test_screenshot_strip(client):
    strip = re.search(r'<section id="see".*?</section>', home(client), re.S).group(0)
    imgs = re.findall(r"<img [^>]*>", strip)
    assert len(imgs) >= 4
    for tag in imgs:
        src = re.search(r'src="(/static/shots/[^"]+)"', tag).group(1)
        assert (STATIC / src.removeprefix("/static/")).is_file()
        assert re.search(r'alt="[^"]+"', tag)
        assert re.search(r'width="\d+"', tag) and re.search(r'height="\d+"', tag)
        assert 'loading="lazy"' in tag


def test_from_the_blog_lists_three_newest(client):
    posts = blog.load_posts(blog.DEFAULT_DIR)
    section = re.search(r'<section id="from-blog".*?</section>', home(client), re.S).group(0)
    hrefs = re.findall(r'<a class="post-card" href="([^"]+)"', section)
    assert hrefs == [p.path for p in posts[:3]]
    assert 'href="/blog"' in section


def test_no_posts_no_section(empty_client):
    assert "From the blog" not in home(empty_client)
    assert 'id="from-blog"' not in home(empty_client)


def _pricing(c):
    return re.search(r'<section id="pricing".*?</section>', home(c), re.S).group(0)


def _fmt(amount, cur):
    sym = "₹" if cur == "INR" else "$"
    return sym + (f"{int(amount):,}" if cur == "INR" else amount)


def test_pricing_comes_from_prices(client):
    sec = html_mod.unescape(_pricing(client))
    for period in ("monthly", "yearly"):
        for cur in ("INR", "USD"):
            assert _fmt(landing.PRICES[period][cur], cur) in sec
    assert "₹0" in sec and "$0" in sec
    # Every currency figure in the section must be one PRICES produced.
    allowed = {_fmt(v, c) for d in landing.PRICES.values() for c, v in d.items()}
    found = set(re.findall(r"[₹$][\d,.]+\d|[₹$]\d", sec.replace("&#8377;", "₹")))
    assert found <= allowed, found - allowed


def test_prices_change_follows_single_source(client, monkeypatch):
    monkeypatch.setitem(landing.PRICES["monthly"], "INR", "777")
    monkeypatch.setitem(landing.PRICES["yearly"], "USD", "55.55")
    sec = html_mod.unescape(_pricing(client))
    assert "₹777" in sec and "$55.55" in sec
    assert "₹299" not in sec and "$39.99" not in sec


def test_faq_has_no_download_sizes(client):
    h = home(client)
    faq = h[h.index("Questions people actually ask"):]
    assert not re.search(r"\b(MB|GB)\b", faq)
    assert not any(re.search(r"\b(MB|GB)\b", a) for _, a in landing.FAQ)


def test_reveal_is_gated_on_js():
    css = re.sub(r"/\*.*?\*/", "", (STATIC / "landing.css").read_text(), flags=re.S)
    for m in re.finditer(r"([^{}]*)\{([^{}]*opacity:\s*0[^{}]*)\}", css):
        sel = m.group(1).strip()
        if ".rise" in sel:
            assert sel.startswith("html.js"), sel
    assert "html.js .rise" in css
    assert "classList.add('js')" in HEAD_SCRIPT


def test_blog_index_first_row_is_eager(client):
    h = client.get("/blog").text
    cards = re.findall(r'<a class="post-card".*?</a>', h, re.S)
    assert len(cards) >= 4
    for c in cards[:3]:
        assert 'loading="lazy"' not in c
    assert 'fetchpriority="high"' in cards[0]
    assert 'loading="lazy"' in cards[3]


def test_home_blog_cards_stay_lazy(client):
    section = re.search(r'<section id="from-blog".*?</section>', home(client), re.S).group(0)
    assert section.count('loading="lazy"') == 3
