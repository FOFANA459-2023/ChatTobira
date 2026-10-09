-- Raise what a signed-in student gets, on all three counters at once.
--
--   chat    20 -> 50 requests per five-hour window
--   voice   600 -> 1800 seconds (ten minutes -> thirty)
--   uploads 5 -> 20 per day
--
-- Not a return to the pitch numbers of 0015, which were a demo setting nobody
-- was meant to live with; these are the ordinary ceilings, raised because the
-- old ones were sized before anyone had watched a class use the app. Still
-- finite, for the reason 0015 gave and 0016 kept: an unbounded allowance lets
-- one loop or crawler spend the model free tiers overnight.
--
-- The teacher is unaffected and already unmetered on all three — profiles.
-- unlimited_quota (0009) for chat and voice through consume_allowance (0011),
-- and for uploads through consume_upload_quota since 0016.
--
-- The copies used for WORDING are in web/lib/allowance.ts and move with this.
-- Anonymous trial limits (web/lib/trial.ts) are untouched: they are a taste of
-- the product before signing in, not an allowance.

-- ---------------------------------------------------------------------------
-- chat and voice: one function, as in 0011 and 0016
-- ---------------------------------------------------------------------------

create or replace function allowance_limit(p_kind text)
returns int
language sql
immutable
as $$
  select case p_kind when 'chat' then 50 when 'voice' then 1800 end;
$$;

-- ---------------------------------------------------------------------------
-- uploads: a column rather than a function, so the default and the rows that
-- already exist both have to move
-- ---------------------------------------------------------------------------
--
-- consume_upload_quota() reads profiles.daily_uploads per student (0005), so
-- changing the default alone would raise it for accounts created from now on
-- and leave every current student at five. Both are changed here.
--
-- The UPDATE is written against the old default rather than every row, so a
-- student who has deliberately been given a different number keeps it. At the
-- time of writing no such row exists — every profile is at the default — but
-- the column exists to be set per student and a blanket update would quietly
-- undo the first time anyone does.

alter table profiles alter column daily_uploads set default 20;

update profiles set daily_uploads = 20 where daily_uploads = 5;

comment on column profiles.daily_uploads is
  'Uploads per day, per student. Default 20 since 0017. unlimited_quota bypasses it.';
