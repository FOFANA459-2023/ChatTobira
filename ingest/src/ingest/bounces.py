"""Bounce sweep: revoke invites whose email provably never arrived.

The invite API can only see the SMTP handshake — Gmail says "accepted" and the
API reports success, then the university gateway rejects the message minutes
later. That rejection lands as a mailer-daemon bounce in the SENDING Gmail
inbox, which this module reads over IMAP. Any allowlisted student whose invite
bounced after they were invited, and who has never signed in, is removed —
the invited list stays a list of students who can actually be reached.

Runs from `ingest bounces` locally or on the scheduled GitHub Action; both
are idempotent, and a student re-invited after an old bounce is safe because
only bounces NEWER than their current invite count.
"""

from __future__ import annotations

import email
import email.utils
import imaplib
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.message import Message

from .config import CONFIG

IMAP_HOST = "imap.gmail.com"

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Final-Recipient: rfc822; student@apu.ac.jp  (the DSN's authoritative field)
_RECIPIENT_HEADER_RE = re.compile(
    r"(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*([^\s;]+@[^\s;]+)", re.IGNORECASE
)


@dataclass(frozen=True)
class Bounce:
    recipient: str
    bounced_at: datetime


def _text_of(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    return payload.decode(charset, errors="replace")


def bounced_recipients(message: Message, sender: str) -> list[str]:
    """Addresses a bounce message says failed.

    The message/delivery-status part is authoritative when present; otherwise
    any address mentioned in the bounce body counts, except the sender's own.
    """
    found: list[str] = []

    for part in message.walk():
        if part.get_content_type() == "message/delivery-status":
            for sub in part.get_payload() if isinstance(part.get_payload(), list) else []:
                for header in ("Final-Recipient", "Original-Recipient"):
                    value = sub.get(header, "")
                    if m := _EMAIL_RE.search(value):
                        found.append(m.group(0).lower())

    if not found:
        for part in message.walk():
            if part.get_content_type() in ("text/plain", "text/html"):
                for m in _RECIPIENT_HEADER_RE.finditer(_text_of(part)):
                    found.append(m.group(1).lower())
        if not found:
            for part in message.walk():
                if part.get_content_type() == "text/plain":
                    found.extend(a.lower() for a in _EMAIL_RE.findall(_text_of(part)))

    sender = sender.lower()
    return [a for a in dict.fromkeys(found) if a != sender and "mailer-daemon" not in a]


def should_revoke(
    bounced_at: datetime,
    invited_at: datetime,
    confirmed: bool,
) -> bool:
    """A bounce revokes an invite only when it postdates the CURRENT invite
    (a re-invited student must not be killed by last week's bounce) and the
    student has never signed in (a working account outranks any bounce)."""
    return not confirmed and bounced_at >= invited_at


def fetch_bounces(days: int = 7) -> list[Bounce]:
    """Mailer-daemon bounces from the sending inbox, newest window only."""
    since = (datetime.now(UTC) - timedelta(days=days)).strftime("%d-%b-%Y")
    bounces: list[Bounce] = []

    with imaplib.IMAP4_SSL(IMAP_HOST) as imap:
        imap.login(CONFIG.smtp_sender, CONFIG.smtp_app_password)
        imap.select("INBOX", readonly=True)
        status, data = imap.search(None, f'(SINCE {since} FROM "mailer-daemon")')
        if status != "OK":
            raise RuntimeError(f"IMAP search failed: {status}")

        for num in data[0].split():
            status, parts = imap.fetch(num, "(RFC822)")
            if status != "OK" or not parts or parts[0] is None:
                continue
            message = email.message_from_bytes(parts[0][1])
            date = email.utils.parsedate_to_datetime(message.get("Date", ""))
            if date is None:
                continue
            if date.tzinfo is None:
                date = date.replace(tzinfo=UTC)
            for recipient in bounced_recipients(message, CONFIG.smtp_sender):
                bounces.append(Bounce(recipient=recipient, bounced_at=date))

    return bounces


def sweep(bounces: list[Bounce]) -> list[str]:
    """Remove allowlist rows + unconfirmed auth accounts for fresh bounces.

    Returns the emails revoked. Confirmed accounts are never touched.
    """
    from . import store

    if not bounces:
        return []

    revoked: list[str] = []
    with store.connect() as conn, conn.cursor() as cur:
        for bounce in bounces:
            cur.execute(
                """
                select a.created_at, u.email_confirmed_at is not null or u.last_sign_in_at is not null
                  from allowlist a
                  left join auth.users u on lower(u.email) = lower(a.email)
                 where lower(a.email) = lower(%s)
                """,
                (bounce.recipient,),
            )
            row = cur.fetchone()
            if row is None:
                continue
            invited_at, confirmed = row[0], bool(row[1])
            if not should_revoke(bounce.bounced_at, invited_at, confirmed):
                continue

            cur.execute(
                """
                delete from auth.users
                 where lower(email) = lower(%s)
                   and email_confirmed_at is null
                   and last_sign_in_at is null
                """,
                (bounce.recipient,),
            )
            cur.execute("delete from allowlist where lower(email) = lower(%s)", (bounce.recipient,))
            revoked.append(bounce.recipient)
        conn.commit()

    return list(dict.fromkeys(revoked))
