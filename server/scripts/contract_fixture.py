"""
Regenerate the fixture pinned by LicenceContractTest.kt.

    python scripts/contract_fixture.py

Starts the server on a throwaway port with a throwaway key, seeds one paid account, and signs in
over real HTTP. The token that comes back is the fixture. Going through a socket rather than calling
mint_token directly is the point: it exercises routing, JSON serialisation, the entitlement
decision and the signing key exactly as a phone would meet them.

Paste the output into android/app/src/test/java/com/audionotes/billing/LicenceContractTest.kt. Only
needed when the token format itself changes -- which is the moment both sides must be checked
against each other again, which is the point of the fixture.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.licence import generate_signing_key, private_key_pem, public_key_for_app  # noqa: E402
from app.store import Store, Subscription  # noqa: E402

PORT = 8799
EMAIL, PASSWORD, DEVICE = "contract@example.com", "password123", "device-contract"
PERIOD_END = 2_000_000_000


def post(path: str, body: dict) -> dict:
    request = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def main() -> int:
    key = generate_signing_key()
    tmp = tempfile.mkdtemp()
    db = os.path.join(tmp, "contract.db")

    store = Store(db)
    account = store.create_account(EMAIL, PASSWORD)
    store.upsert_subscription(
        Subscription(account_id=account.id, plan="pro", provider_id="sub_contract",
                     status="active", current_period_end=PERIOD_END)
    )
    store.close()

    env = {**os.environ, "LICENCE_PRIVATE_KEY_PEM": private_key_pem(key), "DATABASE_PATH": db}
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:create_app", "--factory",
         "--host", "127.0.0.1", "--port", str(PORT), "--log-level", "warning"],
        env=env, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/healthz", timeout=1).read()
                break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.1)
        else:
            print("server did not come up", file=sys.stderr)
            return 1

        body = post("/api/account/signin",
                    {"email": EMAIL, "password": PASSWORD, "deviceId": DEVICE})
    finally:
        server.terminate()
        server.wait(timeout=10)

    token = body["token"]
    if not token:
        print("the server issued no token -- the seeded subscription is not entitled", file=sys.stderr)
        return 1

    payload = token.partition(".")[0]
    import base64

    decoded = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode()
    claims = dict(p.split("=", 1) for p in decoded.split(";"))

    print("publicKey: ", public_key_for_app(key.public_key()))
    print("token:     ", token)
    print("account:   ", claims["sub"])
    print("device:    ", DEVICE)
    print("window:    ", claims["iat"], "->", claims["exp"])
    print("payload:   ", decoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
