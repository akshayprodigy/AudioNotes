"""
The token format, checked from the outside.

These assertions describe the wire format the Android verifier reads. They cannot prove the Kotlin
side agrees -- only LicenceContractTest.kt can, against a token this server actually minted -- but
they catch a format change here before it reaches that fixture.
"""

import base64

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from app.licence import (
    DEFAULT_TTL_SECONDS,
    generate_signing_key,
    mint_token,
    public_key_for_app,
    signing_key_from_env,
    private_key_pem,
)


def _decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def test_payload_is_the_documented_field_order(signing_key):
    token = mint_token(
        signing_key, account="acct_1", plan="pro", device_id="dev_1", issued_at=1000, ttl_seconds=60
    )
    body, _, _sig = token.partition(".")
    assert _decode(body).decode("ascii") == "v=1;sub=acct_1;plan=pro;iat=1000;exp=1060;dev=dev_1"


def test_signature_is_over_the_base64url_text_not_the_decoded_bytes(signing_key):
    """The choice neither side can observe in the other. Getting it wrong fails only on a device."""
    token = mint_token(signing_key, account="a", plan="pro", device_id="d", issued_at=1, ttl_seconds=1)
    body, _, sig = token.partition(".")
    public = signing_key.public_key()

    public.verify(_decode(sig), body.encode("ascii"), ec.ECDSA(hashes.SHA256()))

    with pytest.raises(InvalidSignature):
        public.verify(_decode(sig), _decode(body), ec.ECDSA(hashes.SHA256()))


def test_signature_is_der_which_is_what_java_expects(signing_key):
    """A DER SEQUENCE starts 0x30. IEEE-P1363 (raw r||s) does not, and Java rejects it."""
    _, _, sig = mint_token(
        signing_key, account="a", plan="pro", device_id="d", issued_at=1, ttl_seconds=1
    ).partition(".")
    assert _decode(sig)[0] == 0x30


def test_base64url_is_unpadded_and_url_safe(signing_key):
    token = mint_token(
        signing_key, account="acct_padding_x", plan="pro", device_id="d", issued_at=1, ttl_seconds=1
    )
    assert "=" not in token
    assert "+" not in token and "/" not in token


def test_public_key_is_spki_der_base64(signing_key):
    encoded = public_key_for_app(signing_key.public_key())
    der = base64.b64decode(encoded)
    # Round-trips through the same loader Java's X509EncodedKeySpec is modelled on.
    from cryptography.hazmat.primitives.serialization import load_der_public_key

    assert isinstance(load_der_public_key(der), ec.EllipticCurvePublicKey)


def test_a_tampered_payload_does_not_verify(signing_key):
    token = mint_token(signing_key, account="a", plan="pro", device_id="d", issued_at=1, ttl_seconds=1)
    body, _, sig = token.partition(".")
    forged = base64.urlsafe_b64encode(b"v=1;sub=a;plan=pro;iat=1;exp=99999999999;dev=d").decode().rstrip("=")
    with pytest.raises(InvalidSignature):
        signing_key.public_key().verify(
            _decode(sig), forged.encode("ascii"), ec.ECDSA(hashes.SHA256())
        )


@pytest.mark.parametrize("bad", ["has;semicolon", "has=equals", ""])
def test_values_that_would_need_escaping_are_refused(signing_key, bad):
    """Every field is an id we generate, so one needing an escape means something upstream is wrong."""
    with pytest.raises(ValueError):
        mint_token(signing_key, account=bad, plan="pro", device_id="d")


def test_default_ttl_is_a_fortnight(signing_key):
    token = mint_token(signing_key, account="a", plan="pro", device_id="d", issued_at=0)
    body, _, _ = token.partition(".")
    assert f"exp={DEFAULT_TTL_SECONDS}" in _decode(body).decode("ascii")


def test_signing_key_from_env_accepts_escaped_newlines():
    """How every secret manager and .env file hands back a multi-line value."""
    pem = private_key_pem(generate_signing_key())
    loaded = signing_key_from_env({"LICENCE_PRIVATE_KEY_PEM": pem.replace("\n", "\\n")})
    assert isinstance(loaded, ec.EllipticCurvePrivateKey)


def test_a_server_with_no_signing_key_refuses_to_start():
    """Failing per-request instead would be a worse place to find out."""
    with pytest.raises(RuntimeError, match="LICENCE_PRIVATE_KEY_PEM"):
        signing_key_from_env({})
