"""Model cascade and quota classification — no network involved."""

from __future__ import annotations

from pathlib import Path

import pytest

import ingest.transcribe as transcribe_module
from ingest.config import CONFIG
from ingest.transcribe import (
    ModelRejectedError,
    OutputTruncatedError,
    _call,
    _cascade,
    _generation_config,
    _is_daily_quota,
    _is_transient_transport,
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


def test_connection_drop_is_transient():
    """Regression: [WinError 10053] killed a run mid-textbook. The connection
    was aborted locally (antivirus/VPN/router) during a ~3-minute request —
    retryable, not fatal, and definitely not the page's fault."""
    import httpx

    winerror = ConnectionAbortedError(
        10053, "An established connection was aborted by the software in your host machine"
    )
    read_error = httpx.ReadError(str(winerror))
    read_error.__cause__ = winerror

    assert _is_transient_transport(read_error)
    assert _is_transient_transport(winerror)
    assert _is_transient_transport(httpx.ConnectTimeout("connect timed out"))
    assert _is_transient_transport(TimeoutError("read timed out"))


def test_wrapped_transport_failure_is_recognised_via_the_cause_chain():
    import httpx

    wrapper = RuntimeError("sdk wrapped it")
    wrapper.__cause__ = httpx.ReadError("connection lost")
    assert _is_transient_transport(wrapper)


def test_real_api_errors_are_not_mistaken_for_network_blips():
    """400s and schema failures must still surface: retrying a bad request
    forever would look like a hang, not a fix."""
    assert not _is_transient_transport(ValueError("bad response schema"))
    assert not _is_transient_transport(RuntimeError("400 INVALID_ARGUMENT"))


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


def test_lite_models_get_no_thinking_config():
    """Seen live: the lite models answer 400 INVALID_ARGUMENT to any
    thinking_config, while flash NEEDS thinking disabled or it spends the
    whole output budget deliberating. The config must differ per model."""
    assert _generation_config("gemini-3.5-flash", 0.0).thinking_config is not None
    assert _generation_config("gemini-3.5-flash-lite", 0.0).thinking_config is None
    assert _generation_config("gemini-3.1-flash-lite", 0.0).thinking_config is None


def test_a_model_rejecting_the_request_does_not_end_the_run(monkeypatch):
    """Regression: flash hit its daily quota, the cascade moved to flash-lite,
    flash-lite 400-ed on the request shape, and the whole run crashed. A 400
    from one model must retire that model, not the run."""
    _use_keys(monkeypatch, "key-one")
    monkeypatch.setattr(transcribe_module, "_exhausted", set())

    calls: list[str] = []

    def fake_call_model(api_key, model, images, count, temperature=0.0):
        calls.append(model)
        if model == CONFIG.vision_model:
            raise ModelRejectedError(f"{model} rejected the request")
        return [{"markdown": "ok", "has_japanese": True}]

    monkeypatch.setattr(transcribe_module, "_call_model", fake_call_model)

    pages = _call([Path("0001.png")], 1)
    assert pages == [{"markdown": "ok", "has_japanese": True}]
    # The rejecting model was tried once, then retired for the whole run:
    assert calls[0] == CONFIG.vision_model
    assert (0, CONFIG.vision_model) in transcribe_module._exhausted
    _call([Path("0002.png")], 1)
    assert calls.count(CONFIG.vision_model) == 1


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
