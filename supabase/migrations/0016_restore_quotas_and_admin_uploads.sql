-- Restore the normal allowances, and give the teacher the free range on
-- uploads that they already have everywhere else.
--
-- Two separate things, in one migration because they are one decision:
-- "put the ceilings back where they were, and stop metering the admin".
--
-- ---------------------------------------------------------------------------
-- 1. The five-hour allowances go back to 0011's numbers
-- ---------------------------------------------------------------------------
--
-- 0015 raised these for the school pitch on 2026-10-06 and said in its own
-- footer that restoring them was 0011's definition unchanged. This is that
-- definition, unchanged:
--
--   chat   1000 -> 20 requests
--   voice  14400 -> 600 seconds (four hours -> ten minutes)
--
-- Only allowance_limit() moves. consume_allowance() and allowance_status()
-- both read their cap from it, so this one function is the whole switch, and
-- everything around it — the window, the counting, the refusal, the wording —
-- is untouched. The copies used for WORDING are in web/lib/allowance.ts and
-- web/lib/trial.ts, and move with this file.

create or replace function allowance_limit(p_kind text)
returns int
language sql
immutable
as $$
  select case p_kind when 'chat' then 20 when 'voice' then 600 end;
$$;

comment on function allowance_limit(text) is null;

-- ---------------------------------------------------------------------------
-- 2. The teacher's uploads stop being metered
-- ---------------------------------------------------------------------------
--
-- profiles.unlimited_quota (0009) was always meant to be the one switch that
-- takes the teacher out of every counter, and consume_allowance() (0011) reads
-- it — which is why chat, voice and practice tests have never refused the
-- admin. Tests spend the chat allowance, so they were covered by the same line.
--
-- consume_upload_quota() (0005) predates that column and never learned about
-- it. It reads profiles.daily_uploads and enforces it against everyone, so the
-- admin has been stopped at five uploads a day while being unlimited for
-- everything else. That was an oversight, not a policy.
--
-- Usage is still RECORDED for the admin, exactly as consume_allowance records
-- it: upload_usage_daily still gets its row and still counts up, so the admin
-- views keep showing real numbers. Only the refusal is skipped. The return
-- value is the remaining allowance, and an unlimited account has no meaningful
-- remainder, so it reports its cap — a number the caller already treats as
-- "there is room", and never -1, which is the only value that refuses.
--
-- Students are untouched: unlimited_quota defaults to false, so for every
-- student this function behaves exactly as it did before, conditional UPDATE
-- and all. The atomicity that matters is unchanged for them — the UPDATE is
-- still what stops two parallel uploads both being allowed.

create or replace function consume_upload_quota()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid       uuid := auth.uid();
  cap       int;
  unlimited boolean;
  new_used  int;
begin
  if uid is null then
    return -1;
  end if;

  select daily_uploads, unlimited_quota
    into cap, unlimited
    from profiles
   where id = uid;

  -- No profile row is still no access, and a null cap still refuses: an
  -- account that never completed signup has nothing to spend.
  if cap is null then
    return -1;
  end if;

  -- The teacher: counted, never refused. The insert is unconditional so the
  -- row exists and the number is true; there is no cap in the WHERE to fail.
  if unlimited then
    insert into upload_usage_daily (user_id, used) values (uid, 1)
    on conflict (user_id, day) do update
      set used = upload_usage_daily.used + 1;
    return cap;
  end if;

  insert into upload_usage_daily (user_id, used) values (uid, 1)
  on conflict (user_id, day) do update
    set used = upload_usage_daily.used + 1
    where upload_usage_daily.used < cap
  returning used into new_used;

  if new_used is null then
    return -1;
  end if;
  return cap - new_used;
end;
$$;

comment on function consume_upload_quota() is
  'Spends one daily upload. profiles.unlimited_quota (0009) is counted but never refused.';
