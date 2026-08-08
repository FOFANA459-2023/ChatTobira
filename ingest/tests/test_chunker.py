"""Chunking invariants."""

from __future__ import annotations

from ingest.chunker import MAX_CHARS, chunk_document
from ingest.discover import SourceDoc
from ingest.transcribe import PageText


def _doc(**overrides) -> SourceDoc:
    base = {
        "path": "Intermediate/Tobira Intermediate Japanese.pdf",
        "title": "Tobira Intermediate Japanese",
        "level": "INT",
        "topic": None,
        "topics": [],
        "doc_type": "textbook",
        "is_citable": True,
        "grammar_point": None,
        "needs_conversion": False,
        "content_sha": "deadbeef0000",
        "size_bytes": 1,
    }
    base.update(overrides)
    return SourceDoc(**base)


def _page(pdf_page: int, markdown: str, book_page: str | None = None) -> PageText:
    return PageText(
        pdf_page=pdf_page,
        markdown=markdown,
        book_page=book_page,
        grammar_points=[],
        has_japanese=True,
    )


def test_chunk_never_spans_pages():
    # Citations carry one page number, so a cross-page chunk would cite wrongly.
    pages = [
        _page(1, "## A\n\n文です。" * 40, book_page="10"),
        _page(2, "## B\n\n別の文です。" * 40, book_page="11"),
    ]
    chunks = chunk_document(_doc(), pages)
    for c in chunks:
        assert c.pdf_page in (1, 2)
        assert c.book_page in ("10", "11")
        # Content from page 1 must not appear in a page-2 chunk.
        if c.pdf_page == 1:
            assert "別の文" not in c.content


def test_book_page_flows_to_chunk():
    chunks = chunk_document(_doc(), [_page(7, "# 見出し\n\n本文です。", book_page="i")])
    assert chunks[0].book_page == "i"  # front matter uses roman numerals


def test_long_section_is_split_under_max():
    long_text = "## 大見出し\n\n" + "\n\n".join(f"例文その{i}です。" * 30 for i in range(20))
    chunks = chunk_document(_doc(), [_page(1, long_text)])
    assert len(chunks) > 1
    for c in chunks:
        assert len(c.content) <= MAX_CHARS


def test_empty_page_produces_no_chunks():
    assert chunk_document(_doc(), [_page(1, "")]) == []


def test_metadata_carries_provenance():
    doc = _doc(
        path="Foundation 3/T13/G2 ～ところ.pptx",
        title="G2 ～ところ",
        level="F3",
        topic="T13",
        topics=["T13"],
        doc_type="slides",
        is_citable=False,
        grammar_point="G2 ～ところ",
    )
    chunks = chunk_document(doc, [_page(1, "今から食べるところです。")])
    meta = chunks[0].metadata
    assert meta["level"] == "F3"
    assert meta["topic"] == "T13"
    assert meta["grammar_point"] == "G2 ～ところ"
    assert meta["is_answer_key"] is False
    # The embed text is prefixed with provenance so a bare conjugation table
    # still embeds near its topic.
    assert meta["embed_text"].startswith("G2 ～ところ")


def test_answer_key_flag():
    doc = _doc(doc_type="answer_key", is_citable=False, path="x/答え.pdf", title="答え")
    chunks = chunk_document(doc, [_page(1, "答えです。")])
    assert chunks[0].metadata["is_answer_key"] is True


def test_tokens_and_reading_populated():
    chunks = chunk_document(_doc(), [_page(1, "窓から海が見える。")])
    assert "見える" in chunks[0].tokens
    assert "みえる" in chunks[0].reading
