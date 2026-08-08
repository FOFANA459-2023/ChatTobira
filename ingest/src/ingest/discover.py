"""Inventory the materials tree and derive metadata from folder/file names.

The existing naming is already structured — "Foundation 3/T13 Materials used in
class/G2 ～ところ.pptx" encodes level, topic, and grammar point. Reading it
costs nothing and outperforms trying to infer the same facts from content later.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

from .config import CONFIG

SOURCE_SUFFIXES = {".pdf", ".ppt", ".pptx", ".doc", ".docx"}
OFFICE_SUFFIXES = {".ppt", ".pptx", ".doc", ".docx"}

# Topic markers. The lookbehind rejects only a preceding *digit* (so "26春F3_0409"
# cannot produce a topic); it must NOT reject a preceding letter, because
# "Kanji storyT16.pdf" glues the marker straight onto a word. Requiring a
# non-letter there made that file silently inherit T14 from its "T14, 15, 16"
# folder — wrong week, wrong retrieval scope.
_TOPIC_RANGE_RE = re.compile(r"(?<!\d)T\s?(\d{1,2})\s*[-–—~〜]\s*T?\s?(\d{1,2})(?!\d)")
_TOPIC_LIST_RE = re.compile(r"(?<!\d)T\s?(\d{1,2})((?:\s*[,、]\s*\d{1,2})+)(?!\d)")
_TOPIC_RE = re.compile(r"(?<!\d)T\s?(\d{1,2})(?!\d)")
# Grammar point: G1, G3,4, G1_7, G5たいです, G2 ～ところ
_GRAMMAR_RE = re.compile(r"(?<![A-Za-z])G\s?(\d+(?:[,_\-]\s?\d+)*)\s*(.*)$", re.IGNORECASE)

_ANSWER_MARKERS = ("答え", "こたえ", "answer", "answers")
_KANJI_MARKERS = ("kanji", "漢字", "筆順", "vocabulary")
_READING_MARKERS = ("reading", "readings", "読み物", "読解")


@dataclass
class SourceDoc:
    path: str            # relative to materials_root, forward slashes
    title: str
    level: str | None    # F2 | F3 | INT
    topic: str | None    # primary topic, T6 .. T17
    topics: list[str]    # every topic covered; review sheets span several
    doc_type: str        # textbook | answer_key | kanji | reading | slides | grammar
    is_citable: bool
    grammar_point: str | None
    needs_conversion: bool
    content_sha: str
    size_bytes: int

    def to_row(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("needs_conversion")
        d.pop("grammar_point")
        return d


def _level_of(rel: str) -> str | None:
    head = rel.split("/", 1)[0].lower()
    if head.startswith("intermediate"):
        return "INT"
    if "foundation 3" in head:
        return "F3"
    if "foundation 2" in head or "foundation 1" in head:
        return "F2"
    return None


def _topics_in(text: str) -> list[str]:
    """All topics named in one path component, expanding ranges and lists.

    "T14, 15, 16 Materials used in class" -> T14, T15, T16
    "T15-T17ふくしゅうシートのこたえ"        -> T15, T16, T17
    """
    if m := _TOPIC_RANGE_RE.search(text):
        lo, hi = int(m.group(1)), int(m.group(2))
        if lo <= hi and hi - lo <= 12:
            return [f"T{n}" for n in range(lo, hi + 1)]

    if m := _TOPIC_LIST_RE.search(text):
        nums = [int(m.group(1))]
        nums += [int(n) for n in re.findall(r"\d{1,2}", m.group(2))]
        return [f"T{n}" for n in dict.fromkeys(nums)]

    if m := _TOPIC_RE.search(text):
        return [f"T{int(m.group(1))}"]

    return []


def _topics_of(rel: str) -> list[str]:
    """Filename topics win over folder topics.

    `Foundation 2/T7 Materials used in class/T8G3.pdf` is T8 content filed in the
    T7 folder. Trusting the folder there would put it in the wrong week and make
    scoped study mode retrieve the wrong material.
    """
    parts = rel.split("/")
    stem, folders = parts[-1], parts[:-1]

    if topics := _topics_in(stem):
        return topics
    for folder in reversed(folders):
        if topics := _topics_in(folder):
            return topics
    return []


def _grammar_point_of(stem: str) -> str | None:
    m = _GRAMMAR_RE.search(stem)
    if not m:
        return None
    label = m.group(2).strip(" _-–—.")
    # Strip a leading topic marker left over from names like "T7G5たいです"
    label = re.sub(r"^T\s?\d{1,2}\s*", "", label).strip()
    number = re.sub(r"\s+", "", m.group(1))
    return f"G{number} {label}".strip() if label else f"G{number}"


def _doc_type_of(rel: str, stem: str, suffix: str, is_citable: bool) -> str:
    low = f"{rel} {stem}".lower()
    if is_citable:
        return "textbook"
    # Answer keys win over everything: 文法復習シート_T12(答え) is both a grammar
    # sheet and an answer key, and the answer-key fact is the one that matters.
    if any(m in low for m in _ANSWER_MARKERS):
        return "answer_key"
    if any(m in low for m in _KANJI_MARKERS):
        return "kanji"
    if any(m in low for m in _READING_MARKERS):
        return "reading"
    if suffix in {".ppt", ".pptx"}:
        return "slides"
    return "grammar"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def discover() -> list[SourceDoc]:
    root = CONFIG.materials_root
    citable = CONFIG.citable_sources
    docs: list[SourceDoc] = []

    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SOURCE_SUFFIXES:
            continue
        # Skip our own scratch output and anything hidden.
        rel_parts = path.relative_to(root).parts
        if any(p.startswith(".") for p in rel_parts):
            continue

        rel = "/".join(rel_parts)
        stem = path.stem
        suffix = path.suffix.lower()
        is_citable = rel in citable
        # Textbooks span every topic, so pinning them to one would be misleading.
        topics: list[str] = [] if is_citable else _topics_of(rel)

        docs.append(
            SourceDoc(
                path=rel,
                title=stem,
                level=_level_of(rel),
                topic=topics[0] if topics else None,
                topics=topics,
                doc_type=_doc_type_of(rel, stem, suffix, is_citable),
                is_citable=is_citable,
                grammar_point=_grammar_point_of(stem),
                needs_conversion=suffix in OFFICE_SUFFIXES,
                content_sha=_sha256(path),
                size_bytes=path.stat().st_size,
            )
        )

    _warn_on_missing_citable(docs, citable)
    return docs


def _warn_on_missing_citable(docs: list[SourceDoc], citable: set[str]) -> None:
    """A typo in CITABLE_SOURCES would silently disable all citations."""
    found = {d.path for d in docs if d.is_citable}
    missing = citable - found
    if missing:
        raise RuntimeError(
            "CITABLE_SOURCES lists paths that do not exist under MATERIALS_ROOT:\n  "
            + "\n  ".join(sorted(missing))
            + "\nCitations would silently be empty. Fix .env before ingesting."
        )
    if not found:
        raise RuntimeError("No citable textbooks resolved — CITABLE_SOURCES is empty.")
