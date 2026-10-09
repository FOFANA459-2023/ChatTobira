-- Live translation: its own allowance, and its own place to keep what it heard.
--
-- A lecture is not a conversation. Speaking practice is a student talking for
-- a few minutes at a time; this runs for the length of a class, in one
-- unbroken session, and the two must not spend each other's budget — a
-- ninety-minute lecture would eat a whole day of speaking practice and then
-- stop mid-sentence anyway. So it gets a counter of its own.
--
-- ---------------------------------------------------------------------------
-- 1. usage_windows learns a third kind
-- ---------------------------------------------------------------------------
--
-- The CHECK constraint is the reason this cannot be a one-line change to
-- allowance_limit(). 0011 wrote the two kinds it had into the table, so a
-- third is refused by the row, not by the function, and the refusal arrives
-- as a constraint violation from inside consume_allowance rather than as the
-- "you have run out" the caller knows how to show.

alter table usage_windows drop constraint if exists usage_windows_kind_check;

alter table usage_windows
  add constraint usage_windows_kind_check
  check (kind in ('chat', 'voice', 'translate'));

-- 3000 seconds — fifty minutes per five-hour window, charged a minute at a
-- time exactly as voice is. Shorter than a full class on purpose: this is a
-- judgement about what a continuous audio stream costs, not a fit to a
-- timetable, and a student translating a ninety-minute lecture end to end
-- will run out partway through it. Finite for the same reason every other
-- ceiling here is — a tab left open overnight is a real way to spend a model
-- quota, and this streams audio whether or not anybody is listening.
--
-- The teacher is not subject to it. unlimited_quota (0009) is checked inside
-- consume_allowance and bypasses the cap entirely, so an admin session is
-- counted and never refused.
create or replace function allowance_limit(p_kind text)
returns int
language sql
immutable
as $$
  select case p_kind
           when 'chat'      then 50
           when 'voice'     then 1800
           when 'translate' then 3000
         end;
$$;

-- allowance_status() lists the kinds it reports literally, so a kind missing
-- from here is invisible to the UI however much of it has been spent.
create or replace function allowance_status()
returns table (kind text, used int, allowance int, resets_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select k.kind,
         case when w.window_start is null or w.window_start <= now() - allowance_window()
              then 0 else w.used end,
         allowance_limit(k.kind),
         case when w.window_start is null or w.window_start <= now() - allowance_window()
              then null else w.window_start + allowance_window() end
    from (values ('chat'), ('voice'), ('translate')) as k(kind)
    left join usage_windows w on w.user_id = auth.uid() and w.kind = k.kind
   where auth.uid() is not null;
$$;

revoke execute on function allowance_status() from public, anon;
grant  execute on function allowance_status() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. translation_segments — what was said, and what it meant
-- ---------------------------------------------------------------------------
--
-- A table rather than rows in `messages`, for three reasons that only showed
-- up once the shape was real. A lecture is hundreds of short segments, and
-- putting them in `messages` would bury the student's actual conversation
-- under its own transcript. A segment is a PAIR — what was heard and what it
-- was turned into — where a message is one body of text. And a translation
-- is provisional until the sentence after it arrives, so a segment is written
-- once and then UPDATED when more context improves it, which is not something
-- a chat message ever does.
--
-- Written as the session runs rather than when it ends. A browser that dies
-- forty minutes into a lecture should cost the student the last sentence,
-- not the lecture.

create table if not exists translation_segments (
  id              bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  -- Position in the lecture, assigned by the client and unique per
  -- conversation: the ordering has to survive segments arriving out of order
  -- after a reconnect, and `created_at` cannot be trusted for that.
  seq             int not null,
  -- What the microphone heard, in the language it was spoken in.
  source_text     text not null,
  -- What it means, in the language the student chose. Empty while the
  -- translation of a segment is still arriving.
  translated_text text not null default '',
  -- Null when the source language was detected rather than chosen.
  source_lang     text,
  target_lang     text not null,
  -- Where this segment sat in the session, in milliseconds from its start, so
  -- a saved lecture can be read back against the clock.
  offset_ms       int,
  created_at      timestamptz not null default now(),
  unique (conversation_id, seq)
);

create index if not exists translation_segments_conversation_idx
  on translation_segments (conversation_id, seq);

alter table translation_segments enable row level security;

-- Reached through the conversation, the same shape as "own messages" in 0001:
-- the row carries no user_id of its own, so ownership is the conversation's.
-- Dropped first so the migration can be replayed: Postgres has no
-- `create policy if not exists`, and a second run would otherwise die here
-- having already created the table.
drop policy if exists "own translation segments" on translation_segments;
create policy "own translation segments" on translation_segments
  for all using (
    exists (select 1 from conversations c
            where c.id = translation_segments.conversation_id and c.user_id = auth.uid())
  ) with check (
    exists (select 1 from conversations c
            where c.id = translation_segments.conversation_id and c.user_id = auth.uid())
  );

comment on table translation_segments is
  'One speech segment of a live translation session: what was heard and what it meant.';

-- Table privileges, spelled out.
--
-- Every other table here relies on Supabase's default privileges, which grant
-- the API roles access to whatever is created in `public`. That almost
-- certainly covers this table too — but "almost certainly" is not something a
-- migration should rest on, and it cannot be checked against the development
-- copy: the copy is restored with --no-privileges, so every table in it shows
-- no grants whether or not production has them. RLS is what actually decides
-- who sees which row; these grants only decide who may reach the table at all,
-- and without them the policy above is never consulted and an insert fails
-- with "permission denied for table" rather than with a policy violation.
--
-- Idempotent and harmless if the defaults already cover it.

grant select, insert, update, delete on translation_segments to authenticated;
grant usage, select on sequence translation_segments_id_seq to authenticated;
