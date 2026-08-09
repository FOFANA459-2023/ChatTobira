"""Model cascade and quota classification — no network involved."""

from __future__ import annotations

from pathlib import Path

import pytest

import ingest.transcribe as transcribe_module
from ingest.config import CONFIG
from ingest.transcribe import (
    OutputTruncatedError,
    _cascade,
    _is_daily_quota,
    _transcribe_one,
)


def _use_keys(monkeypatch, *keys: str) -> None:
    """Pin exactly these Google keys for one test.

    Every slot is set explicitly because a developer's .env is loaded at
    import time; leaving _2.._5 to chance makes the pair counts differ
    between a laptop and CI.
    """
    monkeypatch.setenv("GOOGLE_API_KEY", keys[0] if keys else "")
    for n in range(2, 6):
        monkeypatch.setenv(f"GOOGLE_API_KEY_{n}", keys[n - 1] if len(keys) >= n else "")


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
    _use_keys(monkeypatch, "key-one")
    monkeypatch.setattr(transcribe_module, "_exhausted", {(0, CONFIG.vision_model)})
    pairs = _cascade()
    assert (0, CONFIG.vision_model) not in pairs
    assert len(pairs) >= 2  # fallbacks remain


def test_cascade_deduplicates_configured_model(monkeypatch):
    _use_keys(monkeypatch, "key-one")
    monkeypatch.setattr(transcribe_module, "_exhausted", set())
    pairs = _cascade()
    assert len(pairs) == len(set(pairs))


def test_second_key_doubles_the_daily_budget(monkeypatch):
    """The entire point of GOOGLE_API_KEY_2: free-tier buckets are per project
    AND per model, so N keys x M models gives N*M independent budgets."""
    monkeypatch.setattr(transcribe_module, "_exhausted", set())
    _use_keys(monkeypatch, "key-one")
    one_key = _cascade()
    _use_keys(monkeypatch, "key-one", "key-two")
    two_keys = _cascade()

    assert len(two_keys) == 2 * len(one_key)
    assert len(set(two_keys)) == len(two_keys)


def test_cascade_tries_the_best_model_on_every_key_before_dropping_down(monkeypatch):
    """A weaker model on key one must never be preferred over the best model
    on key two — quality first, quota second."""
    _use_keys(monkeypatch, "key-one", "key-two")
    monkeypatch.setattr(transcribe_module, "_exhausted", set())
    pairs = _cascade()

    assert pairs[0] == (0, CONFIG.vision_model)
    assert pairs[1] == (1, CONFIG.vision_model)


def test_exhausting_one_key_leaves_the_other_usable(monkeypatch):
    _use_keys(monkeypatch, "key-one", "key-two")
    monkeypatch.setattr(transcribe_module, "_exhausted", {(0, CONFIG.vision_model)})
    pairs = _cascade()

    assert (0, CONFIG.vision_model) not in pairs
    assert (1, CONFIG.vision_model) in pairs


def test_planning_the_cascade_needs_no_credentials(monkeypatch):
    """Regression: reading the keys inside _cascade made every test that only
    inspected the plan fail wherever no key was configured, CI included."""
    _use_keys(monkeypatch)
    monkeypatch.setattr(transcribe_module, "_exhausted", set())
    assert _cascade() == []


# --- surviving a page the model cannot finish --------------------------------
#
# Observed live on the Foundation 1 & 2 table of contents: dot leaders sent the
# model into emitting U+2026 forever, 65,520 tokens, truncated mid-escape. It
# crashed the run at page 7 and forfeited the other 283.

PAGE = Path("0007.png")
GOOD = {"markdown": "# 目次", "has_japanese": True}


def _calls_returning(*outcomes):
    """Stub _call that yields each outcome in turn; exceptions are raised."""
    seen: list[float] = []

    def call(images, count, temperature=0.0):
        seen.append(temperature)
        outcome = outcomes[len(seen) - 1]
        if isinstance(outcome, Exception):
            raise outcome
        return [outcome]

    call.temperatures = seen
    return call


def test_page_that_transcribes_first_time_costs_one_request(monkeypatch):
    call = _calls_returning(GOOD)
    monkeypatch.setattr(transcribe_module, "_call", call)
    warnings: list[str] = []

    assert _transcribe_one(PAGE, warnings.append) == GOOD
    assert call.temperatures == [0.0]
    assert warnings == []


def test_runaway_page_is_retried_with_a_temperature_that_breaks_the_loop(monkeypatch):
    call = _calls_returning(OutputTruncatedError("ran away"), GOOD)
    monkeypatch.setattr(transcribe_module, "_call", call)
    warnings: list[str] = []

    assert _transcribe_one(PAGE, warnings.append) == GOOD
    # Greedy decoding is the failure; the retry must not also be greedy.
    assert call.temperatures[0] == 0.0
    assert call.temperatures[1] > 0.0
    assert len(warnings) == 1
    assert "recovered" in warnings[0]


def test_page_no_model_can_finish_is_recorded_empty_not_raised(monkeypatch):
    """The whole point: one unreadable page must not cost the 283 after it."""
    call = _calls_returning(
        OutputTruncatedError("ran away"), OutputTruncatedError("ran away again")
    )
    monkeypatch.setattr(transcribe_module, "_call", call)
    warnings: list[str] = []

    assert _transcribe_one(PAGE, warnings.append) == {}
    assert len(warnings) == 1
    assert "skipped" in warnings[0]


def test_recovery_works_without_a_warning_callback(monkeypatch):
    monkeypatch.setattr(
        transcribe_module,
        "_call",
        _calls_returning(OutputTruncatedError("x"), OutputTruncatedError("y")),
    )
    assert _transcribe_one(PAGE, None) == {}


def test_quota_errors_still_propagate(monkeypatch):
    """Only truncation is survivable. An exhausted quota must still stop the
    run so the checkpoint is kept and the work resumes tomorrow."""
    monkeypatch.setattr(
        transcribe_module,
        "_call",
        _calls_returning(transcribe_module.DailyQuotaError("spent")),
    )
    with pytest.raises(transcribe_module.DailyQuotaError):
        _transcribe_one(PAGE, None)
