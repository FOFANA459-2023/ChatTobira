"""Vision transcription: page image -> Markdown.

This exists because the source PDFs have no usable Japanese text layer. Measured
with pdftotext, `Tobira Intermediate Japanese.pdf` yields 3 characters across 3
pages and the grammar review sheets yield zero. Conventional PDF text extraction
produces English fragments and silently drops every Japanese example sentence.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from .config import CONFIG

PROMPT = """\
You are transcribing pages from Japanese language teaching material used in a \
university course (textbooks, grammar handouts, kanji sheets, answer keys).

For each page image, in order, produce faithful Markdown.

Rules:
- Transcribe ALL Japanese text exactly as printed. Never translate it, never \
paraphrase it, never "correct" it. Okurigana, particles, and punctuation must \
match the page character for character.
- Render furigana as 漢字《ふりがな》 using double angle brackets, attached to the \
word it annotates. Do not drop furigana; for beginners it is the most useful \
thing on the page.
- Reproduce tables as Markdown tables. Conjugation tables are the core content \
of these materials, so preserve every cell including empty ones.
- Keep example sentences verbatim, one per line.
- Keep fill-in-the-blank gaps as ＿＿ and keep any printed answers exactly where \
they appear.
- Preserve the heading structure of the page with Markdown headings.
- Describe a purely pictorial element in square brackets, e.g. [写真: 家族の絵]. \
Do not describe decorative layout.
- book_page: the page number PRINTED on the page itself, usually in a corner. \
Return it as a string exactly as printed. If no number is printed, return null. \
Never guess it and never derive it from the page's position in the file — it is \
used to tell students which page of the physical book to open.
- grammar_points: grammar patterns explicitly taught on the page, as written \
(e.g. "～ておく", "たいです"). Empty list if the page teaches none.
- has_japanese: true if any kana or kanji appears anywhere on the page.

Return an object with a "pages" array holding exactly %d entries, in the same \
order as the images provided.
"""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "pages": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "markdown": {"type": "string"},
                    "book_page": {"type": "string", "nullable": True},
                    "grammar_points": {"type": "array", "items": {"type": "string"}},
                    "has_japanese": {"type": "boolean"},
                },
                "required": ["markdown", "has_japanese"],
            },
        }
    },
    "required": ["pages"],
}


@dataclass
class PageText:
    pdf_page: int
    markdown: str
    book_page: str | None
    grammar_points: list[str]
    has_japanese: bool


from functools import lru_cache


@lru_cache(maxsize=1)
def _client():
    """One shared client. Constructing a client per request lets the garbage
    collector close the underlying httpx transport mid-flight, which surfaces
    as 'Cannot send a request, as the client has been closed'."""
    from google import genai

    return genai.Client(api_key=CONFIG.google_api_key)


class TransientVisionError(RuntimeError):
    """Retryable within the same model: per-minute throttle or transport blip."""


class DailyQuotaError(RuntimeError):
    """This model's free-tier DAILY budget is spent; retrying is pointless.

    Measured reality (2026-08): gemini-3.6-flash allows only 20 requests/day on
    the free tier. Each model has its own daily bucket, so the fix is to move
    down the cascade, not to wait.
    """


class OutputTruncatedError(RuntimeError):
    """The response JSON was cut off by the output-token ceiling.

    Seen live on dense scanned sheets: 4 pages of transcription exceeded the
    default output budget and json.loads got an unterminated string. Retrying
    the same batch reproduces it; the fix is fewer pages per request.
    """


# Tried in order; each free-tier model has an independent daily quota, so the
# cascade multiplies the daily page budget. Lite models transcribe well — this
# is OCR-style work, not reasoning. Override the first entry with VISION_MODEL.
MODEL_CASCADE = [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
]

_exhausted: set[str] = set()


def _cascade() -> list[str]:
    preferred = CONFIG.vision_model
    models = [preferred] + [m for m in MODEL_CASCADE if m != preferred]
    return [m for m in models if m not in _exhausted]


def _is_daily_quota(message: str) -> bool:
    return "PerDay" in message or "RequestsPerDayPerProject" in message


@retry(
    retry=retry_if_exception_type(TransientVisionError),
    wait=wait_exponential(multiplier=8, min=8, max=120),
    stop=stop_after_attempt(4),
    reraise=True,
)
def _call_model(model: str, images: list[Path], count: int) -> list[dict]:
    from google.genai import types

    parts: list = [PROMPT % count]
    for image in images:
        parts.append(types.Part.from_bytes(data=image.read_bytes(), mime_type="image/png"))

    try:
        response = _client().models.generate_content(
            model=model,
            contents=parts,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=RESPONSE_SCHEMA,
                # Transcription, not composition. Any creativity here is an error.
                temperature=0.0,
                # Dense scanned pages produce very long markdown; the default
                # budget truncated a 4-page batch mid-string.
                max_output_tokens=65536,
                # Thinking tokens come out of max_output_tokens. Seen live: the
                # model spent 62,915 tokens thinking about a table-of-contents
                # page, leaving ~2.6k for JSON, which truncated mid-string even
                # with a single image per request. Transcription needs no
                # reasoning, so spend the whole budget on output.
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
    except Exception as exc:
        message = str(exc)
        if "429" in message or "RESOURCE_EXHAUSTED" in message:
            if _is_daily_quota(message):
                raise DailyQuotaError(message) from exc
            raise TransientVisionError(message) from exc
        if "503" in message or "UNAVAILABLE" in message:
            raise TransientVisionError(message) from exc
        raise

    try:
        payload = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise OutputTruncatedError(f"truncated JSON after {len(response.text)} chars") from exc
    pages = payload.get("pages", [])
    if len(pages) != count:
        raise TransientVisionError(f"model returned {len(pages)} pages for {count} images")
    return pages


def _call(images: list[Path], count: int) -> list[dict]:
    """Try each model in the cascade until one has daily budget left."""
    last: Exception | None = None
    for model in _cascade():
        try:
            return _call_model(model, images, count)
        except DailyQuotaError as exc:
            _exhausted.add(model)
            last = exc
        except TransientVisionError as exc:
            last = exc
    raise DailyQuotaError(
        "every vision model in the cascade is out of daily free-tier quota; "
        "re-run tomorrow (the manifest resumes) or add billing"
    ) from last


def transcribe(
    images: list[Path],
    start_page: int = 1,
    on_batch: Callable[[list[PageText]], None] | None = None,
) -> list[PageText]:
    """Transcribe page images in batches, throttled for the free tier.

    on_batch receives the accumulated results after every batch. The caller
    persists them, so a daily-quota cut mid-document loses at most one batch of
    work instead of the whole document — with a 20-requests/day model, losing a
    290-page textbook to a crash on request 19 is the difference between
    finishing this week and never finishing.
    """
    results: list[PageText] = []
    batch_size = max(1, CONFIG.pages_per_request)

    for offset in range(0, len(images), batch_size):
        batch = images[offset : offset + batch_size]
        try:
            pages = _call(batch, len(batch))
        except OutputTruncatedError:
            # A dense batch overflowed the output budget even at 64k tokens.
            # One page per request always fits.
            pages = []
            for image in batch:
                pages.extend(_call([image], 1))
                if CONFIG.vision_throttle > 0:
                    time.sleep(CONFIG.vision_throttle)

        for i, page in enumerate(pages):
            book_page = page.get("book_page")
            results.append(
                PageText(
                    pdf_page=start_page + offset + i,
                    markdown=page.get("markdown", "").strip(),
                    book_page=str(book_page).strip() if book_page else None,
                    grammar_points=[g.strip() for g in page.get("grammar_points", []) if g.strip()],
                    has_japanese=bool(page.get("has_japanese")),
                )
            )

        if on_batch is not None:
            on_batch(results)

        if offset + batch_size < len(images) and CONFIG.vision_throttle > 0:
            time.sleep(CONFIG.vision_throttle)

    return results
