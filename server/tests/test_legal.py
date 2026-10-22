"""The public terms page says what the founder decided about payments."""
from fastapi.testclient import TestClient

from app.main import create_app


def test_terms_say_payments_are_final(store, signing_key):
    client = TestClient(create_app(store=store, signing_key=signing_key))
    r = client.get("/terms")
    assert r.status_code == 200
    body = r.text
    assert "Payments are final" in body
    assert "monthly or yearly" in body
    assert "free for 7 days" in body
    assert "22 October 2026" in body
    assert "within 7 days of a charge" not in body
    # The source wraps lines, so compare with whitespace collapsed.
    flat = " ".join(body.split())
    assert "refund Google Play gives under its own refund policy" in flat
    assert "consumer law where you live" in flat
