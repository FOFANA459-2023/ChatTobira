"""Promote admin-approved student uploads into the corpus.

The web app extracts an upload's text the moment it arrives, so the student
can ask about it immediately. That extraction is stored on the row, which
means this stage never has to transcribe the file a second time — it writes
the same .work/text transcript the vision pipeline would have produced and
lets the normal chunk/embed/push path take over from there. One vision call
per document, total.

The file is written into MATERIALS_ROOT under a folder carrying its level and
topic, because discover() derives both from the path, not from a database
column. That keeps a promoted upload indistinguishable from a handout the
admin filed by hand — which is the point: after this runs, nothing downstream
needs to know where the document came from.

Student uploads are never citable: CITABLE_SOURCES lists the textbooks only,
so an approved upload grounds answers exactly like a class handout and is
never quoted as a printed page.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import httpx

from .config import CONFIG
from .japanese import has_cjk

UPLOAD_BUCKET = "chattobira-uploads"

LEVEL_FOLDER = {"F2": "Foundation 2", "F3": "Foundation 3", "INT": "Intermediate"}

_UNSAFE = str.maketrans({c: "-" for c in '\\/:*?"<>|'})


@dataclass(frozen=True)
class ApprovedUpload:
    id: int
    filename: str
    content_type: str
    storage_path: str
    level: str
    topic: str | None
    extracted: str


def client() -> httpx.Client:
    key = CONFIG.supabase_service_key
    return httpx.Client(
        base_url=CONFIG.supabase_url,
        headers={"Authorization": f"Bearer {key}", "apikey": key},
        timeout=httpx.Timeout(600, connect=30),
    )


def download(http: httpx.Client, key: str) -> bytes:
    response = http.get(f"/storage/v1/object/{UPLOAD_BUCKET}/{quote(key, safe='/')}")
    if response.status_code != 200:
        raise RuntimeError(f"download failed for {key}: {response.status_code} {response.text}")
    return response.content


def safe_filename(name: str) -> str:
    """Mirror of safeFilename in web/lib/uploads.ts.

    The two must agree, because the admin is shown the destination path in
    the review queue before approving and it would be a poor sort of review
    if the file then landed somewhere else.
    """
    cleaned = " ".join(name.translate(_UNSAFE).split()).strip()[:120]
    # A name carrying no letter or digit is not a name, and the dangerous
    # cases live exactly there: ".." survives separator-stripping intact and
    # would still mean "the parent directory" when this is joined onto
    # MATERIALS_ROOT. This side is the one that actually writes to disk, so
    # it does not rely on the browser having sanitised anything.
    return cleaned if any(c.isalnum() for c in cleaned) else "upload"


def corpus_path(level: str, topic: str | None, filename: str) -> str:
    """Mirror of corpusPath in web/lib/uploads.ts."""
    folder = f"{topic} Student uploads" if topic else "Student uploads"
    return f"{LEVEL_FOLDER[level]}/{folder}/{safe_filename(filename)}"


def fetch_approved() -> list[ApprovedUpload]:
    """Rows the admin has cleared and the pipeline has not yet ingested."""
    from . import store

    with store.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            select id, filename, content_type, storage_path, level, topic, extracted
              from uploads
             where status = 'approved'
               and extracted is not null
               and level is not null
             order by created_at
            """
        )
        return [
            ApprovedUpload(
                id=r[0],
                filename=r[1],
                content_type=r[2],
                storage_path=r[3],
                level=r[4],
                topic=r[5],
                extracted=r[6],
            )
            for r in cur.fetchall()
        ]


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_transcript(sha: str, extracted: str) -> Path:
    """Store the web app's extraction as the document's transcript.

    Shaped exactly like transcribe's output so `push` cannot tell the
    difference. book_page is null because a photograph of a handout has no
    printed folio to send a student to, and inventing one would produce a
    citation that points nowhere.
    """
    CONFIG.ensure_dirs()
    path = CONFIG.text_dir / f"{sha[:12]}.json"
    page = {
        "pdf_page": 1,
        "markdown": extracted,
        "book_page": None,
        "grammar_points": [],
        "has_japanese": has_cjk(extracted),
    }
    path.write_text(json.dumps([page], ensure_ascii=False, indent=1), "utf-8")
    return path


def materialise(http: httpx.Client, upload: ApprovedUpload) -> tuple[Path, str]:
    """Download the file into the materials tree; return its path and hash."""
    data = download(http, upload.storage_path)
    if not data:
        raise RuntimeError(f"upload {upload.id} is empty in storage")

    relative = corpus_path(upload.level, upload.topic, upload.filename)
    target = CONFIG.materials_root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return target, sha256_of(data)


def mark_ingested(upload_id: int, document_id: int, sha: str) -> None:
    from . import store

    with store.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            update uploads
               set status = 'ingested', document_id = %s, content_sha = %s
             where id = %s
            """,
            (document_id, sha, upload_id),
        )
        conn.commit()
