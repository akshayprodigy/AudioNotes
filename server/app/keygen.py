"""
Generate the licence signing key pair. Run once, ever.

    python -m app.keygen

The private half signs every token and belongs only in the licence server's environment. The public
half is compiled into the Android app, so changing it later means every installed copy stops
accepting tokens until it updates -- treat this key as permanent.
"""

from .licence import generate_signing_key, private_key_pem, public_key_for_app


def main() -> None:
    private_key = generate_signing_key()
    pem = private_key_pem(private_key)

    print("--- PRIVATE KEY - licence server environment only, never commit ---\n")
    print("LICENCE_PRIVATE_KEY_PEM=" + repr(pem).replace("'", '"'))
    print("\n--- PUBLIC KEY - android/gradle.properties ---\n")
    print("licencePublicKey=" + public_key_for_app(private_key.public_key()))
    print("\nStore the private key in your host's secret manager now. It is not written to disk.")


if __name__ == "__main__":
    main()
