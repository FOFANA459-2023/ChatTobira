"""Split transcribed pages into retrievable chunks.

Hard constraint: a chunk never spans two pages. Citations carry a page number,
so a chunk drawn from pages 87 and 88 could only ever cite one of them and would
send the student to the wrong page half the time.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .discover import SourceDoc
from .japanese import reading, tokenize
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


def chunk_document(doc: SourceDoc, pages: list[PageText]) -> list[Chunk]:
    chunks: list[Chunk] = []
    ordinal = 0

    for page in pages:
        if not page.markdown.strip():
            continue

        pieces = _merge_small(
            [p for section in _split_sections(page.markdown) for p in _split_long(section)]
        )

        for piece in pieces:
            body = piece.strip()
            if not body:
                continue

            # Prepend provenance so the embedding carries topic/grammar context
            # even when the excerpt itself is a bare conjugation table.
            header_bits = [b for b in (doc.title, doc.topic, doc.grammar_point) if b]
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
                        "topic": doc.topic,
                        "topics": doc.topics,
                        "doc_type": doc.doc_type,
                        "is_answer_key": doc.doc_type == "answer_key",
                        "grammar_point": doc.grammar_point,
                        "grammar_points": page.grammar_points,
                        "embed_text": embed_text,
                    },
                )
            )
            ordinal += 1

    return chunks
