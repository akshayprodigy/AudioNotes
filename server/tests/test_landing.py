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
    assert 'role="list"' in strip and 'aria-label="App screenshots"' in strip
    assert strip.count('role="listitem"') == len(imgs)
    for tag in imgs:
        src = re.search(r'src="(/static/shots/[^"]+)"', tag).group(1)
        assert (STATIC / src.removeprefix("/static/")).is_file()
        assert re.search(r'alt="[^"]+"', tag)
        assert re.search(r'width="\d+"', tag) and re.search(r'height="\d+"', tag)
        assert 'loading="lazy"' in tag


def test_from_the_blog_lists_three_newest(client):
    posts = blog.load_posts(blog.DEFAULT_DIR)
    assert len(posts) >= blog.HOME_POSTS
    section = re.search(r'<section id="from-blog".*?</section>', home(client), re.S).group(0)
    hrefs = re.findall(r'<a class="post-card" href="([^"]+)"', section)
    assert hrefs == [p.path for p in posts[:blog.HOME_POSTS]]
    assert 'href="/blog"' in section


def test_no_posts_no_section(empty_client):
    assert "From the blog" not in home(empty_client)
    assert 'id="from-blog"' not in home(empty_client)


def _pricing(c):
    return re.search(r'<section id="pricing".*?</section>', home(c), re.S).group(0)


def test_pricing_shows_every_price(client):
    sec = html_mod.unescape(_pricing(client))
    for shown in ("\u20b90", "$0", "\u20b9300", "\u20b92,500", "$4.99", "$39.99"):
        assert shown in sec
    # No currency figure on the card that PRICES did not produce.
    found = set(re.findall(r"[\u20b9$]\d[\d,.]*\d|[\u20b9$]\d", sec))
    assert found == {"\u20b90", "$0", "\u20b9300", "\u20b92,500", "$4.99", "$39.99"}


def test_prices_change_follows_single_source(client, monkeypatch):
    monkeypatch.setitem(landing.PRICES["monthly"], "INR", "777")
    monkeypatch.setitem(landing.PRICES["yearly"], "USD", "55.55")
    sec = html_mod.unescape(_pricing(client))
    assert "₹777" in sec and "$55.55" in sec
    assert "₹300" not in sec and "$39.99" not in sec


def test_faq_states_the_real_download_sizes(client):
    h = home(client)
    faq = html_mod.unescape(h[h.index("Questions people actually ask"):])
    assert "96 MB" in faq and "1.3 GB" in faq
    assert "if you ask for it" not in faq
    assert "114 MB" not in faq and "1.1 GB" not in faq


def test_llms_txt_states_the_indian_prices(client):
    t = client.get("/llms.txt").text
    assert "\u20b9300" in t and "\u20b92,500" in t
    assert "299" not in t and "2,499" not in t


def test_reveal_is_gated_on_js():
    css = re.sub(r"/\*.*?\*/", "", (STATIC / "landing.css").read_text(), flags=re.S)
    for m in re.finditer(r"([^{}]*)\{([^{}]*opacity:\s*0[^{}]*)\}", css):
        sel = m.group(1).strip()
        if ".rise" in sel:
            assert sel.startswith("html.js"), sel
    assert "html.js .rise" in css
    assert "classList.add('js')" in HEAD_SCRIPT


def test_blog_index_first_row_is_eager(store, signing_key, tmp_path):
    for i in range(blog.EAGER_CARDS + 1):
        (tmp_path / f"p{i}.md").write_text(
            f"---\ntitle: T{i}\ndescription: D\ndate: 2026-01-0{i + 1}\ncover: c\n---\nBody\n")
    c = TestClient(create_app(store=store, signing_key=signing_key, blog_dir=tmp_path))
    cards = re.findall(r'<a class="post-card".*?</a>', c.get("/blog").text, re.S)
    assert len(cards) == blog.EAGER_CARDS + 1
    for card in cards[:blog.EAGER_CARDS]:
        assert 'loading="lazy"' not in card
    assert 'fetchpriority="high"' in cards[0]
    assert 'fetchpriority' not in cards[1]
    assert 'loading="lazy"' in cards[blog.EAGER_CARDS]


def test_home_blog_cards_stay_lazy(client):
    section = re.search(r'<section id="from-blog".*?</section>', home(client), re.S).group(0)
    assert section.count('loading="lazy"') == blog.HOME_POSTS


def test_card_css_has_one_source():
    cards = (STATIC / "cards.css").read_text()
    assert ".post-card-title" in cards and "(hover: hover)" in cards
    for name in ("landing.css", "blog.css"):
        assert ".post-card" not in (STATIC / name).read_text(), name


def test_both_pages_link_cards_css(client):
    for path in ("/", "/blog"):
        assert 'href="/static/cards.css"' in client.get(path).text
