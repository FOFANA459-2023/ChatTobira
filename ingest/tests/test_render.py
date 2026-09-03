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
import pytest

from ingest.config import CONFIG
from ingest.discover import SourceDoc
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


def _one_page_pdf(tmp_path: Path) -> Path:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 300), "content", fontsize=24)
    out = tmp_path / "source.pdf"
    doc.save(out)
    doc.close()
    return out


@pytest.fixture()
def render_env(tmp_path, monkeypatch):
    """render.py with its work dir pointed at tmp_path."""
    monkeypatch.setenv("WORK_DIR", str(tmp_path / ".work"))
    import ingest.config as config_module
    from ingest import render as render_module

    monkeypatch.setattr(render_module, "CONFIG", config_module.Config())
    return render_module


def _doc(sha: str) -> SourceDoc:
    return SourceDoc(
        path=f"{sha}.pdf",
        title=sha,
        level=None,
        topic=None,
        topics=[],
        doc_type="textbook",
        is_citable=True,
        grammar_point=None,
        needs_conversion=False,
        content_sha=sha,
        size_bytes=1,
    )


def test_render_replaces_a_truncated_page_from_an_interrupted_run(tmp_path, render_env):
    """A zero-length PNG is an interrupted write, not a cached page.

    Seen live: a run killed mid-write left an empty 0117.png that the
    exists() check trusted, and the run only found out 117 pages later, when
    the vision stage could not read the image and the whole document died.
    """
    pdf = _one_page_pdf(tmp_path)
    doc = _doc("deadbeefcafe0000")

    first = render_env.render_pages(doc, pdf)[0]
    assert first.stat().st_size > 0

    first.write_bytes(b"")  # the interrupted write
    again = render_env.render_pages(doc, pdf)[0]
    assert again.stat().st_size > 0, "a truncated page must be re-rendered, not trusted"
    pymupdf.Pixmap(str(again))  # and it must be a readable image


def test_render_leaves_no_temporary_files_behind(tmp_path, render_env):
    pdf = _one_page_pdf(tmp_path)
    page = render_env.render_pages(_doc("feedface00110000"), pdf)[0]
    assert list(page.parent.glob("*.tmp")) == []


def test_render_reuses_a_good_page_instead_of_redrawing_it(tmp_path, render_env):
    """The cache must still be a cache: an intact page is never re-rendered."""
    pdf = _one_page_pdf(tmp_path)
    doc = _doc("00c0ffee00220000")
    first = render_env.render_pages(doc, pdf)[0]
    stamp = first.stat().st_mtime_ns
    again = render_env.render_pages(doc, pdf)[0]
    assert again.stat().st_mtime_ns == stamp
