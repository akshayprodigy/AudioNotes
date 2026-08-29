"""
Minting the tokens the Android app verifies offline.

The other half of this contract is ``billing/Licence.kt``. Both descriptions of the format have to
agree exactly, and neither can be changed alone -- so ``scripts/contract_fixture.py`` mints a token
here and ``LicenceContractTest.kt`` asserts that the Kotlin verifier accepts that exact string. If
either side drifts, one of those two tests fails.

Format::

    <base64url(payload)>.<base64url(signature)>

payload -- ASCII ``k=v`` pairs joined by ``;``, in this order::

    v=1;sub=<account>;plan=<plan>;iat=<unix s>;exp=<unix s>;dev=<device id>

signature -- SHA256withECDSA over the base64url payload TEXT (not the decoded bytes), DER encoded,
which is what Java's ``Signature.getInstance("SHA256withECDSA")`` produces and expects. `cryptography`
emits DER for EC keys; that is load-bearing and is why the contract fixture exists rather than a
comment claiming it works.

Values may contain neither ``;`` nor ``=``, so they are rejected rather than escaped: every field is
an id or a number we generate, so a value needing an escape means something upstream is wrong and
should say so loudly.
"""

from __future__ import annotations

import base64
import os
import re
import time

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

TOKEN_VERSION = 1

#: How long a freshly minted token stays valid -- and therefore how long an offline app keeps working.
DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60

_FORBIDDEN = re.compile(r"[;=]")


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _field(name: str, value: str) -> str:
    if not value:
        raise ValueError(f"licence: {name} is empty")
    if _FORBIDDEN.search(value):
        raise ValueError(f"licence: {name} may not contain ';' or '=' (got {value!r})")
    return value


def mint_token(
    private_key: ec.EllipticCurvePrivateKey,
    *,
    account: str,
    plan: str,
    device_id: str,
    issued_at: int | None = None,
    ttl_seconds: int | None = None,
) -> str:
    """Sign a licence token. ``private_key`` is the P-256 key whose public half ships in the app."""
    issued = int(time.time()) if issued_at is None else issued_at
    ttl = DEFAULT_TTL_SECONDS if ttl_seconds is None else ttl_seconds

    payload = ";".join(
        [
            f"v={TOKEN_VERSION}",
            f"sub={_field('account', account)}",
            f"plan={_field('plan', plan)}",
            f"iat={issued}",
            f"exp={issued + ttl}",
            f"dev={_field('deviceId', device_id)}",
        ]
    )

    body = _b64url(payload.encode("ascii"))
    signature = private_key.sign(body.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    return f"{body}.{_b64url(signature)}"


def public_key_for_app(public_key: ec.EllipticCurvePublicKey) -> str:
    """
    The value that goes into the app's ``licencePublicKey`` Gradle property.

    SubjectPublicKeyInfo DER, base64 -- exactly what Java's X509EncodedKeySpec reads.
    """
    der = public_key.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return base64.b64encode(der).decode("ascii")


def generate_signing_key() -> ec.EllipticCurvePrivateKey:
    """Generate a signing key. Run once, ever; see keygen.py."""
    return ec.generate_private_key(ec.SECP256R1())


def private_key_pem(private_key: ec.EllipticCurvePrivateKey) -> str:
    return private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")


def signing_key_from_env(env: dict[str, str] | None = None) -> ec.EllipticCurvePrivateKey:
    """
    Load the signing key from the environment.

    PEM in an env var rather than a file on disk: the key must never be a build artifact or a git
    object, and every host worth using injects secrets this way. Raises loudly on a missing key -- a
    licence server that starts without one would mint nothing and fail per-request instead, which is
    a worse place to find out.
    """
    source = os.environ if env is None else env
    pem = source.get("LICENCE_PRIVATE_KEY_PEM")
    if not pem:
        raise RuntimeError(
            "LICENCE_PRIVATE_KEY_PEM is not set. Generate one with `python -m app.keygen` and put "
            "the private half in the environment -- never in the repository."
        )
    # Tolerate the key arriving with escaped newlines, which is how most secret managers and
    # .env files hand back a multi-line value.
    text = pem.replace("\\n", "\n") if "\\n" in pem else pem
    key = serialization.load_pem_private_key(text.encode("ascii"), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise RuntimeError("LICENCE_PRIVATE_KEY_PEM is not an EC private key")
    return key
