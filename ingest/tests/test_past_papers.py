"""Past papers: classification, page-level metadata, and the leak tripwire.

The sat papers are scans of a marked student script, which makes them the one
source in this corpus where transcribing the page faithfully would be the
wrong thing to do. These tests pin the three decisions that follow from that:
they are their own document type, their topic comes off the page rather than
the filename, and a student's identity must never reach the index.
"""

from __future__ import annotations

from ingest.chunker import carry_paper_headers, chunk_document
from ingest.discover import SourceDoc, discover
from ingest.transcribe import (
    PAST_PAPER_PROFILE,
    TEXTBOOK_PROFILE,
    PageText,
    _clean,
    _page_topic,
    profile_for,
)
from ingest.verify import check_past_papers


def _doc(**overrides) -> SourceDoc:
    base = {
        "path": "Foundation 3/Foundation 3 Past Papers.pdf",
        "title": "Foundation 3 Past Papers",
        "level": "F3",
        "topic": None,
        "topics": [],
        "doc_type": "past_paper",
        "is_citable": False,
        "grammar_point": None,
        "needs_conversion": False,
        "content_sha": "deadbeef0000",
        "size_bytes": 1,
    }
    base.update(overrides)
    return SourceDoc(**base)


def _page(pdf_page: int, markdown: str, **overrides) -> PageText:
    base = {
        "pdf_page": pdf_page,
        "markdown": markdown,
        "book_page": None,
        "grammar_points": [],
        "has_japanese": True,
    }
    base.update(overrides)
    return PageText(**base)


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def test_past_papers_get_their_own_type(materials_root):
    by_path = {d.path: d for d in discover()}

    for path in (
        "Foundation 2/Found 1 Papers.pdf",
        "Foundation 2/Found 2 Papers.pdf",
        "Foundation 3/Foundation 3 Past Papers.pdf",
    ):
        assert by_path[path].doc_type == "past_paper", path
        # Never citable: a citation points a student at a page of a book they
        # own, and a sat paper has no such page.
        assert not by_path[path].is_citable


def test_past_papers_keep_the_level_of_their_folder(materials_root):
    by_path = {d.path: d for d in discover()}
    assert by_path["Foundation 2/Found 1 Papers.pdf"].level == "F2"
    assert by_path["Foundation 3/Foundation 3 Past Papers.pdf"].level == "F3"


def test_the_marker_is_word_bounded():
    # "papers" as a bare substring also matches "newspapers", which would file
    # a reading handout as a sat paper and feed it to the quiz generator as an
    # example of how the course writes exam questions.
    from ingest.discover import _PAST_PAPER_RE

    for name, expected in {
        "foundation 2/found 1 papers.pdf": True,
        "foundation 3/foundation 3 past papers.pdf": True,
        "t9 final exam.pdf": True,
        "24秋 文法クイズ.pdf": True,
        "t6 materials/newspapers reading.pdf": False,
        "wallpapers.pdf": False,
        "t7 grammar review.pdf": False,
        "kanji storyt16.pdf": False,
    }.items():
        assert bool(_PAST_PAPER_RE.search(name)) is expected, name


def test_review_sheets_are_still_answer_keys(materials_root):
    # The past-paper markers are checked first, so this is the regression that
    # matters: a review sheet with its answers is not a sat paper, and
    # reclassifying the existing corpus would be a silent change to retrieval.
    by_path = {d.path: d for d in discover()}
    assert (
        by_path[
            "Foundation 3/T12 Materials used in class-20260808/文法復習シート_T12(答え).pdf"
        ].doc_type
        == "answer_key"
    )
    assert (
        by_path["Foundation 3/T14, 15, 16 Materials used in class/Kanji storyT16.pdf"].doc_type
        == "kanji"
    )


# ---------------------------------------------------------------------------
# Transcription profile
# ---------------------------------------------------------------------------


def test_past_papers_use_their_own_prompt():
    assert profile_for("past_paper") is PAST_PAPER_PROFILE
    assert profile_for("textbook") is TEXTBOOK_PROFILE
    assert profile_for("grammar") is TEXTBOOK_PROFILE


def test_past_paper_prompt_forbids_the_handwriting_and_the_name():
    prompt = PAST_PAPER_PROFILE.prompt
    assert "ONLY THE PRINTED PAPER" in prompt
    assert "NEVER transcribe the student's name" in prompt
    # One page per request: a batch of these dense sheets overflows the output
    # budget, and a truncated batch costs a retry per page anyway.
    assert PAST_PAPER_PROFILE.max_pages_per_request == 1


def test_the_profile_reaches_the_model_and_caps_the_batch(monkeypatch):
    """A past paper is read one page at a time with its own prompt.

    Threading a parameter through four functions is exactly the kind of change
    that compiles while doing nothing, so this asserts on what the model
    actually received rather than on the call being made.
    """
    import ingest.transcribe as transcribe_module

    seen: list[object] = []

    def fake_call(images, count, temperature=0.0, profile=None):
        seen.append((len(images), profile))
        return [{"markdown": "トピック8", "has_japanese": True, "topic": 8}] * count

    import dataclasses

    monkeypatch.setattr(transcribe_module, "_call", fake_call)
    monkeypatch.setattr(transcribe_module, "is_blank", lambda _: False)
    # CONFIG is frozen, so the sleep between requests is removed by swapping
    # the whole object rather than the field.
    monkeypatch.setattr(
        transcribe_module,
        "CONFIG",
        dataclasses.replace(transcribe_module.CONFIG, vision_throttle=0.0),
    )

    from pathlib import Path

    pages = transcribe_module.transcribe(
        [Path(f"{n}.png") for n in range(3)], profile=PAST_PAPER_PROFILE
    )

    # Three requests of one page, not one request of three: the configured
    # VISION_PAGES_PER_REQUEST is overridden by the profile's ceiling.
    assert [count for count, _ in seen] == [1, 1, 1]
    assert all(profile is PAST_PAPER_PROFILE for _, profile in seen)
    assert [p.topic for p in pages] == [8, 8, 8]


def test_page_topic_survives_the_shapes_models_actually_return():
    assert _page_topic(8) == 8
    assert _page_topic("8") == 8
    assert _page_topic("トピック8") == 8
    assert _page_topic("８") == 8
    # A page printing no topic must not be filed under one.
    assert _page_topic(0) is None
    assert _page_topic(None) is None
    assert _page_topic(99) is None
    assert _page_topic(True) is None


def test_clean_drops_the_models_ways_of_saying_nothing():
    assert _clean("24秋") == "24秋"
    assert _clean("  24秋  ") == "24秋"
    for empty in ("", "   ", "null", "None", "N/A", "-", None, 5):
        assert _clean(empty) is None


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------


def test_topic_comes_off_the_page_not_the_filename():
    # One compilation, three papers, three topics. The filename names none of
    # them, so without the page-level topic every chunk here would be filed
    # under nothing and "test me on Topic 8" could not reach its own paper.
    pages = [
        _page(1, "24秋 トピック8 文法クイズ\n\n" + "あ" * 300, topic=8, exam_term="24秋"),
        _page(2, "24秋 トピック9 文法クイズ\n\n" + "い" * 300, topic=9, exam_term="24秋"),
        _page(3, "25春 トピック10 文法クイズ\n\n" + "う" * 300, topic=10, exam_term="25春"),
    ]
    chunks = chunk_document(_doc(), pages)
    by_page = {c.pdf_page: c.metadata for c in chunks}

    assert by_page[1]["topic"] == "T8"
    assert by_page[2]["topic"] == "T9"
    assert by_page[3]["topic"] == "T10"
    assert by_page[1]["topics"] == ["T8"]
    assert by_page[3]["exam_term"] == "25春"


def test_a_papers_second_page_inherits_its_header():
    # Measured on the real compilation: only the first sheet of each paper
    # prints 「24秋 トピック8 文法クイズ」, and that is every second page. The
    # continuation carries sections III–V, including the reading passage, so
    # losing its topic loses half the paper to a topic-scoped search.
    pages = [
        _page(
            1,
            "24秋 トピック8 文法クイズ\n\n" + "あ" * 300,
            topic=8,
            exam_term="24秋",
            paper_title="文法クイズ",
        ),
        _page(2, "III. 会話を書いてください。\n\n" + "い" * 300),
        _page(
            3,
            "24秋 トピック8 漢字・語彙クイズ\n\n" + "う" * 300,
            topic=8,
            exam_term="24秋",
            paper_title="漢字・語彙クイズ",
        ),
        _page(4, "II. 読み方を書いてください。\n\n" + "え" * 300),
    ]
    carried = carry_paper_headers(pages)

    assert [p.topic for p in carried] == [8, 8, 8, 8]
    # The continuation belongs to its OWN paper, not to whichever came first.
    assert [p.paper_title for p in carried] == [
        "文法クイズ",
        "文法クイズ",
        "漢字・語彙クイズ",
        "漢字・語彙クイズ",
    ]


def test_pages_before_the_first_header_inherit_nothing():
    # A cover sheet at the front of a compilation belongs to no paper, and
    # guessing one would file it under someone else's topic.
    carried = carry_paper_headers(
        [_page(1, "表紙"), _page(2, "トピック8", topic=8, paper_title="文法クイズ")]
    )
    assert carried[0].topic is None
    assert carried[0].paper_title is None
    assert carried[1].topic == 8


def test_carrying_headers_is_a_no_op_for_a_textbook():
    pages = [_page(1, "第3課"), _page(2, "つづき")]
    assert [p.topic for p in carry_paper_headers(pages)] == [None, None]


def test_exam_provenance_rides_on_the_chunk():
    pages = [
        _page(
            1,
            "文法クイズ\n\n" + "あ" * 300,
            topic=8,
            exam_term="24秋",
            paper_title="文法クイズ",
        )
    ]
    metadata = chunk_document(_doc(), pages)[0].metadata

    assert metadata["is_past_paper"] is True
    assert metadata["exam_term"] == "24秋"
    assert metadata["paper_title"] == "文法クイズ"
    assert metadata["doc_type"] == "past_paper"
    # The embedded text carries the exam framing, so a search for a past
    # paper on a topic reaches the page that is one.
    assert "past exam paper" in metadata["embed_text"]
    assert "24秋" in metadata["embed_text"]


def test_a_textbook_chunk_claims_no_exam_provenance():
    # Absent rather than null: a chunk that is not from a paper must not look
    # like one whose term simply failed to transcribe.
    pages = [_page(1, "第3課\n\n" + "あ" * 300, exam_term="24秋", paper_title="x")]
    metadata = chunk_document(_doc(doc_type="textbook", is_citable=True), pages)[0].metadata

    assert metadata["is_past_paper"] is False
    assert "exam_term" not in metadata
    assert "paper_title" not in metadata


def test_a_page_without_a_printed_topic_falls_back_to_the_filename():
    pages = [_page(1, "あ" * 300)]
    metadata = chunk_document(_doc(topic="T14", topics=["T14"]), pages)[0].metadata
    assert metadata["topic"] == "T14"
    assert metadata["topics"] == ["T14"]


# ---------------------------------------------------------------------------
# The leak tripwire
# ---------------------------------------------------------------------------


def _paper_corpus(*contents: str):
    documents = [{"id": 1, "path": "Foundation 3/Past.pdf", "doc_type": "past_paper"}]
    chunks = [{"document_id": 1, "content": text, "metadata": {"topic": "T8"}} for text in contents]
    return documents, chunks, {1: len(chunks)}


def _result(checks, name):
    return next(c for c in checks if c.name == name)


def test_a_clean_transcription_passes():
    documents, chunks, counts = _paper_corpus(
        "24秋 トピック8 文法クイズ\nクラス ＿＿＿ なまえ ＿＿＿\n"
        "I. 動詞を選んで、正しい形にかえて、（　）に書いてください。(1×7)\n"
        "(1) デパートで（　）まえに ATM でお金をおろします。"
    )
    assert _result(check_past_papers(documents, chunks, counts), "past_paper_no_pii").passed


def test_a_filled_in_name_field_fails_the_corpus():
    documents, chunks, counts = _paper_corpus("クラス CD  なまえ: ダト\nI. 動詞を選んで")
    assert not _result(check_past_papers(documents, chunks, counts), "past_paper_no_pii").passed


def test_a_score_fails_the_corpus():
    for leaked in (
        "文法 5/19",
        "得点: 29/30",
        # The header box as the model actually renders it: a table row, with
        # furigana and pipes between the label and the mark.
        "| 文法《ぶんぽう》 | 5/19 |",
        "ABUBAKAR MOHAMMED",
    ):
        documents, chunks, counts = _paper_corpus(f"トピック8 文法クイズ\n{leaked}")
        check = _result(check_past_papers(documents, chunks, counts), "past_paper_no_pii")
        assert not check.passed, leaked
        # The offending text is reported, so a false positive can be told from
        # a real leak without going back to the database.
        assert leaked.strip("| ")[:6] in check.detail or "…" in check.detail


def test_an_empty_score_box_is_not_a_score():
    # What a correctly redacted header looks like: the printed denominator
    # stays, the student's mark does not. Flagging this would fail the corpus
    # on every clean ingestion.
    documents, chunks, counts = _paper_corpus(
        "24秋 トピック8 文法クイズ\n| 文法《ぶんぽう》 | /19 |\n| 読解《どっかい》 | /8 |"
    )
    assert _result(check_past_papers(documents, chunks, counts), "past_paper_no_pii").passed


def test_a_blank_field_is_not_a_filled_one():
    # Measured on the real corpus: this exact shape flagged on 3 pages before
    # the blank characters were excluded. ＿ is not whitespace, so "label,
    # colon, any non-space" called a correctly emptied field a leak.
    for blanked in (
        "クラス: ＿＿＿＿＿",
        "なまえ ＿＿＿＿＿＿",
        "なまえ:",
        "ID: ______",
        # Two empty fields in a row, as Found 1 Papers prints them. The second
        # label is not the first one's value.
        "ID :\nName:",
        "ID:  Name:  /30",
    ):
        documents, chunks, counts = _paper_corpus(f"トピック8 文法クイズ\n{blanked}")
        assert _result(check_past_papers(documents, chunks, counts), "past_paper_no_pii").passed, (
            blanked
        )


def test_a_calendar_is_not_a_mark():
    # Found 1 Papers p15 prints a calendar for a date-vocabulary question, and
    # p10 a floor plan in a figure caption. An un-anchored fraction pattern
    # read both as scores — a tripwire that cries wolf on ordinary content is
    # one that gets switched off.
    documents, chunks, counts = _paper_corpus(
        "| 10/30 | 10/31 Today | 11/1 | 11/2 |\n[図: 3F CAI 4, CAI 5, CAI 6 / 2F CAI 1]"
    )
    assert _result(check_past_papers(documents, chunks, counts), "past_paper_no_pii").passed


def test_a_mark_allocation_is_not_a_score():
    # (1×10=10) and (0.5×8) are printed on every paper. Reading them as marks
    # would fail the corpus on every ingestion, and a check that always fails
    # is a check nobody reads.
    documents, chunks, counts = _paper_corpus(
        "I. ことばを選んでください。(1×10=10)\nII. 文を作ってください。(0.5×8)\n(1×4)"
    )
    assert _result(check_past_papers(documents, chunks, counts), "past_paper_no_pii").passed


def test_a_name_in_a_reading_passage_is_not_a_leak():
    # The passages are about people: "わたしの名前はリーです" is the paper's
    # own content, not a filled-in header field.
    documents, chunks, counts = _paper_corpus(
        "V. つぎの文章を読んでください。\nはじめまして。わたしの名前はリーです。"
        "クラスは月曜日と水曜日にあります。"
    )
    assert _result(check_past_papers(documents, chunks, counts), "past_paper_no_pii").passed


def test_the_checks_are_silent_when_no_paper_is_ingested():
    # A corpus with no past papers is a valid corpus; a check that fails for
    # everyone who has not ingested one teaches people to ignore the report.
    documents = [{"id": 1, "path": "book.pdf", "doc_type": "textbook"}]
    assert check_past_papers(documents, [{"document_id": 1, "content": "29/30"}], {1: 1}) == []


def test_a_paper_whose_topics_never_transcribed_is_reported():
    documents = [{"id": 1, "path": "p.pdf", "doc_type": "past_paper"}]
    chunks = [{"document_id": 1, "content": "文法クイズ", "metadata": {}}]
    assert not _result(check_past_papers(documents, chunks, {1: 1}), "past_paper_topics").passed
