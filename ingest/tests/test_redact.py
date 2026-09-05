"""Redaction of a scanned script's owner.

Every case here is either a shape observed on the real papers or a shape the
first version of these patterns got wrong. The false positives matter as much
as the true ones: a redactor that eats the reading passages destroys the
material the questions are about, and a detector that fires on every clean
page is one that gets switched off.
"""

from __future__ import annotations

from ingest.redact import find_identity, redact_identity


def test_a_filled_name_field_is_emptied():
    assert "ダト" not in redact_identity("クラス: CD  なまえ: ダト")
    assert "なまえ" in redact_identity("クラス: CD  なまえ: ダト")


def test_the_class_code_that_got_through_the_prompt():
    # Found 1 Papers p19, transcribed verbatim by the vision model despite the
    # prompt: 「クラス CD なまえ ＿＿＿」. No colon, so the colon-anchored
    # pattern missed it entirely — which is the whole reason this pass exists.
    redacted = redact_identity("24秋 トピック4 文法クイズ\nクラス CD なまえ ＿＿＿＿＿")
    assert "CD" not in redacted
    assert "クラス" in redacted
    assert "なまえ ＿＿＿＿＿" in redacted
    assert "24秋 トピック4 文法クイズ" in redacted


def test_a_romanised_name_in_the_header_is_removed():
    assert "ABUBAKAR" not in redact_identity("Hiragana Quiz\nABUBAKAR MOHAMMED\nID:")


def test_the_papers_own_people_and_places_survive():
    """Everything below the first numbered section is question content.

    All three of these are real pages, and redacting any of them would delete
    the question. This is the case that a purely pattern-based redactor gets
    wrong: the papers are ABOUT names, addresses and signs.
    """
    pages = [
        # Foundation 3 p21: a 履歴書 the kanji questions are asked about.
        (
            (
                "III. 下の (1) から (7) の漢字をひらがなで書いてください。(1点×9)\n"
                "| **(1) 履歴書**<br>名前: ナンシー・リー<br>住所: 別府市十文字原 1-1 |"
            ),
            "ナンシー・リー",
        ),
        # Foundation 3 p6: a sign board, and the question is what it means.
        (
            (
                "IV. 下のサインは どういう意味ですか。(1点×2)\n"
                "(1) これは「ここに（ 入りたい / 入るな ）」という意味です。[図: 立入禁止 KEEP OUT]"
            ),
            "KEEP OUT",
        ),
        # Foundation 1 p12: name the picture in katakana.
        (
            (
                "III. Write the word for each picture in Katakana. (1×3)\n"
                "(1) [写真: SUPER MARKET の絵]  ( ＿＿＿＿ )"
            ),
            "SUPER MARKET",
        ),
    ]
    for page, content in pages:
        assert content in redact_identity(page), content
        # The checker must agree, or it fails every clean ingestion on exactly
        # the text the redactor deliberately left alone.
        assert find_identity(page) == [], content


def test_the_header_stops_at_the_first_section():
    from ingest.redact import header_span

    # The student's own fields sit above 「I.」; the paper's content sits below.
    page = "24秋 トピック4 文法クイズ\nクラス CD なまえ ＿＿\n\nI. Choose the answer"
    head = page[: header_span(page)]
    assert "クラス CD" in head
    assert "I. Choose" not in head

    # A section number on the very first line leaves no header at all, which
    # is what protects the résumé and the sign board.
    assert header_span("III. 名前: ナンシー・リー") == 0
    # A page printing no section number at all still gets a bounded header,
    # rather than having the whole page treated as one.
    assert header_span("あ" * 500) == 200


def test_a_mark_keeps_the_printed_denominator():
    # "文法 5/19" is the student's score; "文法 /19" is what the blank paper
    # says. The denominator is printed on the sheet and is worth keeping —
    # it tells the quiz generator how the section is weighted.
    assert redact_identity("得点: 29/30").strip().endswith("/30")
    assert "29" not in redact_identity("得点: 29/30")
    assert "5" not in redact_identity("| 文法《ぶんぽう》 | 5/19 |")
    assert "/19" in redact_identity("| 文法《ぶんぽう》 | 5/19 |")


def test_an_already_clean_page_is_left_alone():
    clean = (
        "24秋 トピック8 文法クイズ\n"
        "クラス ＿＿＿＿＿ なまえ ＿＿＿＿＿＿＿＿＿＿\n"
        "| 文法 | /19 |\n"
        "I. 動詞を選んで、正しい形にかえて、（　）に書いてください。(1×7)\n"
        "(1) デパートで（　）まえに ATM でお金をおろします。"
    )
    assert redact_identity(clean) == clean
    assert find_identity(clean) == []


def test_the_reading_passages_survive():
    # 名前 and クラス are ordinary words in these passages, and the passage is
    # the thing the ○× questions are about — redacting into it would destroy
    # the question.
    passage = (
        "はじめまして。わたしの名前はリーです。"
        "クラスは月曜日と水曜日にあります。"
        "先週の金曜日、国の友だちが日本に来ました。"
    )
    assert redact_identity(passage) == passage
    assert find_identity(passage) == []


def test_a_calendar_and_a_floor_plan_survive():
    # Found 1 Papers p15 and p10. An unanchored fraction pattern read both as
    # scores and failed the whole corpus.
    content = "| 10/30 | 10/31 Today | 11/1 |\n[図: 3F CAI 4, CAI 5, CAI 6 / 2F CAI 1]"
    assert redact_identity(content) == content
    assert find_identity(content) == []


def test_two_empty_fields_in_a_row_survive():
    # "ID :\nName:" (p1) and "ID:  Name:  /30" (p3). A pattern that stepped
    # over the gap read the second label as the first one's value.
    for header in ("ID :\nName:", "ID:  Name:  /30"):
        assert find_identity(header) == [], header
        assert redact_identity(header) == header, header


def test_mark_allocations_survive():
    allocations = "(1×10=10) (0.5×8) (1×4) (2×2)"
    assert redact_identity(allocations) == allocations
    assert find_identity(allocations) == []


def test_find_identity_reports_what_it_matched():
    # Reported so a false positive can be told from a real leak without going
    # back to the database.
    found = dict(find_identity("なまえ: ダト"))
    assert "filled_identity_field" in found
    assert "ダト" in found["filled_identity_field"]


def test_redaction_leaves_nothing_for_the_detector():
    # A real header, every field filled. The two halves must agree: what the
    # redactor removes is what the detector would have flagged.
    dirty = (
        "Hiragana Quiz\nABUBAKAR MOHAMMED\nID: A12345  なまえ: ダト\n"
        "クラス CD\n得点 29/30\n| 文法 | 5/19 |"
    )
    assert find_identity(dirty)
    assert find_identity(redact_identity(dirty)) == []
