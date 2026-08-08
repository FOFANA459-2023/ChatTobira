"""Manifest resumability and corpus health checks."""

from __future__ import annotations

from pathlib import Path

from ingest.manifest import Manifest
from ingest.verify import check_chunks, check_documents


class TestManifest:
    def test_roundtrip(self, tmp_path: Path):
        m = Manifest(tmp_path / "m.json")
        assert not m.done("transcribe", "a.pdf", "sha1")
        m.mark("transcribe", "a.pdf", "sha1", pages=3)
        assert m.done("transcribe", "a.pdf", "sha1")

        # A fresh instance reads the same state back — this is what resume is.
        m2 = Manifest(tmp_path / "m.json")
        assert m2.done("transcribe", "a.pdf", "sha1")
        assert m2.get("transcribe", "a.pdf")["pages"] == 3

    def test_changed_content_invalidates(self, tmp_path: Path):
        m = Manifest(tmp_path / "m.json")
        m.mark("transcribe", "a.pdf", "sha1")
        # Editing a handout changes its hash; it must re-process.
        assert not m.done("transcribe", "a.pdf", "sha2")

    def test_corrupt_file_recovers(self, tmp_path: Path):
        target = tmp_path / "m.json"
        target.write_text('{"stages": {"transcribe', "utf-8")  # truncated write
        m = Manifest(target)  # must not raise
        assert not m.done("transcribe", "a.pdf", "sha1")


class TestChunkChecks:
    def test_all_japanese_passes(self):
        records = [{"content": "見える", "tokens_text": "見える"}] * 20
        assert all(c.passed for c in check_chunks(records))

    def test_english_regression_fails(self):
        # The tripwire: transcription silently regressing to the broken PDF
        # text layer floods the corpus with English-only fragments.
        records = [{"content": "Choose the best answer", "tokens_text": "x"}] * 20
        cjk = next(c for c in check_chunks(records) if c.name == "cjk_coverage")
        assert not cjk.passed

    def test_empty_corpus_fails(self):
        checks = check_chunks([])
        assert not all(c.passed for c in checks)


class TestDocumentChecks:
    def test_exactly_three_citable_required(self):
        docs = [
            {"id": 1, "path": "a", "is_citable": True, "_has_book_pages": True},
            {"id": 2, "path": "b", "is_citable": True, "_has_book_pages": True},
            {"id": 3, "path": "c", "is_citable": True, "_has_book_pages": True},
            {"id": 4, "path": "d", "is_citable": False, "_has_book_pages": False},
        ]
        counts = {1: 5, 2: 5, 3: 5, 4: 5}
        citable = next(c for c in check_documents(docs, counts) if c.name == "citable_present")
        assert citable.passed

    def test_barren_document_flagged(self):
        docs = [{"id": 1, "path": "a", "is_citable": True, "_has_book_pages": True}]
        barren = next(c for c in check_documents(docs, {}) if c.name == "all_documents_chunked")
        assert not barren.passed
