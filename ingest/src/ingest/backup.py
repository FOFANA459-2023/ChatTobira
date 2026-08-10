"""Off-machine durability: mirror sources and transcripts to Supabase Storage.

The deployed app (Cloudflare + Supabase) never touches this laptop, but the
source PDFs and the .work transcription cache existed only here — losing the
machine would mean re-collecting the PDFs and re-paying weeks of vision quota
for transcripts. `ingest backup` mirrors both into a PRIVATE storage bucket;
`ingest restore` pulls them back down so a fresh machine can run `ingest push`
immediately, with no re-transcription.

The bucket is private and nothing in the web app reads it: it is a backup,
not a file host. Uploads are recorded in the manifest keyed by content hash,
so re-running backup after editing one handout uploads only that handout.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import httpx

from .config import CONFIG
from .discover import discover
from .manifest import Manifest

# Bucket layout: objects live under CONTENT-ADDRESSED keys —
# materials/<sha12><suffix> and work/text/<sha12>.json — because Storage
# rejects keys with characters the real filenames contain (seen live: the
# combining dakuten in T7G5たいです.pdf, NFD-decomposed, came back 400
# InvalidKey). index.json at the bucket root maps each object back to the
# logical path restore writes it to; work/manifest.json rides along verbatim.
INDEX_KEY = "index.json"

_CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".json": "application/json",
}


@dataclass(frozen=True)
class BackupItem:
    path: str  # logical path: "materials/<rel>" or "work/text/<name>"
    object_key: str  # ASCII-safe object key in the bucket
    local: Path
    sha: str
    size: int


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def client() -> httpx.Client:
    key = CONFIG.supabase_service_key
    return httpx.Client(
        base_url=CONFIG.supabase_url,
        headers={"Authorization": f"Bearer {key}", "apikey": key},
        # A 20MB PDF over hotel wifi is slow, not stuck.
        timeout=httpx.Timeout(600, connect=30),
    )


def ensure_bucket(http: httpx.Client) -> None:
    bucket = CONFIG.backup_bucket
    if http.get(f"/storage/v1/bucket/{bucket}").status_code == 200:
        return
    response = http.post(
        "/storage/v1/bucket",
        json={"id": bucket, "name": bucket, "public": False},
    )
    if response.status_code not in (200, 201):
        raise RuntimeError(f"could not create bucket '{bucket}': {response.text}")


def upload(http: httpx.Client, key: str, data: bytes, content_type: str) -> None:
    response = http.post(
        f"/storage/v1/object/{CONFIG.backup_bucket}/{quote(key, safe='/')}",
        content=data,
        headers={"Content-Type": content_type, "x-upsert": "true"},
    )
    if response.status_code not in (200, 201):
        raise RuntimeError(f"upload failed for {key}: {response.status_code} {response.text}")


def download(http: httpx.Client, key: str) -> bytes:
    response = http.get(f"/storage/v1/object/{CONFIG.backup_bucket}/{quote(key, safe='/')}")
    if response.status_code != 200:
        raise RuntimeError(f"download failed for {key}: {response.status_code} {response.text}")
    return response.content


def _uploaded(manifest: Manifest, item: BackupItem) -> bool:
    """Already in the bucket, under the object key this plan expects.

    The object-key check matters for migration: the first backup run stored
    objects under raw filename keys until a Japanese filename hit InvalidKey.
    Those manifest entries carry no object_key, so they re-plan as uploads and
    the corpus converges on content-addressed keys.
    """
    entry = manifest.get("backup", item.path)
    return bool(entry) and entry.get("sha") == item.sha and entry.get("object") == item.object_key


def plan_backup(manifest: Manifest) -> tuple[list[BackupItem], list[BackupItem]]:
    """Everything the bucket should hold, split into (to_upload, unchanged).

    Sources are keyed by the hash discover() already computed; transcripts are
    hashed here. The manifest's 'backup' stage records what the bucket already
    has, so an unchanged corpus re-plans to zero uploads.
    """
    items: list[BackupItem] = []

    for doc in discover():
        suffix = Path(doc.path).suffix.lower()
        items.append(
            BackupItem(
                path=f"materials/{doc.path}",
                object_key=f"materials/{doc.content_sha[:12]}{suffix}",
                local=CONFIG.materials_root / doc.path,
                sha=doc.content_sha,
                size=doc.size_bytes,
            )
        )

    if CONFIG.text_dir.exists():
        for path in sorted(CONFIG.text_dir.glob("*.json")):
            sha = _sha256(path)
            items.append(
                BackupItem(
                    path=f"work/text/{path.name}",
                    # Transcript names are already hex-of-content, but keyed by
                    # the file's own hash so an edited checkpoint re-uploads.
                    object_key=f"work/text/{sha[:12]}.json",
                    local=path,
                    sha=sha,
                    size=path.stat().st_size,
                )
            )

    to_upload = [i for i in items if not _uploaded(manifest, i)]
    unchanged = [i for i in items if _uploaded(manifest, i)]
    return to_upload, unchanged


def write_index(http: httpx.Client, items: list[BackupItem]) -> None:
    """index.json is what makes restore possible: Storage's list endpoint is
    folder-by-folder, but a restore needs the flat truth in one read — and the
    object keys are content hashes, so only the index knows the real paths."""
    index = [
        {"path": i.path, "object": i.object_key, "sha": i.sha, "size": i.size} for i in items
    ]
    upload(
        http,
        INDEX_KEY,
        json.dumps(index, ensure_ascii=False, indent=1).encode(),
        "application/json",
    )


def content_type_of(key: str) -> str:
    return _CONTENT_TYPES.get(Path(key).suffix.lower(), "application/octet-stream")


def delete(http: httpx.Client, key: str) -> None:
    """Best-effort removal — used only to clean up objects from the aborted
    raw-filename key scheme. A failure leaves an orphan, never breaks backup."""
    http.delete(f"/storage/v1/object/{CONFIG.backup_bucket}/{quote(key, safe='/')}")


def restore_target(path: str) -> Path | None:
    """Local path a logical index path restores to, or None for metadata.

    Paths come from index.json in the bucket; anything that would escape the
    materials or work directories is rejected rather than written.
    """
    parts = path.split("/")
    if ".." in parts or path.startswith("/") or ":" in path:
        raise RuntimeError(f"refusing suspicious restore path: {path!r}")
    if path.startswith("materials/"):
        return CONFIG.materials_root / path.removeprefix("materials/")
    if path.startswith("work/"):
        return CONFIG.work_dir / path.removeprefix("work/")
    return None
