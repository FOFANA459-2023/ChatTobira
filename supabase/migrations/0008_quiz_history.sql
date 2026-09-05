-- Question history: what each student has already been asked.
--
-- "New Test" has to mean new questions. The paper the student just sat rides
-- back to the generator as an avoid-list, which handles the immediate repeat,
-- but nothing survived a page reload — so the third test of the week could
-- reproduce the first, and the app had no way to know. This is that memory.
--
-- One row per generated item, keyed to the student, carrying what the
-- duplicate check compares on: the point tested, the expected answer, and the
-- frame the point was tested on (the sentence with names, numbers and
-- particles collapsed — see lib/quiz-signature.ts). The text itself is stored
-- too, so a future paper can be shown what to write AROUND rather than only
-- being told what to avoid.
--
-- Per student rather than global on purpose. Two students revising the same
-- topic SHOULD get the same good question; what nobody wants is the same
-- question twice in a row themselves.

create table quiz_items (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- 'F2' | 'F3' | 'INT', from the textbook the test was drawn from.
  level         text,
  -- 'grammar' | 'kanji'
  kind          text not null,
  -- Course division the paper was scoped to, e.g. 'T8'. Null for a whole-book
  -- paper, which is a real case and must not be filed under a topic.
  topic         text,
  -- The section archetype this item was written to, from lib/paper-format.ts.
  -- Kept so the mix of question types can be varied across sittings later.
  archetype     text,
  question_type text,
  question      text not null,
  answer        text not null,
  choices       jsonb not null default '[]'::jsonb,
  -- The grammar pattern or kanji word the item tests.
  target        text,
  -- Duplicate-detection keys, written by the app so the comparison is the
  -- same one everywhere. `pattern` is target+answer; `frame` is the collapsed
  -- sentence. Two items with the same pattern and a similar frame are the
  -- same question — which is a similarity test, so it happens in the app;
  -- these columns are what it loads.
  pattern       text,
  frame         text,
  -- The textbook the content came from, so history can be scoped to a book.
  document_id   bigint references documents(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- The only query: this student's recent items for this level and kind.
create index quiz_items_recent_idx
  on quiz_items (user_id, kind, level, created_at desc);

alter table quiz_items enable row level security;

-- A student's question history is theirs. No policy for anyone else: the
-- service role bypasses RLS for the trial path, and nothing else reads it.
create policy "own quiz history" on quiz_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table quiz_items is
  'Per-student record of generated practice questions, used to stop the '
  'generator reproducing a question the student has already been asked. '
  'See lib/quiz-signature.ts for how pattern and frame are computed.';

-- ---------------------------------------------------------------------------
-- Trimming
-- ---------------------------------------------------------------------------
-- Only the recent past matters: a question from three months ago is one a
-- student would welcome seeing again, and comparing against everything they
-- have ever done would eventually reject every new item. The app reads a
-- bounded window; this keeps the table from growing without bound behind it.

create or replace function trim_quiz_history()
returns void
language sql
security definer
set search_path = public
as $$
  delete from quiz_items
   where created_at < now() - interval '90 days';
$$;

revoke execute on function trim_quiz_history() from public, anon, authenticated;

comment on function trim_quiz_history is
  'Drop question history older than 90 days. Service role only; safe to run '
  'from a scheduled job alongside the bounce sweep.';
