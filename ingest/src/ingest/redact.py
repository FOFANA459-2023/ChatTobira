"""Strip a student's identity out of a scanned past paper.

The past-paper sources are photographs of one student's marked script, and the
transcription prompt is told at length not to copy their name, ID, class or
score. It mostly obeys. "Mostly" is the problem: on Found 1 Papers p19 it
carried over `クラス CD`, and the failure is silent — the corpus keeps working
and simply serves a classmate's class code to the cohort.

So the prompt is the first line and this is the second: a deterministic pass
over the transcribed text before it is chunked, and the same patterns used
again by `ingest verify` afterwards to say whether anything got through. Both
halves live here so they cannot drift apart — a redactor and a detector that
disagree is worse than either alone, because the detector then certifies what
the redactor missed.

The patterns are anchored on the printed FIELD LABEL. That is what makes them
safe to run over a whole paper: a label with a value beside it is a filled-in
field, while the same word inside a reading passage ("わたしの名前はリーです",
「クラスは月曜日です」) is prose, and prose must survive untouched — it is the
material the questions are about.
"""

from __future__ import annotations

import re

# Fields that identify whose script this was.
_LABEL = r"(?:なまえ|名前|氏名|Name|ID|学籍番号|クラス|Class|Student)"

# What an EMPTY field looks like once transcribed: the label, then the printed
# rule the student was meant to write on — or, in the header box, the printed
# denominator of a score whose numerator was correctly dropped ("Name:  /30").
# Listed explicitly because a rule is a non-space character, and a naive
# "label followed by anything" reading flagged every clean paper in the corpus.
_BLANK = r"[＿_﹏–—\-\s　.．。:：|/／]"

# Labels for a mark. The header box prints these against a denominator.
_SCORE_LABEL = r"(?:文法|読解|漢字|語彙|得点|点数|合計|Score|Total|Mark)"

# A value written after a label with no colon between them: 「クラス CD」,
# "Student A12345". Restricted to capitals and digits, which is what a class
# code or a student number looks like and what ordinary Japanese prose never
# is — 「クラスは月曜日にあります」 has no Latin after the label at all, so it
# is left alone.
_CODE_VALUE = r"[A-Z0-9]{1,12}\b"

IDENTITY_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # "なまえ: ダト" — a label whose value was filled in.
    #
    # The value must sit on the label's own line and must not be the NEXT
    # label: these papers print "ID :\nName:" and "ID:  Name:  /30", two empty
    # fields in a row, and a pattern that stepped over the gap read the second
    # label as the first one's value.
    (
        "filled_identity_field",
        re.compile(rf"({_LABEL}[ \t　]*[:：][ \t　]*)(?!{_BLANK}|{_LABEL})([^\s\n]+)"),
    ),
    # 「クラス CD」 — the same thing without the colon. Kept separate because
    # it cannot afford the looser value rule above: 名前 and クラス both occur
    # mid-sentence in the reading passages.
    ("identity_code", re.compile(rf"({_LABEL}[ \t　]*[:：]?[ \t　]+)({_CODE_VALUE})")),
    # A mark against a section or a total: "得点: 29/30", or the header box
    # rendered as a table, "| 文法《ぶんぽう》 | 5/19 |". The gap allows for the
    # furigana and pipes between label and number but contains no digit of its
    # own, so it cannot reach across into unrelated text.
    #
    # Deliberately anchored on the label. A bare fraction is NOT a mark here:
    # these papers print calendars ("10/30 | 10/31 Today") and figure captions
    # ("3F CAI 4 / 2F CAI 1") that look identical, and an unanchored pattern
    # read both as scores. A real leak always has its label beside it, because
    # that is how a score box is printed — and an emptied box transcribes as
    # "文法 /19", with no numerator for this to match.
    ("score", re.compile(rf"({_SCORE_LABEL}[^\n\d]{{0,12}})(\d{{1,3}}\s*[/／]\s*\d{{1,3}})")),
    # Two adjacent all-caps Latin words: a romanised personal name written
    # across the top of the sheet. The corpus's real Latin content is single
    # tokens (APU, ATM, DVD, CAI) and ordinary English sentences.
    ("latin_name", re.compile(r"\b([A-Z]{3,})(\s+[A-Z]{3,})\b")),
]


# Where the header stops and the paper begins.
#
# Every one of these patterns is safe only above the first numbered section,
# and the reason is that the papers are ABOUT people and places. Measured on
# the corpus:
#
#   * Foundation 3 p21 prints a 履歴書 for the kanji questions to be asked
#     about — 「名前: ナンシー・リー」, a fictional applicant. That is a filled-in
#     name field, and it is the subject of seven questions.
#   * Foundation 3 p6 shows a sign reading 「立入禁止 KEEP OUT」 and asks what
#     it means. Two capitalised words, and the answer depends on them.
#   * Foundation 1 p12 captions a picture "[写真: SUPER MARKET の絵]" and asks
#     for that word in katakana.
#
# Redacting any of those would delete the question. The student's OWN name,
# class and mark are never down there: they are written at the top of the
# sheet, above the first 「I.」. So that marker is the boundary, capped by a
# character budget for the rare page that prints no section number at all.
_SECTION_RE = re.compile(
    r"^[ \t　]*(?:[IVXivx]{1,5}[.．、)]|\d{1,2}[.．、)]|問題\s*\d)",
    re.MULTILINE,
)
HEADER_CHARS = 200


def header_span(text: str) -> int:
    """How many leading characters of a page are its header block."""
    match = _SECTION_RE.search(text)
    limit = match.start() if match else len(text)
    return min(limit, HEADER_CHARS)


def redact_identity(text: str) -> str:
    """Blank the identifying value beside each field label, keeping the label.

    The label survives on purpose. It is part of the printed paper and it is
    worth indexing — a generated practice paper should carry the same header
    fields the real one does — and keeping it makes the redaction visible to
    anyone reading a chunk, rather than leaving a gap they would have to infer.
    """

    def blank_mark(match: re.Match[str]) -> str:
        # Keep the printed denominator, drop the mark: "文法 5/19" is the
        # student's score, "文法 /19" is what the blank paper says.
        return match.group(1) + "/" + match.group(2).split("/")[-1].strip()

    def keep_label(match: re.Match[str]) -> str:
        return match.group(1).rstrip() + " "

    split = header_span(text)
    head, body = text[:split], text[split:]

    for name, pattern in IDENTITY_PATTERNS:
        if name == "latin_name":
            head = pattern.sub("", head)
        elif name == "score":
            head = pattern.sub(blank_mark, head)
        else:
            head = pattern.sub(keep_label, head)
    return head + body


def find_identity(text: str) -> list[tuple[str, str]]:
    """Every apparent leak in the text, as (pattern name, matched text).

    Used by `ingest verify` against what actually reached the database. Scoped
    the same way the redactor is, so a clean page has nothing to report and the
    check can be trusted to mean something when it fires. The match itself is
    returned so a false positive can be told from a real leak without going
    back to the database.
    """
    head = text[: header_span(text)]
    return [
        (name, match.group().strip())
        for name, pattern in IDENTITY_PATTERNS
        for match in pattern.finditer(head)
    ]
