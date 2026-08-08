"""Resumable run state.

The vision stage is the long pole and runs against a rate-limited free tier, so
a run will be interrupted. Every stage records what it finished, keyed by the
source file's content hash — so re-running is cheap and editing one handout
re-processes only that handout.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import CONFIG


class Manifest:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (CONFIG.work_dir / "manifest.json")
        self._data: dict[str, Any] = {"stages": {}}
        if self.path.exists():
            try:
                self._data = json.loads(self.path.read_text("utf-8"))
            except json.JSONDecodeError:
                # A run killed mid-write leaves truncated JSON. Losing progress
                # is far better than crashing every subsequent run.
                self._data = {"stages": {}}
        self._data.setdefault("stages", {})

    def _stage(self, stage: str) -> dict[str, Any]:
        return self._data["stages"].setdefault(stage, {})

    def done(self, stage: str, key: str, sha: str) -> bool:
        return self._stage(stage).get(key, {}).get("sha") == sha

    def mark(self, stage: str, key: str, sha: str, **extra: Any) -> None:
        self._stage(stage)[key] = {"sha": sha, **extra}
        self.save()

    def get(self, stage: str, key: str) -> dict[str, Any] | None:
        return self._stage(stage).get(key)

    def all(self, stage: str) -> dict[str, Any]:
        return dict(self._stage(stage))

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), "utf-8")
        tmp.replace(self.path)
