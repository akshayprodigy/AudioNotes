"""
Sending email, of which there is exactly one kind: a password reset link.

Deliberately small. This server has no newsletter, no receipts, no onboarding sequence and no
marketing, so there is no template engine and no queue — one function that sends one message.

Unconfigured, it logs the message instead of sending it and says so loudly. That keeps the whole
reset flow runnable and testable before SMTP credentials exist, without ever pretending a mail was
delivered when it was not.
"""

from __future__ import annotations

import logging
import os
import smtplib
import ssl
from email.message import EmailMessage

log = logging.getLogger("audionotes.mail")


def is_configured() -> bool:
    return bool(os.environ.get("SMTP_HOST") and os.environ.get("SMTP_FROM"))


def public_base_url(fallback: str) -> str:
    """
    The origin to put in links we email.

    Explicit configuration wins over the request's own Host header. A link built from an
    attacker-supplied Host is how a password reset email ends up pointing at somebody else's
    server, and the recipient has no way to tell.
    """
    return (os.environ.get("PUBLIC_BASE_URL") or fallback).rstrip("/")


def send(to: str, subject: str, body: str) -> bool:
    """
    Send one plain-text message. Returns whether it actually went out.

    Plain text and not HTML: a reset link is a URL, HTML mail is more likely to be treated as spam
    or mangled by a client, and there is nothing here to lay out.
    """
    host = os.environ.get("SMTP_HOST")
    sender = os.environ.get("SMTP_FROM")

    if not host or not sender:
        log.warning(
            "SMTP is not configured (SMTP_HOST, SMTP_FROM) — this message was NOT sent.\n"
            "--- to: %s\n--- subject: %s\n%s",
            to, subject, body,
        )
        return False

    message = EmailMessage()
    message["From"] = sender
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)

    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASSWORD")

    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=20,
                                  context=ssl.create_default_context()) as smtp:
                if user and password:
                    smtp.login(user, password)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(host, port, timeout=20) as smtp:
                # STARTTLS always: this carries a credential that grants account access, and a
                # provider that cannot do TLS on 587 is one to stop using rather than work around.
                smtp.starttls(context=ssl.create_default_context())
                if user and password:
                    smtp.login(user, password)
                smtp.send_message(message)
        return True
    except Exception:
        # Never propagate. The caller is a page that must answer identically whether or not the
        # address exists, and a stack trace on screen would answer it.
        log.exception("could not send mail to %s", to)
        return False
