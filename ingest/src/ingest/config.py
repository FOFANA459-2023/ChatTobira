"""Environment-backed configuration for the ingestion pipeline."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the repo root regardless of where the CLI is invoked from.
_REPO_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(_REPO_ROOT / ".env")


def _req(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not set. Copy .env.example to .env and fill it in.")
    return value


def _path(name: str, default: str) -> Path:
    raw = os.getenv(name, default).strip() or default
    p = Path(raw)
    return p if p.is_absolute() else (_REPO_ROOT / p).resolve()


@dataclass(frozen=True)
class Config:
    repo_root: Path = _REPO_ROOT
    materials_root: Path = field(default_factory=lambda: _path("MATERIALS_ROOT", "."))
    work_dir: Path = field(default_factory=lambda: _path("WORK_DIR", "./.work"))

    vision_model: str = os.getenv("VISION_MODEL", "gemini-2.5-flash")
    embed_model: str = os.getenv("EMBED_MODEL", "gemini-embedding-001")
    embed_dim: int = int(os.getenv("EMBED_DIM", "768"))

    render_dpi: int = int(os.getenv("RENDER_DPI", "200"))
    pages_per_request: int = int(os.getenv("VISION_PAGES_PER_REQUEST", "4"))
    vision_throttle: float = float(os.getenv("VISION_THROTTLE_SECONDS", "7"))

    citation_quote_chars: int = int(os.getenv("CITATION_QUOTE_CHARS", "200"))

    @property
    def citable_sources(self) -> set[str]:
        """Relative paths of the only documents allowed to appear in a citation.

        Class handouts still ground answers; they are simply never named.
        """
        raw = os.getenv("CITABLE_SOURCES", "")
        return {p.strip().replace("\\", "/") for p in raw.split("|") if p.strip()}

    @property
    def google_api_key(self) -> str:
        return _req("GOOGLE_API_KEY")

    @property
    def supabase_url(self) -> str:
        return _req("SUPABASE_URL")

    @property
    def supabase_key(self) -> str:
        return _req("SUPABASE_SERVICE_ROLE_KEY")

    # Derived working directories -------------------------------------------

    @property
    def pdf_dir(self) -> Path:
        """Office files converted to PDF land here."""
        return self.work_dir / "pdf"

    @property
    def page_dir(self) -> Path:
        """Rendered page images. OCR input only — never served to users."""
        return self.work_dir / "pages"

    @property
    def text_dir(self) -> Path:
        """Per-page Markdown produced by the vision model."""
        return self.work_dir / "text"

    def ensure_dirs(self) -> None:
        for d in (self.work_dir, self.pdf_dir, self.page_dir, self.text_dir):
            d.mkdir(parents=True, exist_ok=True)


CONFIG = Config()
