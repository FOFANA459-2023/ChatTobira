"""Post-ingest checks.

The important one is CJK coverage. If transcription silently degrades — a model
change, a bad prompt, a fallback to the PDF text layer — the corpus fills with
English fragments and the bot keeps answering, just wrongly. That failure is
invisible without an explicit tripwire.
"""

from __future__ import annotations

from dataclasses import dataclass

from .japanese import has_cjk
from .redact import find_identity

MIN_CJK_RATIO = 0.95

# Past papers: the leak tripwire.
#
# The sat papers are scans of one student's marked script. Two passes already
# try to keep their identity out of the corpus — the transcription prompt, and
# the deterministic redaction the chunker runs over what the prompt returned.
# This is the third, and the only one that runs against the text that actually
# reached the database. It exists because the first two are the kind of thing
# that fails silently: the corpus keeps working, and simply answers a
# classmate's question with a named student's grade.
#
# Patterns are shared with the redactor rather than restated here. A detector
# that has drifted from the redactor is worse than no detector, because it
# certifies exactly what the redactor stopped catching.


@dataclass
class Check:
    name: str
    passed: bool
    detail: str


def check_chunks(records: list[dict]) -> list[Check]:
    checks: list[Check] = []

    if not records:
        return [Check("non_empty", False, "no chunks were produced at all")]

    with_cjk = sum(1 for r in records if has_cjk(r.get("content", "")))
    ratio = with_cjk / len(records)
    checks.append(
        Check(
            "cjk_coverage",
            ratio >= MIN_CJK_RATIO,
            f"{with_cjk}/{len(records)} chunks contain kana or kanji ({ratio:.1%}); "
            f"threshold {MIN_CJK_RATIO:.0%}. Below this, transcription has "
            f"regressed to the unusable PDF text layer.",
        )
    )

    empty = [r for r in records if not r.get("content", "").strip()]
    checks.append(Check("no_empty_chunks", not empty, f"{len(empty)} empty chunks"))

    no_tokens = [r for r in records if not (r.get("tokens_text") or "").strip()]
    checks.append(
        Check(
            "tokens_present",
            not no_tokens,
            f"{len(no_tokens)} chunks have no morphemes; lexical search would miss them entirely",
        )
    )

    return checks


def check_documents(
    documents: list[dict], chunk_counts: dict[int, int], expected_citable: int
) -> list[Check]:
    checks: list[Check] = []

    # Counted against CITABLE_SOURCES rather than a literal: adding a textbook
    # is a .env change, and a check that had to be edited alongside it would
    # simply be edited to match whatever shipped, which is not a check.
    citable = [d for d in documents if d.get("is_citable")]
    checks.append(
        Check(
            "citable_present",
            len(citable) == expected_citable,
            f"{len(citable)} citable textbooks registered "
            f"(expected {expected_citable}, from CITABLE_SOURCES). "
            f"With none, every answer would come back uncited; with fewer than "
            f"configured, one book is missing from the corpus.",
        )
    )

    barren = [d["path"] for d in documents if chunk_counts.get(d["id"], 0) == 0]
    checks.append(
        Check(
            "all_documents_chunked",
            not barren,
            f"{len(barren)} documents produced no chunks: {barren[:5]}",
        )
    )

    missing_pages = [
        d["path"]
        for d in citable
        if chunk_counts.get(d["id"], 0) and not d.get("_has_book_pages", True)
    ]
    checks.append(
        Check(
            "textbook_page_numbers",
            not missing_pages,
            f"{len(missing_pages)} textbooks have no printed page numbers; "
            f"citations would reference the PDF index instead of the book",
        )
    )

    return checks


def check_past_papers(
    documents: list[dict], chunks: list[dict], chunk_counts: dict[int, int]
) -> list[Check]:
    """Checks that only apply to the sat papers.

    Returns nothing at all when no past paper is indexed: a corpus without
    them is a perfectly valid corpus, and a check that fails for everyone who
    has not ingested one is a check people learn to ignore.
    """
    papers = [d for d in documents if d.get("doc_type") == "past_paper"]
    if not papers:
        return []

    paper_ids = {d["id"] for d in papers}
    paper_chunks = [c for c in chunks if c.get("document_id") in paper_ids]
    checks: list[Check] = []

    # The one that matters. Reported with the offending text so it can be
    # judged rather than guessed at — a false positive on a date in a reading
    # passage looks very different from a student's name.
    leaks: list[str] = []
    for chunk in paper_chunks:
        leaks += [f"{name}: {found!r}" for name, found in find_identity(chunk.get("content", ""))]
    checks.append(
        Check(
            "past_paper_no_pii",
            not leaks,
            f"{len(leaks)} chunk(s) look like they carry a student's identity or "
            f"marks: {leaks[:3]}. These scans are one named student's script; "
            f"their name, ID and score must not enter a corpus the whole cohort "
            f"can query."
            if leaks
            else f"{len(paper_chunks)} past-paper chunks carry no name, ID or mark",
        )
    )

    # A paper whose topic never made it off the page is retrievable only by
    # wording, so "test me on Topic 8" cannot reach it.
    with_topic = sum(1 for c in paper_chunks if (c.get("metadata") or {}).get("topic"))
    checks.append(
        Check(
            "past_paper_topics",
            with_topic > 0,
            f"{with_topic}/{len(paper_chunks)} past-paper chunks know which topic "
            f"they test; with none, a topic-scoped test cannot reach a paper",
        )
    )

    barren = [d["path"] for d in papers if chunk_counts.get(d["id"], 0) == 0]
    checks.append(
        Check(
            "past_papers_indexed",
            not barren,
            f"{len(papers) - len(barren)}/{len(papers)} past papers are indexed"
            + (f"; empty: {barren}" if barren else ""),
        )
    )

    return checks


def report(checks: list[Check]) -> bool:
    for check in checks:
        mark = "PASS" if check.passed else "FAIL"
        print(f"[{mark}] {check.name}: {check.detail}")
    return all(c.passed for c in checks)
