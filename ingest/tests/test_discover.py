"""Metadata derivation from folder and file names.

Every regression case here was a real bug found against the actual tree.
"""

from __future__ import annotations

from ingest.discover import discover


def _by_name(docs, needle: str):
    matches = [d for d in docs if needle in d.path]
    assert matches, f"no document matching {needle!r}"
    return matches[0]


def test_citable_is_exactly_the_three_textbooks(materials_root):
    docs = discover()
    citable = sorted(d.path for d in docs if d.is_citable)
    assert citable == [
        "Foundation 2/Foundation 1 & 2.pdf",
        "Intermediate/Tobira Intermediate Japanese.pdf",
        "Intermediate/Tobira Kanji and Vocabulary Intermediate Japanese.pdf",
    ]
    for d in docs:
        if d.is_citable:
            assert d.doc_type == "textbook"
            assert d.topics == [], "textbooks span all topics; pinning one is wrong"


def test_filename_topic_beats_folder_topic(materials_root):
    # T8G3.pdf lives in the T7 folder but is T8 content.
    doc = _by_name(discover(), "T8G3")
    assert doc.topic == "T8"


def test_topic_glued_to_word_is_found(materials_root):
    # Regression: "Kanji storyT16.pdf" inherited T14 from its folder because the
    # topic regex refused a letter immediately before the T.
    doc = _by_name(discover(), "Kanji storyT16")
    assert doc.topic == "T16"


def test_topic_range_expands(materials_root):
    # Regression: "T15-T17ふくしゅう…" collapsed to T15 only.
    doc = _by_name(discover(), "T15-T17")
    assert doc.topics == ["T15", "T16", "T17"]


def test_multi_topic_folder_list_expands(materials_root):
    # "T14, 15, 16 Materials used in class" — a file with no topic of its own
    # inherits the full folder list.
    doc = _by_name(discover(), "文法復習シート_T14")
    assert doc.topic == "T14"


def test_answer_key_detection_wins(materials_root):
    doc = _by_name(discover(), "T12(答え)")
    assert doc.doc_type == "answer_key"
    doc = _by_name(discover(), "こたえ")
    assert doc.doc_type == "answer_key"


def test_levels(materials_root):
    docs = discover()
    assert _by_name(docs, "T6 G1").level == "F2"
    assert _by_name(docs, "Honorifics").level == "F3"
    assert _by_name(docs, "Tobira Intermediate Japanese").level == "INT"


def test_office_files_need_conversion(materials_root):
    docs = discover()
    assert _by_name(docs, "Honorifics.doc").needs_conversion
    assert _by_name(docs, "～ところ.pptx").needs_conversion
    assert not _by_name(docs, "T6 G1.pdf").needs_conversion


def test_no_year_number_mistaken_for_topic(materials_root):
    # "26春F3_0409.pptx"-style names must not yield topics from digit runs.
    docs = discover()
    for d in docs:
        if d.topic:
            n = int(d.topic[1:])
            assert 1 <= n <= 30, f"{d.path} produced implausible topic {d.topic}"
