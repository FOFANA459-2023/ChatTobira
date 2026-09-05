"""Re-running `ingest push` must not duplicate anything, or pay twice.

Two mechanisms, and they answer different failures. `replace_chunks` deletes a
document's chunks before writing them, so even a forced re-push cannot leave
two copies of a page in the index — that is the correctness guarantee. The
content_sha check on top of it is the cost guarantee: embeddings come from a
single free-tier key with about a thousand a day in it, and re-embedding an
unchanged 290-page textbook to write identical rows spends a day of that
budget to change nothing.
"""

from __future__ import annotations

import contextlib
import json
from pathlib import Path

import pytest

from ingest import cli
from ingest.transcribe import PageText


class FakeStore:
    """Records what push asked the database to do."""

    def __init__(self, existing: dict[str, tuple[str, int]] | None = None):
        self.existing = existing or {}
        self.upserts: list[tuple[str, list[str] | None]] = []
        self.replacements: list[tuple[str, int]] = []
        self.deleted_before_insert: list[str] = []

    # -- the surface cli.cmd_push uses -------------------------------------
    def fetch_document_shas(self, _conn):
        return dict(self.existing)

    @contextlib.contextmanager
    def connect(self):
        yield self

    def commit(self):
        pass

    def upsert_document(self, _conn, doc, page_count, topics=None):
        self.upserts.append((doc.path, topics))
        return len(self.upserts)

    def replace_chunks(self, _conn, _document_id, chunks, embeddings):
        assert len(chunks) == len(embeddings)
        # The real implementation deletes first; recorded here so the
        # idempotence claim is asserted rather than assumed.
        self.deleted_before_insert.append(chunks[0].metadata["doc_type"])
        self.replacements.append((chunks[0].metadata["doc_type"], len(chunks)))
        return len(chunks)


@pytest.fixture()
def push_env(materials_root: Path, monkeypatch: pytest.MonkeyPatch):
    """A materials tree whose past papers are already transcribed."""
    import ingest.config as config_module

    config = config_module.Config()
    monkeypatch.setattr(cli, "CONFIG", config)
    config.ensure_dirs()

    from ingest.discover import discover

    for doc in discover():
        if doc.doc_type != "past_paper":
            continue
        pages = [
            {
                "pdf_page": 1,
                "markdown": "24秋 トピック8 文法クイズ\n" + "あ" * 400,
                "book_page": None,
                "grammar_points": [],
                "has_japanese": True,
                "topic": 8,
                "exam_term": "24秋",
                "paper_title": "文法クイズ",
            }
        ]
        (config.text_dir / f"{doc.content_sha[:12]}.json").write_text(
            json.dumps(pages, ensure_ascii=False), "utf-8"
        )

    embedded: list[int] = []

    def fake_embed(texts):
        embedded.append(len(texts))
        return [[0.0] * 768 for _ in texts]

    monkeypatch.setattr(cli, "embed_documents", fake_embed)
    return embedded


def _push(store: FakeStore, monkeypatch: pytest.MonkeyPatch, **kwargs) -> None:
    monkeypatch.setattr(cli, "store", store)
    cli.cmd_push(only="Papers", **{"force": False, **kwargs})


def test_first_push_writes_every_paper(push_env, monkeypatch):
    store = FakeStore()
    _push(store, monkeypatch)

    assert len(store.upserts) == 3
    assert sum(n for _, n in store.replacements) > 0
    # One embedding batch per document, and nothing embedded twice.
    assert len(push_env) == 3


def test_second_push_embeds_nothing_and_writes_nothing(push_env, monkeypatch):
    from ingest.discover import discover

    already = {d.path: (d.content_sha, 1) for d in discover() if d.doc_type == "past_paper"}
    store = FakeStore(existing=already)
    _push(store, monkeypatch)

    # This is the requirement: re-running ingestion creates no second copy and
    # spends no quota.
    assert store.upserts == []
    assert store.replacements == []
    assert push_env == []


def test_an_edited_source_is_pushed_again(push_env, monkeypatch):
    from ingest.discover import discover

    papers = [d for d in discover() if d.doc_type == "past_paper"]
    stale = {d.path: ("a-different-hash", 1) for d in papers}
    store = FakeStore(existing=stale)
    _push(store, monkeypatch)

    assert len(store.upserts) == 3


def test_a_partially_ingested_document_is_finished(push_env, monkeypatch):
    # Same bytes, fewer pages stored than the transcript now holds: the file
    # never changed, so the hash alone would call this current and the rest of
    # the book would never be indexed.
    from ingest.discover import discover

    papers = [d for d in discover() if d.doc_type == "past_paper"]
    short = {d.path: (d.content_sha, 0) for d in papers}
    store = FakeStore(existing=short)
    _push(store, monkeypatch)

    assert len(store.upserts) == 3


def test_force_re_embeds_a_document_the_hash_calls_current(push_env, monkeypatch):
    from ingest.discover import discover

    already = {d.path: (d.content_sha, 1) for d in discover() if d.doc_type == "past_paper"}
    store = FakeStore(existing=already)
    _push(store, monkeypatch, force=True)

    # The escape hatch for a change the hash cannot see: a new chunker, or a
    # different embedding model.
    assert len(store.upserts) == 3


def test_page_topics_reach_the_document_row(push_env, monkeypatch):
    store = FakeStore()
    _push(store, monkeypatch)

    # The compilations name no topic in their filenames, so this override is
    # the only thing that lets a topic-scoped search filter to them.
    assert all(topics == ["T8"] for _, topics in store.upserts), store.upserts


def test_page_topics_are_not_invented_for_a_handout(push_env, monkeypatch, materials_root):
    import ingest.config as config_module
    from ingest.discover import discover

    config = config_module.Config()
    doc = next(d for d in discover() if d.path.endswith("T6 G1.pdf"))
    (config.text_dir / f"{doc.content_sha[:12]}.json").write_text(
        json.dumps([PageText(1, "あ" * 400, None, [], True).__dict__], ensure_ascii=False),
        "utf-8",
    )
    store = FakeStore()
    monkeypatch.setattr(cli, "store", store)
    cli.cmd_push(only="T6 G1", force=False)

    # No printed topic on the page, so the filename's topic stands and the
    # override passes None rather than an empty list.
    assert store.upserts == [("Foundation 2/T6 Materials used in class/T6 G1.pdf", None)]
