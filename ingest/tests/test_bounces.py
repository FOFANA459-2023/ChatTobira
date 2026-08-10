"""Bounce parsing and revocation decisions — no IMAP, no database."""

from __future__ import annotations

from datetime import UTC, datetime
from email.message import EmailMessage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from ingest.bounces import bounced_recipients, should_revoke

SENDER = "varleesfofana9@gmail.com"


def _dsn_bounce(final_recipient: str) -> MIMEMultipart:
    """A structured DSN the way Gmail's mailer-daemon actually builds one."""
    outer = MIMEMultipart("report", **{"report-type": "delivery-status"})
    outer["From"] = "Mail Delivery Subsystem <mailer-daemon@googlemail.com>"
    outer["To"] = SENDER
    outer["Date"] = "Sun, 10 Aug 2026 04:00:00 +0000"
    outer.attach(MIMEText("Address not found. Your message wasn't delivered.", "plain"))

    status = EmailMessage()
    status["Content-Type"] = "message/delivery-status"
    status.set_payload(
        [
            EmailMessage(),
        ]
    )
    status.get_payload()[0]["Final-Recipient"] = f"rfc822; {final_recipient}"
    status.get_payload()[0]["Action"] = "failed"
    outer.attach(status)
    return outer


def test_reads_final_recipient_from_delivery_status():
    message = _dsn_bounce("st0001ab@apu.ac.jp")
    assert bounced_recipients(message, SENDER) == ["st0001ab@apu.ac.jp"]


def test_falls_back_to_body_scan_and_ignores_the_sender():
    message = EmailMessage()
    message["From"] = "Mail Delivery Subsystem <mailer-daemon@googlemail.com>"
    message["Date"] = "Sun, 10 Aug 2026 04:00:00 +0000"
    message.set_content(
        f"Your message to st0002cd@apu.ac.jp was rejected by the remote server.\n"
        f"Return path: {SENDER}"
    )
    assert bounced_recipients(message, SENDER) == ["st0002cd@apu.ac.jp"]


def test_case_and_duplicates_collapse():
    message = EmailMessage()
    message["From"] = "mailer-daemon@googlemail.com"
    message.set_content(
        "Delivery failed: ST0003EF@APU.AC.JP\nRecipient: st0003ef@apu.ac.jp could not be reached."
    )
    assert bounced_recipients(message, SENDER) == ["st0003ef@apu.ac.jp"]


def test_should_revoke_only_fresh_bounces_for_unconfirmed_students():
    invited = datetime(2026, 8, 10, 3, 0, tzinfo=UTC)
    fresh = datetime(2026, 8, 10, 4, 0, tzinfo=UTC)
    stale = datetime(2026, 8, 9, 4, 0, tzinfo=UTC)

    assert should_revoke(fresh, invited, confirmed=False) is True
    # A re-invited student must not be killed by last week's bounce…
    assert should_revoke(stale, invited, confirmed=False) is False
    # …and a student who has signed in outranks any bounce.
    assert should_revoke(fresh, invited, confirmed=True) is False
