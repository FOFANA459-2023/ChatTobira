-- TEMPORARY — RELAXED FOR THE SCHOOL PITCH, 2026-10-05.
--
-- Raises the five-hour allowances so that nobody demonstrating or evaluating
-- the app is stopped mid-sentence. To be restored after the pitch; the exact
-- SQL that restores it is at the foot of this file.
--
--   chat   20 -> 1000 requests
--   voice  600 -> 14400 seconds (ten minutes -> four hours)
--
-- NOTHING IS REMOVED. usage_windows still records every request, the window
-- still opens and renews on the same five-hour rule, consume_allowance still
-- refuses what does not fit, and the student still sees how much is left.
-- Only the ceiling moves. The limits stay finite deliberately: an unbounded
-- allowance would let one loop or crawler spend the model free tiers
-- overnight, which during a pitch is the failure that matters.
--
-- Only allowance_limit() changes. consume_allowance() and allowance_status()
-- both read their cap from it, so this one function is the whole switch and
-- the behaviour around it is untouched.
--
-- The teacher's account is unaffected either way: profiles.unlimited_quota
-- (0009) bypasses the cap entirely in consume_allowance, and it is already
-- true for the admin address. Free range there does not depend on this file.
--
-- The matching copies used for WORDING live in web/lib/allowance.ts, and the
-- anonymous trial limits in web/lib/trial.ts. All three move together.

create or replace function allowance_limit(p_kind text)
returns int
language sql
immutable
as $$
  select case p_kind when 'chat' then 1000 when 'voice' then 14400 end;
$$;

comment on function allowance_limit(text) is
  'TEMPORARY pitch allowances (2026-10-05): chat 1000, voice 14400s. Normally 20 and 600 — see 0011_usage_windows.sql.';

-- ---------------------------------------------------------------------------
-- TO RESTORE after the pitch, run this. It is 0011's definition, unchanged:
--
--   create or replace function allowance_limit(p_kind text)
--   returns int
--   language sql
--   immutable
--   as $$
--     select case p_kind when 'chat' then 20 when 'voice' then 600 end;
--   $$;
--
--   comment on function allowance_limit(text) is null;
--
-- and revert the commit that carried this file, which puts web/lib/trial.ts
-- and web/lib/allowance.ts back at the same time.
-- ---------------------------------------------------------------------------
