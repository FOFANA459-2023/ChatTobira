"""Blank-page detection.

This gate decides whether a page is sent to the vision model at all, so a
false positive silently drops textbook content from the corpus while a false
negative merely wastes one request. The tests are weighted accordingly:
most of them assert that sparse pages are still transcribed.

Detection works on rendered pixels, not glyphs, so Latin text exercises the
same code path as Japanese and avoids depending on a CJK font being present.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf

from ingest.config import CONFIG
from ingest.render import BLANK_INK_RATIO, ink_ratio, is_blank


def _page_image(tmp_path: Path, name: str, draw=None) -> Path:
    """Render one synthetic PDF page at the pipeline's real DPI."""
    doc = pymupdf.open()
    page = doc.new_page()
    if draw is not None:
        draw(page)
    zoom = CONFIG.render_dpi / 72.0
    pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
    out = tmp_path / f"{name}.png"
    pixmap.save(out)
    doc.close()
    return out


def test_empty_page_is_blank(tmp_path):
    assert is_blank(_page_image(tmp_path, "empty"))


def test_page_bearing_only_a_page_number_is_still_transcribed(tmp_path):
    """The sparsest page that carries real information: book_page is how a
    citation tells a student which page of the physical book to open."""

    def draw(page):
        page.insert_text((300, 780), "127", fontsize=11)

    image = _page_image(tmp_path, "number-only", draw)
    assert not is_blank(image)


def test_single_line_of_text_is_not_blank(tmp_path):
    def draw(page):
        page.insert_text((72, 200), "Lesson 3 practice", fontsize=14)

    assert not is_blank(_page_image(tmp_path, "one-line", draw))


def test_section_title_alone_is_not_blank(tmp_path):
    def draw(page):
        page.insert_text((72, 300), "Chapter 5", fontsize=28)

    assert not is_blank(_page_image(tmp_path, "title-only", draw))


def test_dense_page_sits_far_above_the_threshold(tmp_path):
    def draw(page):
        for i in range(40):
            page.insert_text((72, 80 + i * 18), "practice sentence " * 4, fontsize=11)

    ratio = ink_ratio(_page_image(tmp_path, "dense", draw))
    assert ratio > BLANK_INK_RATIO * 10


def test_threshold_keeps_a_margin_below_the_sparsest_real_content(tmp_path):
    """Calibration guard, and a regression test for a threshold that was once
    24x too high: it was tuned against a dense scanned textbook, where the
    lightest page measures 0.019, and would have deleted any page carrying a
    single line of text. The gap between blank and sparse is what matters."""

    def number_only(page):
        page.insert_text((300, 780), "127", fontsize=11)

    blank = ink_ratio(_page_image(tmp_path, "margin-blank"))
    sparsest = ink_ratio(_page_image(tmp_path, "margin-sparse", number_only))

    assert blank < BLANK_INK_RATIO
    # The sparsest page that still carries information must clear the
    # threshold with room to spare, not squeak past it.
    assert sparsest > BLANK_INK_RATIO * 2
