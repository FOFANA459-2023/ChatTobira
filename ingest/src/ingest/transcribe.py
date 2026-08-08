"""Vision transcription: page image -> Markdown.

This exists because the source PDFs have no usable Japanese text layer. Measured
with pdftotext, `Tobira Intermediate Japanese.pdf` yields 3 characters across 3
pages and the grammar review sheets yield zero. Conventional PDF text extraction
produces English fragments and silently drops every Japanese example sentence.
"""

from __future__ import annotations

import json
import time
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


def _client():
    from google import genai

    return genai.Client(api_key=CONFIG.google_api_key)


class TransientVisionError(RuntimeError):
    """Rate limit or transport failure — worth retrying."""


@retry(
    retry=retry_if_exception_type(TransientVisionError),
    wait=wait_exponential(multiplier=8, min=8, max=240),
    stop=stop_after_attempt(6),
    reraise=True,
)
def _call(images: list[Path], count: int) -> list[dict]:
    from google.genai import types

    parts: list = [PROMPT % count]
    for image in images:
        parts.append(
            types.Part.from_bytes(data=image.read_bytes(), mime_type="image/png")
        )

    try:
        response = _client().models.generate_content(
            model=CONFIG.vision_model,
            contents=parts,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=RESPONSE_SCHEMA,
                # Transcription, not composition. Any creativity here is an error.
                temperature=0.0,
            ),
        )
    except Exception as exc:  # noqa: BLE001 - SDK raises varied transport errors
        message = str(exc)
        if any(m in message for m in ("429", "RESOURCE_EXHAUSTED", "503", "UNAVAILABLE")):
            raise TransientVisionError(message) from exc
        raise

    payload = json.loads(response.text)
    pages = payload.get("pages", [])
    if len(pages) != count:
        raise TransientVisionError(
            f"model returned {len(pages)} pages for {count} images"
        )
    return pages


def transcribe(images: list[Path], start_page: int = 1) -> list[PageText]:
    """Transcribe page images in batches, throttled for the free tier."""
    results: list[PageText] = []
    batch_size = max(1, CONFIG.pages_per_request)

    for offset in range(0, len(images), batch_size):
        batch = images[offset : offset + batch_size]
        pages = _call(batch, len(batch))

        for i, page in enumerate(pages):
            book_page = page.get("book_page")
            results.append(
                PageText(
                    pdf_page=start_page + offset + i,
                    markdown=page.get("markdown", "").strip(),
                    book_page=str(book_page).strip() if book_page else None,
                    grammar_points=[
                        g.strip() for g in page.get("grammar_points", []) if g.strip()
                    ],
                    has_japanese=bool(page.get("has_japanese")),
                )
            )

        if offset + batch_size < len(images) and CONFIG.vision_throttle > 0:
            time.sleep(CONFIG.vision_throttle)

    return results
