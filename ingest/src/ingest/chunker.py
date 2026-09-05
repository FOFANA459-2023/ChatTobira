"""Split transcribed pages into retrievable chunks.

Hard constraint: a chunk never spans two pages. Citations carry a page number,
so a chunk drawn from pages 87 and 88 could only ever cite one of them and would
send the student to the wrong page half the time.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from typing import Any

from .discover import SourceDoc
from .japanese import reading, tokenize
from .redact import redact_identity
from .transcribe import PageText

TARGET_CHARS = 900
MAX_CHARS = 1600
MIN_CHARS = 180

_HEADING_RE = re.compile(r"^#{1,6}\s+.*$", re.MULTILINE)


@dataclass
class Chunk:
    pdf_page: int
    book_page: str | None
    ord: int
    content: str
    tokens: str
    reading: str
    metadata: dict[str, Any] = field(default_factory=dict)


def _split_sections(markdown: str) -> list[str]:
    """Split on Markdown headings, keeping each heading with its body."""
    positions = [m.start() for m in _HEADING_RE.finditer(markdown)]
    if not positions:
        return [markdown]
    if positions[0] > 0:
        positions.insert(0, 0)
    bounds = positions + [len(markdown)]
    return [markdown[bounds[i] : bounds[i + 1]].strip() for i in range(len(positions))]


def _split_long(text: str) -> list[str]:
    """Break an oversized section on blank lines, then on line boundaries."""
    if len(text) <= MAX_CHARS:
        return [text]

    out: list[str] = []
    buffer = ""
    for block in re.split(r"\n\s*\n", text):
        block = block.strip()
        if not block:
            continue
        if len(buffer) + len(block) + 2 <= TARGET_CHARS or not buffer:
            buffer = f"{buffer}\n\n{block}".strip()
        else:
            out.append(buffer)
            buffer = block

        while len(buffer) > MAX_CHARS:
            # A single block still too long: cut at the last line break that fits
            # rather than mid-sentence, which would orphan an example sentence.
            cut = buffer.rfind("\n", 0, MAX_CHARS)
            if cut <= 0:
                cut = MAX_CHARS
            out.append(buffer[:cut].strip())
            buffer = buffer[cut:].strip()

    if buffer:
        out.append(buffer)
    return [c for c in out if c.strip()]


def _merge_small(pieces: list[str]) -> list[str]:
    merged: list[str] = []
    for piece in pieces:
        if merged and len(merged[-1]) < MIN_CHARS:
            candidate = f"{merged[-1]}\n\n{piece}"
            if len(candidate) <= MAX_CHARS:
                merged[-1] = candidate
                continue
        merged.append(piece)
    return merged


def carry_paper_headers(pages: list[PageText]) -> list[PageText]:
    """Give every page of a paper the header printed on its first page.

    A sat paper runs to two or three sheets and only the first prints
    「24秋 トピック8 文法クイズ」; the rest simply carry on with section III.
    Measured on the ingested compilation, that is every second page — so
    without this, half the past-paper corpus knows neither which topic it
    tests nor which sitting it came from, and a test scoped to Topic 8 sees
    the front of the paper and not the reading passage on its back.

    A page that prints any header field starts a new paper and resets the
    carry; a page that prints none is a continuation and inherits. No-op for
    every other document type, whose pages carry no header fields at all.
    """
    carried: list[PageText] = []
    topic: int | None = None
    term: str | None = None
    title: str | None = None

    for page in pages:
        if page.topic or page.exam_term or page.paper_title:
            topic, term, title = page.topic, page.exam_term, page.paper_title
            carried.append(page)
        else:
            carried.append(replace(page, topic=topic, exam_term=term, paper_title=title))
    return carried


def chunk_document(doc: SourceDoc, pages: list[PageText]) -> list[Chunk]:
    chunks: list[Chunk] = []
    ordinal = 0
    is_past_paper = doc.doc_type == "past_paper"

    for page in carry_paper_headers(pages):
        if not page.markdown.strip():
            continue

        # Second line of defence on the scanned scripts. The transcription
        # prompt is told not to copy the student's name, class or mark, and
        # it mostly does not — it carried over 「クラス CD」 on one page of 49,
        # which is exactly the rate at which a prompt-only rule fails. This
        # pass is deterministic, so what reaches the index does not depend on
        # the model having been careful. Applied here rather than at
        # transcription time so it also covers transcripts already cached.
        markdown = redact_identity(page.markdown) if is_past_paper else page.markdown

        pieces = _merge_small(
            [p for section in _split_sections(markdown) for p in _split_long(section)]
        )

        # A past paper is a compilation: one PDF holds every paper a course
        # sat, and consecutive pages belong to different topics and different
        # terms. The topic printed on the page therefore beats the one the
        # filename gave the document — which for these files is nothing at
        # all, since "Foundation 3 Past Papers.pdf" names no topic. Without
        # this every page of a 24-page compilation would carry the same
        # (empty) topic and a test scoped to Topic 8 could not find its paper.
        page_topic = f"T{page.topic}" if page.topic else None
        topic = page_topic or doc.topic

        for piece in pieces:
            body = piece.strip()
            if not body:
                continue

            # Prepend provenance so the embedding carries topic/grammar context
            # even when the excerpt itself is a bare conjugation table. A past
            # paper adds the term and the paper's own title, so a search for
            # "Topic 8 grammar quiz" reaches the page that IS one.
            header_bits = [
                b
                for b in (
                    doc.title,
                    "past exam paper" if is_past_paper else None,
                    page.exam_term if is_past_paper else None,
                    page.paper_title if is_past_paper else None,
                    topic,
                    doc.grammar_point,
                )
                if b
            ]
            embed_text = f"{' / '.join(header_bits)}\n\n{body}" if header_bits else body

            chunks.append(
                Chunk(
                    pdf_page=page.pdf_page,
                    book_page=page.book_page,
                    ord=ordinal,
                    content=body,
                    tokens=" ".join(tokenize(embed_text)),
                    reading=reading(body)[:4000],
                    metadata={
                        "level": doc.level,
                        "topic": topic,
                        "topics": [topic] if page_topic else doc.topics,
                        "doc_type": doc.doc_type,
                        "is_answer_key": doc.doc_type == "answer_key",
                        "is_past_paper": is_past_paper,
                        "grammar_point": doc.grammar_point,
                        "grammar_points": page.grammar_points,
                        "embed_text": embed_text,
                        # Exam provenance, recorded only where it is real. The
                        # quiz generator reads these to say which papers a
                        # practice set was modelled on, and it must never be
                        # able to name a term that was not printed on a page.
                        **(
                            {
                                "exam_term": page.exam_term,
                                "paper_title": page.paper_title,
                            }
                            if is_past_paper
                            else {}
                        ),
                    },
                )
            )
            ordinal += 1

    return chunks
