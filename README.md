# ChatTobira

A grounded study assistant over Ritsumeikan Foundation/Intermediate Japanese course
materials — Tobira textbooks plus weekly class handouts.

## Citation rule

Only the three textbooks are ever cited, as **text excerpts with a page number — no
page images**:

| Citable source | Pages |
|---|---|
| `Foundation 1 & 2.pdf` | 290 |
| `Tobira Intermediate Japanese.pdf` | 216 |
| `Tobira Kanji and Vocabulary Intermediate Japanese.pdf` | 212 |

The ~230 pages of class handouts, grammar review sheets, and answer keys are still
indexed and still ground answers — they are simply never named in a citation. This
keeps citations pointing at stable, page-numbered sources a student can actually open,
rather than at a worksheet from one week of one term.

Page numbers are the **printed folio** read off the page, not the PDF index — the two
differ by the front matter, and `p. 112` has to mean the same thing to the student as
it does to the book.

## Why ingestion is vision-based

The source PDFs have **no usable Japanese text layer**. Measured with `pdftotext`:

| File | Extractable text |
|---|---|
| `Tobira Intermediate Japanese.pdf` (216 pg) | 3 characters across 3 pages |
| `Tobira Kanji and Vocabulary…pdf` (212 pg) | 0 |
| `文法復習シート_T12〜T17(答え)` (8 files) | 0 |
| `T6 G1.pdf` (OneNote export) | English only — Japanese renders as `()()` |

A conventional `pypdf` / `pdftotext` / LangChain loader silently yields English
fragments, producing a bot that fails at exactly the grammar questions it exists to
answer. Every page is therefore rendered to an image and transcribed by a
vision model. `ingest verify` enforces this: it fails the run if fewer than 95% of
chunks contain a CJK character.

## Layout

```
ingest/      Python batch pipeline (Linux: needs LibreOffice)
supabase/    SQL migrations
web/         Next.js app on Cloudflare Workers
.work/       Scratch: converted PDFs, page images, resume manifest (gitignored)
             Page images are an OCR input only — they are never served to users.
```

Course materials stay **untracked** — they are ~94 MB and include two commercial
Kuroshio textbooks. `.gitignore` blocks them; keep it that way.

## Setup

```bash
cp .env.example .env   # then fill in keys
```

Ingestion runs on Linux (Oracle Cloud ARM, or GitHub Actions) because it shells out
to LibreOffice for the legacy `.ppt`/`.doc` files.

```bash
cd ingest
python -m venv .venv && . .venv/bin/activate
pip install -e .
```

## Ingest

The pipeline is resumable — every stage records completion in
`.work/manifest.json`, so a run interrupted by a rate limit picks up where it
stopped.

```bash
ingest discover                    # inventory + metadata from folder names
ingest convert                     # .ppt/.doc/.pptx/.docx -> PDF via LibreOffice
ingest render                      # PDF pages -> PNG
ingest transcribe                  # pages -> Markdown via Gemini vision
ingest chunk                       # split by grammar point, tokenize, embed
ingest push                        # upsert chunks + embeddings to Supabase
ingest verify                      # CJK coverage + orphan checks
```

Or end to end:

```bash
ingest all
```

Roughly 950 pages. On the Google free tier expect about a day of throttled
running; on paid it is a few dollars and finishes in under an hour.

## Free-tier ceiling

Groq free is 30 RPM / 1,000 requests per day. 100 students asking 10 questions is
exactly that cap, so the serving path depends on the semantic cache, a per-user
daily quota, and Groq → Gemini fallback through Cloudflare AI Gateway. Budget
about $5–10/month for exam-week overflow.
