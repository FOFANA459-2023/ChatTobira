"""Backup planning and restore-path mapping.

Network behaviour is exercised against an in-memory httpx transport; nothing
here talks to a real bucket.
"""

from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

from ingest.manifest import Manifest


@pytest.fixture()
def backup_env(materials_root: Path, monkeypatch: pytest.MonkeyPatch):
    import ingest.backup as backup_module
    import ingest.config as config_module

    monkeypatch.setattr(backup_module, "CONFIG", config_module.Config())
    text_dir = backup_module.CONFIG.text_dir
    text_dir.mkdir(parents=True, exist_ok=True)
    (text_dir / "abc123def456.json").write_text('[{"pdf_page": 1}]', "utf-8")
    return backup_module


def _mark_all(backup_module, manifest: Manifest) -> int:
    to_upload, _ = backup_module.plan_backup(manifest)
    for item in to_upload:
        manifest.mark("backup", item.path, item.sha, object=item.object_key)
    return len(to_upload)


def test_plan_covers_sources_and_transcripts(backup_env, materials_root: Path):
    manifest = Manifest(materials_root / ".work" / "manifest.json")
    to_upload, unchanged = backup_env.plan_backup(manifest)

    paths = {i.path for i in to_upload}
    assert "materials/Foundation 2/Foundation 1 & 2.pdf" in paths
    assert "materials/Foundation 2/T7 Materials used in class/T7G5たいです.pdf" in paths
    assert "work/text/abc123def456.json" in paths
    assert unchanged == []
    # Every logical path restores somewhere, and every object key is plain
    # ASCII — the raw-filename scheme died on a combining dakuten (InvalidKey).
    assert all(backup_env.restore_target(p) is not None for p in paths)
    assert all(re.fullmatch(r"[\x21-\x7e]+", i.object_key) for i in to_upload)


def test_replan_after_marking_uploads_nothing(backup_env, materials_root: Path):
    manifest = Manifest(materials_root / ".work" / "manifest.json")
    marked = _mark_all(backup_env, manifest)

    again, unchanged = backup_env.plan_backup(manifest)
    assert again == []
    assert len(unchanged) == marked


def test_raw_key_era_entries_replan_as_uploads(backup_env, materials_root: Path):
    # Entries from the aborted first scheme carry no object key; they must be
    # re-uploaded under content-addressed keys, not treated as done.
    manifest = Manifest(materials_root / ".work" / "manifest.json")
    for item in backup_env.plan_backup(manifest)[0]:
        manifest.mark("backup", item.path, item.sha)  # old-style: no object=

    to_upload, unchanged = backup_env.plan_backup(manifest)
    assert unchanged == []
    assert len(to_upload) > 0


def test_changed_file_replans_only_itself(backup_env, materials_root: Path):
    manifest = Manifest(materials_root / ".work" / "manifest.json")
    _mark_all(backup_env, manifest)

    edited = materials_root / "Foundation 2" / "T6 Materials used in class" / "T6 G1.pdf"
    edited.write_bytes(b"%stub% edited")

    to_upload, _ = backup_env.plan_backup(manifest)
    assert [i.path for i in to_upload] == [
        "materials/Foundation 2/T6 Materials used in class/T6 G1.pdf"
    ]
    # A new content hash lands under a new object key.
    assert to_upload[0].object_key.startswith("materials/")
    assert to_upload[0].sha[:12] in to_upload[0].object_key


def test_restore_target_maps_and_rejects(backup_env):
    cfg = backup_env.CONFIG
    assert (
        backup_env.restore_target("materials/Foundation 2/x.pdf")
        == cfg.materials_root / "Foundation 2/x.pdf"
    )
    assert backup_env.restore_target("work/text/abc.json") == cfg.work_dir / "text/abc.json"
    # index.json itself is metadata, not a restorable object.
    assert backup_env.restore_target("index.json") is None

    with pytest.raises(RuntimeError):
        backup_env.restore_target("materials/../../etc/passwd")
    with pytest.raises(RuntimeError):
        backup_env.restore_target("work/C:/evil")


def test_upload_download_roundtrip_against_mock_bucket(backup_env):
    store: dict[str, bytes] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        key = request.url.path.split("/storage/v1/object/", 1)[-1]
        if request.method == "POST":
            store[key] = request.content
            return httpx.Response(200, json={"Key": key})
        if key in store:
            return httpx.Response(200, content=store[key])
        return httpx.Response(404, text="not found")

    http = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://bucket.test")
    backup_env.upload(http, "materials/c79cd3de37dd.pdf", b"%PDF", "application/pdf")
    assert backup_env.download(http, "materials/c79cd3de37dd.pdf") == b"%PDF"

    with pytest.raises(RuntimeError):
        backup_env.download(http, "missing.json")
