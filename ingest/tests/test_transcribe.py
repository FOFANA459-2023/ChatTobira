"""Model cascade and quota classification — no network involved."""

from __future__ import annotations

import ingest.transcribe as transcribe_module
from ingest.transcribe import _cascade, _is_daily_quota


def test_daily_quota_detected_from_real_error_shape():
    # Shape observed live on 2026-08-08 from gemini-3.6-flash.
    message = (
        "429 RESOURCE_EXHAUSTED ... 'quotaId': "
        "'GenerateRequestsPerDayPerProjectPerModel-FreeTier' ..."
    )
    assert _is_daily_quota(message)


def test_per_minute_throttle_is_not_daily():
    assert not _is_daily_quota("429 ... 'quotaId': 'GenerateRequestsPerMinute' ...")


def test_cascade_prefers_configured_model_and_skips_exhausted(monkeypatch):
    monkeypatch.setattr(transcribe_module, "_exhausted", {"gemini-3.5-flash"})
    models = _cascade()
    assert "gemini-3.5-flash" not in models
    assert len(models) >= 2  # fallbacks remain


def test_cascade_deduplicates_configured_model(monkeypatch):
    monkeypatch.setattr(transcribe_module, "_exhausted", set())
    models = _cascade()
    assert len(models) == len(set(models))
