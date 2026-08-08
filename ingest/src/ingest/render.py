"""Convert Office files to PDF, then render every PDF page to an image.

Page images are the input to vision transcription and nothing else. They are
never uploaded and never served — citations are text-only.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pymupdf

from .config import CONFIG
from .discover import SourceDoc

LIBREOFFICE_CANDIDATES = ("soffice", "libreoffice")


def _libreoffice() -> str:
    for name in LIBREOFFICE_CANDIDATES:
        if path := shutil.which(name):
            return path
    raise RuntimeError(
        "LibreOffice not found. The .ppt/.pptx/.doc/.docx sources cannot be "
        "converted without it. Install it (`apt install libreoffice`) or run "
        "ingestion on the Linux worker rather than on Windows."
    )


def to_pdf(doc: SourceDoc) -> Path:
    """Return a PDF for this source, converting via LibreOffice if needed."""
    source = CONFIG.materials_root / doc.path
    if not doc.needs_conversion:
        return source

    out_dir = CONFIG.pdf_dir / doc.content_sha[:12]
    out_dir.mkdir(parents=True, exist_ok=True)
    expected = out_dir / f"{source.stem}.pdf"
    if expected.exists():
        return expected

    subprocess.run(
        [
            _libreoffice(),
            "--headless",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            str(out_dir),
            str(source),
        ],
        check=True,
        capture_output=True,
        timeout=300,
    )

    if not expected.exists():
        # LibreOffice occasionally normalises the output name.
        produced = list(out_dir.glob("*.pdf"))
        if not produced:
            raise RuntimeError(f"LibreOffice produced no PDF for {doc.path}")
        produced[0].rename(expected)

    return expected


def render_pages(doc: SourceDoc, pdf_path: Path) -> list[Path]:
    """Render each page to PNG at the configured DPI. Returns paths in order."""
    out_dir = CONFIG.page_dir / doc.content_sha[:12]
    out_dir.mkdir(parents=True, exist_ok=True)

    zoom = CONFIG.render_dpi / 72.0
    matrix = pymupdf.Matrix(zoom, zoom)
    pages: list[Path] = []

    with pymupdf.open(pdf_path) as pdf:
        for index in range(pdf.page_count):
            target = out_dir / f"{index + 1:04d}.png"
            if not target.exists():
                pixmap = pdf.load_page(index).get_pixmap(matrix=matrix)
                pixmap.save(target)
            pages.append(target)

    return pages


def page_count(pdf_path: Path) -> int:
    with pymupdf.open(pdf_path) as pdf:
        return pdf.page_count
