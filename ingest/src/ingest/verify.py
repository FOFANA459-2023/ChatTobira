"""Post-ingest checks.

The important one is CJK coverage. If transcription silently degrades — a model
change, a bad prompt, a fallback to the PDF text layer — the corpus fills with
English fragments and the bot keeps answering, just wrongly. That failure is
invisible without an explicit tripwire.
"""

from __future__ import annotations

from dataclasses import dataclass

from .japanese import has_cjk

MIN_CJK_RATIO = 0.95


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


def check_documents(documents: list[dict], chunk_counts: dict[int, int]) -> list[Check]:
    checks: list[Check] = []

    citable = [d for d in documents if d.get("is_citable")]
    checks.append(
        Check(
            "citable_present",
            len(citable) == 3,
            f"{len(citable)} citable textbooks registered (expected 3). "
            f"With none, every answer would come back uncited.",
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


def report(checks: list[Check]) -> bool:
    for check in checks:
        mark = "PASS" if check.passed else "FAIL"
        print(f"[{mark}] {check.name}: {check.detail}")
    return all(c.passed for c in checks)
