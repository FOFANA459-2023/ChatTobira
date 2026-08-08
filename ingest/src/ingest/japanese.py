"""Japanese morphological analysis for the lexical half of hybrid search.

Postgres ships no Japanese full-text configuration: `to_tsvector('japanese', …)`
does not exist, and the 'simple' config would treat an entire Japanese sentence
as one token because there are no spaces to split on. So we segment here, at
ingest time, and store space-joined morphemes that the 'simple' config can index.

The same function must run over the user's query at search time — mismatched
segmentation between index and query silently returns nothing.
"""

from __future__ import annotations

import re
from functools import lru_cache

import jaconv

# Drop only true punctuation and whitespace.
#
# 記号 is deliberately NOT dropped. Parsed in isolation, a bare grammar point
# like たいです tags たい as 記号 (lemma タイ) because there is no verb stem to
# attach to — inside 食べたいです it correctly tags 助動詞. Bare grammar points
# are exactly what headings, filenames, and student queries contain, so dropping
# 記号 made T7 G5 unsearchable by name. 記号 also covers Latin letters, which we
# want indexed anyway for the English glosses throughout this corpus.
_DROP_POS = {"補助記号", "空白"}

# Below this length, an input is a label (grammar point, heading) rather than
# prose, and is also emitted verbatim so it stays searchable as written.
_LABEL_MAX_CHARS = 16
_CJK_RE = re.compile(r"[぀-ゟ゠-ヿ一-鿿ｦ-ﾟ]")


@lru_cache(maxsize=1)
def _tagger():
    from fugashi import Tagger

    return Tagger()


def has_cjk(text: str) -> bool:
    """True if the text contains kana or kanji.

    Used by `ingest verify` as the tripwire for a regression back to broken text
    extraction: if most chunks stop containing CJK, transcription has failed.
    """
    return bool(_CJK_RE.search(text))


def _feat(word, name: str) -> str | None:
    value = getattr(word.feature, name, None)
    return value if value and value != "*" else None


def tokenize(text: str) -> list[str]:
    """Segment into search tokens: surface forms plus dictionary forms.

    Both are emitted so that 見えます in a query matches 見える in the material.
    Particles and auxiliaries are deliberately KEPT — in a grammar-learning
    corpus they are the subject matter, not stopwords. A question comparing
    〜に and 〜で is precisely a query about particles, and dropping them would
    make it unanswerable.
    """
    if not text.strip():
        return []

    tokens: list[str] = []
    for word in _tagger()(text):
        if _feat(word, "pos1") in _DROP_POS:
            continue
        surface = word.surface.strip()
        if not surface:
            continue
        tokens.append(surface)

        lemma = _feat(word, "lemma")
        if lemma and lemma != surface:
            tokens.append(lemma)

    # Keep short labels searchable exactly as written. Segmentation of a bare
    # pattern is unreliable precisely because it lacks surrounding context.
    stripped = text.strip()
    if len(stripped) <= _LABEL_MAX_CHARS:
        tokens.append(stripped)
        # Grammar points are written with a leading tilde in this course
        # (～ところ, ～ておく); students rarely type it.
        bare = stripped.lstrip("～〜~").strip()
        if bare and bare != stripped:
            tokens.append(bare)

    # Preserve order, drop duplicates.
    return list(dict.fromkeys(tokens))


_FURIGANA_RE = re.compile(r"《[^》]*》")
_MARKDOWN_RE = re.compile(r"^#{1,6}\s*|[|*_`>]|^\s*-{2,}.*$", re.MULTILINE)


def strip_markup(text: str) -> str:
    """Remove Markdown scaffolding and furigana annotations.

    Used only for the reading index. Table pipes and 《》 brackets are not kana,
    and letting them through means a kana query can match on punctuation noise.
    The furigana itself is dropped rather than kept because the analyser derives
    the reading from the kanji anyway, and keeping both double-counts it.
    """
    return _MARKDOWN_RE.sub(" ", _FURIGANA_RE.sub("", text))


def reading(text: str) -> str:
    """Hiragana reading of the text, for kana↔kanji matching.

    A student who types みえる should reach material written 見える. Storing the
    reading alongside the surface form is what closes that gap; it matters a lot
    for beginners who have heard a word but not yet learned its kanji.
    """
    cleaned = strip_markup(text).strip()
    if not cleaned:
        return ""

    parts: list[str] = []
    for word in _tagger()(cleaned):
        kana = _feat(word, "kana") or _feat(word, "pron")
        parts.append(jaconv.kata2hira(kana) if kana else word.surface)
    return "".join(parts)


def tokens_for_query(text: str) -> list[str]:
    """Query-side segmentation. Must stay identical to the index side."""
    return tokenize(text)
