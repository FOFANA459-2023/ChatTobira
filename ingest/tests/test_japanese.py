"""Tokenizer behaviour that retrieval correctness depends on."""

from __future__ import annotations

from ingest.japanese import has_cjk, reading, strip_markup, tokenize


def test_kana_query_bridges_to_kanji():
    # A student typing みえる must reach material written 見える.
    assert "見える" in tokenize("みえる")


def test_conjugated_form_yields_dictionary_form():
    tokens = tokenize("音楽が聞こえます")
    assert "聞こえる" in tokens


def test_particles_are_kept():
    # In a grammar corpus, particles are subject matter, not stopwords.
    tokens = tokenize("窓から海が見える")
    assert "が" in tokens and "から" in tokens


def test_bare_grammar_point_survives():
    # Regression: parsed alone, たい tags as 記号 and was dropped entirely,
    # making T7 G5 unsearchable by its own name.
    tokens = tokenize("たいです")
    assert "たい" in tokens
    assert "たいです" in tokens  # verbatim label kept for exact match


def test_tilde_prefix_stripped_variant_emitted():
    tokens = tokenize("～ておく")
    assert "～ておく" in tokens
    assert "ておく" in tokens


def test_reading_is_hiragana():
    assert reading("窓から海が見える") == "まどからうみがみえる"


def test_reading_strips_markup():
    # Table pipes and furigana brackets must not pollute the kana index.
    md = "| 形 | 例 |\n|---|---|\n明日《あした》のために"
    out = reading(md)
    assert "|" not in out
    assert "《" not in out


def test_strip_markup_removes_furigana():
    assert "《" not in strip_markup("明日《あした》の授業《じゅぎょう》")


def test_has_cjk():
    assert has_cjk("見える")
    assert has_cjk("カタカナ")
    assert has_cjk("ひらがな")
    assert not has_cjk("Choose the best answer.")
    assert not has_cjk("")


def test_empty_input():
    assert tokenize("") == []
    assert tokenize("   ") == []
    assert reading("") == ""
