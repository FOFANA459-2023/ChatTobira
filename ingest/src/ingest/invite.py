"""Allowlist management.

Signup is rejected by a database trigger for any email not present in the
allowlist table, so inviting students is a data operation, not a deploy.
"""

from __future__ import annotations

import re

from . import store

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def add(emails: list[str], note: str | None = None, invited_by: str | None = None) -> list[str]:
    """Add emails to the allowlist. Returns the ones actually added."""
    cleaned: list[str] = []
    for raw in emails:
        email = raw.strip().lower()
        if not email:
            continue
        if not _EMAIL_RE.match(email):
            raise ValueError(f"not a valid email address: {raw!r}")
        cleaned.append(email)

    added: list[str] = []
    with store.connect() as conn:
        with conn.cursor() as cur:
            for email in cleaned:
                cur.execute(
                    """
                    insert into allowlist (email, note, invited_by)
                    values (%s, %s, %s)
                    on conflict (email) do nothing
                    returning email
                    """,
                    (email, note, invited_by),
                )
                if cur.fetchone() is not None:
                    added.append(email)
        conn.commit()
    return added


def remove(email: str) -> bool:
    """Remove an email from the allowlist. Existing accounts keep working;
    this only blocks new signups."""
    with store.connect() as conn:
        with conn.cursor() as cur:
            cur.execute("delete from allowlist where email = %s", (email.strip().lower(),))
            removed = cur.rowcount > 0
        conn.commit()
    return removed


def list_all() -> list[dict]:
    with store.connect() as conn, conn.cursor() as cur:
        cur.execute("select email, note, invited_by, created_at from allowlist order by created_at")
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
