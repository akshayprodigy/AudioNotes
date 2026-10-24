"""Light by default, dark on request, one toggle on every page."""

import re

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.pages import CSS

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
    assert 'aria-label="Switch to dark theme"' in html
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
    assert "localStorage.setItem('theme'" in js and "theme-color" in js
