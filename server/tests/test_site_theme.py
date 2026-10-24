"""Light by default, dark on request, one toggle on every page."""

import json
import re
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.pages import CSS
from app.theme import HEAD_SCRIPT

PAGES = ["/", "/privacy", "/terms", "/delete-account"]


@pytest.fixture
def client(store, signing_key):
    return TestClient(create_app(store=store, signing_key=signing_key))


def head_script(html):
    head = html.split("</head>")[0]
    m = re.search(r"<script>(.*?)</script>", head, re.S)
    assert m, "no inline theme script in <head>"
    return m.group(1)


@pytest.mark.parametrize("path", PAGES)
def test_every_page_has_the_head_script_and_a_toggle(client, path):
    html = client.get(path).text
    assert "dataset.theme" in head_script(html)
    assert 'data-theme-toggle' in html
    assert 'aria-label="Dark theme"' in html and "Switch to" not in html.split("<body")[1]
    assert '<noscript><style>.theme-toggle{display:none}' in html
    assert '<meta name="theme-color" content="#FAFBFE">' in html
    assert 'aria-pressed="false"' in html
    assert '/static/theme.js' in html
    assert 'name="theme-color"' in html


@pytest.mark.parametrize("path", PAGES)
def test_the_head_script_defaults_to_light(client, path):
    script = head_script(client.get(path).text)
    assert "var t='light'" in script
    assert "var t='dark'" not in script


def test_the_head_script_only_accepts_known_values_from_query_and_storage(client):
    script = head_script(client.get("/").text)
    assert "get('theme')" in script
    assert script.count("==='dark'||") >= 2  # query and storage are both validated
    assert "try{" in script and "catch" in script


def test_no_stylesheet_follows_the_operating_system(client):
    landing = client.get("/static/landing.css").text
    assert "prefers-color-scheme" not in landing
    assert "prefers-color-scheme" not in CSS
    assert ':root[data-theme="dark"]' in landing
    assert ':root[data-theme="dark"]' in CSS
    assert "color-scheme: light dark" not in landing + CSS


def test_landing_js_reads_the_attribute_not_the_media_query(client):
    js = client.get("/static/landing.js").text
    assert "prefers-color-scheme" not in js
    assert "data-theme" in js and "MutationObserver" in js


def test_theme_js_is_served_and_updates_storage_and_meta(client):
    js = client.get("/static/theme.js").text
    assert "localStorage.setItem('verbale-theme'" in js and "theme-color" in js


# ---- the head script, actually executed ----

NODE = shutil.which("node")
HARNESS = """
const [search, stored, throws] = JSON.parse(process.env.ARGS);
const writes = {};
const data = stored === null ? {} : {'verbale-theme': stored};
const meta = {content: ''};
globalThis.location = {search};
globalThis.localStorage = {
  getItem(k) { if (throws) throw new Error('blocked'); return k in data ? data[k] : null; },
  setItem(k, v) { if (throws) throw new Error('blocked'); writes[k] = v; data[k] = v; },
};
const root = {dataset: {}};
globalThis.document = {documentElement: root, querySelector: () => meta};
eval(process.env.SCRIPT);
console.log(JSON.stringify({theme: root.dataset.theme, writes, meta: meta.content}));
"""


def run_head(search="", stored=None, throws=False):
    if not NODE:
        pytest.skip("node is not installed")
    script = HEAD_SCRIPT.removeprefix("<script>").removesuffix("</script>")
    out = subprocess.run([NODE, "-e", HARNESS], capture_output=True, text=True, check=True,
                         env={"ARGS": json.dumps([search, stored, throws]), "SCRIPT": script}).stdout
    return json.loads(out)


def test_executed_no_param_no_storage_is_light():
    r = run_head()
    assert r["theme"] == "light" and r["meta"] == "#FAFBFE"


def test_executed_query_dark_wins_and_is_stored():
    r = run_head("?theme=dark")
    assert r["theme"] == "dark" and r["writes"] == {"verbale-theme": "dark"}
    assert r["meta"] == "#0A0C15"


def test_executed_unknown_query_value_is_ignored():
    r = run_head("?theme=evil")
    assert r["theme"] == "light" and r["writes"] == {}


def test_executed_stored_dark_is_used():
    assert run_head(stored="dark")["theme"] == "dark"


def test_executed_unknown_stored_value_is_ignored():
    assert run_head(stored="evil")["theme"] == "light"


def test_executed_throwing_storage_still_comes_up_light():
    assert run_head(throws=True)["theme"] == "light"
