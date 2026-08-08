"""Shared fixtures.

CI never has the real course materials (they are copyrighted and gitignored),
so every test that needs a materials tree builds a synthetic one mirroring the
real naming conventions.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

CITABLE = [
    "Foundation 2/Foundation 1 & 2.pdf",
    "Intermediate/Tobira Intermediate Japanese.pdf",
    "Intermediate/Tobira Kanji and Vocabulary Intermediate Japanese.pdf",
]

# Mirrors the naming patterns observed in the real tree, including the
# tricky cases that produced bugs: topic glued to a word (KanjistoryT16),
# topic ranges (T15-T17), files shelved in the wrong week's folder (T8G3
# inside the T7 folder), and multi-topic folders.
SYNTHETIC_TREE = CITABLE + [
    "Foundation 2/T6 Materials used in class/T6 G1.pdf",
    "Foundation 2/T6 Materials used in class/T6 Reading.pdf",
    "Foundation 2/T7 Materials used in class/T7G5たいです.pdf",
    "Foundation 2/T7 Materials used in class/T8G3.pdf",
    "Foundation 3/T12 Materials used in class-20260808/G1_7 Honorifics.doc",
    "Foundation 3/T12 Materials used in class-20260808/文法復習シート_T12(答え).pdf",
    "Foundation 3/T13 Materials used in class-20260808/G2 ～ところ.pptx",
    "Foundation 3/T14, 15, 16 Materials used in class/Kanji storyT16.pdf",
    "Foundation 3/T14, 15, 16 Materials used in class/文法復習シート_T14(答え).pdf",
    "Foundation 3/T17 Materials used in class-20260808/T15-T17ふくしゅうシートのこたえ.pdf",
]


@pytest.fixture()
def materials_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for rel in SYNTHETIC_TREE:
        target = tmp_path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"%stub%" + rel.encode("utf-8"))

    monkeypatch.setenv("MATERIALS_ROOT", str(tmp_path))
    monkeypatch.setenv("CITABLE_SOURCES", "|".join(CITABLE))
    monkeypatch.setenv("WORK_DIR", str(tmp_path / ".work"))

    # config reads the environment at import time; rebuild it for this test.
    import ingest.config as config_module

    monkeypatch.setattr(config_module, "CONFIG", config_module.Config())
    # discover imports CONFIG by value, so patch it there too.
    import ingest.discover as discover_module

    monkeypatch.setattr(discover_module, "CONFIG", config_module.Config())
    return tmp_path


def _stub_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key-not-real")


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch):
    """Unit tests must never call Google or Supabase."""
    os.environ.setdefault("GOOGLE_API_KEY", "")
    yield
