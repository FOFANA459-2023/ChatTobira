# ChatTobira

I moved to Japan for university and hit a wall with the language. Class moves
fast — too fast for me — and every homework or quiz meant flipping between a
textbook, last week's handouts, and a stack of review sheets just to find one
grammar point. I built ChatTobira to fix that for myself: a study assistant
that has actually read all of my course material, answers in seconds with the
exact page to review, and generates practice tests in the same format as the
real papers. Then I opened it to classmates, because a few hundred students at
my university sit the same courses with the same stack of PDFs.

It is a real app with real users, built end to end by one person: data
pipeline, retrieval, model serving, auth, admin tooling, CI/CD.

## What a student gets

- **Grounded chat** — ask a grammar question in English or Japanese, get an
  answer built only from the actual course material, with citations to printed
  textbook pages ("see p. 112"). No invented grammar rules.
- **Practice tests** — grammar and kanji papers generated in the format of the
  course's real test sheets, scoped to a topic ("test me on Topic 6"), graded
  instantly, with a study plan pointing at the pages to review. Furigana
  appears only on kanji the student hasn't been taught yet.
- **Invite-only access** — the admin invites students by email; they sign in
  with a magic link. No passwords for students, no public signup.

## The problems that made it interesting

**The PDFs had no text.** Every standard loader (pypdf, pdftotext, LangChain)
returned almost nothing — measured across the corpus:

| File | Extractable text |
|---|---|
| `Tobira Intermediate Japanese.pdf` (216 pg) | 3 characters |
| `Tobira Kanji and Vocabulary….pdf` (212 pg) | 0 |
| Grammar review sheets (8 files) | 0 |
| OneNote-exported handouts | English only — Japanese renders as `()()` |

So ingestion renders every page to an image and transcribes it with a vision
model. A verify step fails the corpus if fewer than 95% of chunks contain
Japanese — the tripwire for silent regressions to the useless text layer.

**Japanese search doesn't tokenize itself.** Postgres has no Japanese
full-text config, and Japanese has no spaces. Text is segmented with a
morphological analyzer at ingest (surface + dictionary forms, kana readings),
and queries are segmented the same way in the worker, then fused with vector
search by reciprocal rank fusion. A student typing みえる finds material
written 見える.

**Free tiers are a design constraint, not a footnote.** The whole thing runs
near $0/month for a classroom of users: a semantic answer cache (100 students
ask the same ~30 questions), per-student daily quotas, and a provider cascade
(Groq free tier → DeepSeek prepaid → Gemini last) that degrades gracefully as
each tier's limit is hit. The transcription pipeline is checkpointed per page
so a rate-limited run resumes tomorrow without re-paying for a single page.

**Copyright is handled deliberately.** The textbooks are commercial. Chat
citations quote short excerpts with page numbers instead of serving pages;
class handouts ground answers for students who own them; source PDFs live in
a private bucket that the app never reads, used only for backup and restore.

**Email in the real world.** University mail gateways silently eat invites.
The invite flow rolls back if the send fails, and a scheduled job reads the
sender's inbox over IMAP for bounce notices and revokes invites that provably
never arrived — the student list stays a list of people who can be reached.
(Related fix: students type email addresses with the Japanese IME on, so all
email input is NFKC-normalized before validation. A full-width ＠ is not a
typo, it's Tuesday.)

## Stack

- **Web:** Next.js (App Router) on Cloudflare Workers via OpenNext, Tailwind
- **Data:** Supabase — Postgres + pgvector, row-level security, auth (magic
  links), private storage
- **Ingestion:** Python — PyMuPDF rendering, Gemini vision transcription,
  fugashi/UniDic segmentation, embeddings truncated to 768 dims (fits the
  corpus in the free tier)
- **Serving:** Vercel AI SDK, Groq → DeepSeek → Gemini cascade, structured
  output for test generation
- **Ops:** GitHub Actions — lint/type/unit/e2e gates, deploy on green,
  scheduled bounce sweep; pytest + vitest + Playwright

```
ingest/      Python pipeline: discover → transcribe → chunk → embed → push
supabase/    SQL migrations (schema, RLS, hybrid search function)
web/         Next.js app (chat, practice tests, admin)
```

## Running it

Course materials are copyrighted and stay untracked — the pipeline expects
them under `MATERIALS_ROOT`. Copy `.env.example` to `.env` and fill in keys.

```bash
cd ingest && pip install -e .
ingest transcribe        # pages -> Markdown via vision model (resumable)
ingest push              # chunk, embed, upsert to Supabase
ingest verify            # corpus health checks, fails CI-style on regression
ingest backup            # mirror sources + transcripts to a private bucket
ingest bounces           # revoke invites whose email bounced
```

```bash
cd web && npm install && npm run dev
```

A new machine needs no re-transcription: `ingest restore` pulls sources and
transcripts back from the backup bucket and `ingest push` rebuilds the
database from there.

---

Built by Varlee Fofana. If you're hiring for product-minded engineering —
this is how I work: find the real problem, respect the constraints, ship,
then keep fixing what reality breaks.
