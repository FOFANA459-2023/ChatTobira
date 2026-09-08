-- The teacher's account is not metered.
--
-- The daily quota exists to keep a classroom inside the free tiers: 40 units a
-- day per student, spent by chat turns AND by practice papers, counted in
-- Asia/Tokyo so it resets when the students' day does. That is the right cap
-- for someone studying and the wrong one for the person who has to test the
-- app. Running the same account into "You have reached today's question limit"
-- while checking that a change works is how the cap stops the one person who
-- can fix things.
--
-- A flag rather than a very large daily_quota. Both work today; only one still
-- explains itself in six months, when a stray 1000000 in a quota column reads
-- as a mistake somebody should tidy up, and tidying it up locks the teacher
-- out again. It is also the difference between "unlimited" and "limited to a
-- number nobody expects to reach" in the admin views, which read daily_quota.
--
-- Students are untouched: the column defaults to false, and the only row set
-- true is the address that lib/admin.ts already treats as the teacher.

alter table profiles
  add column if not exists unlimited_quota boolean not null default false;

comment on column profiles.unlimited_quota is
  'True only for the teacher account. Usage is still counted; it is never refused.';

-- Consume one unit of today's quota.
--
-- Unchanged for students, including the atomicity that matters: the conditional
-- UPDATE is what stops two parallel requests both being allowed by a check that
-- each made before the other wrote.
--
-- The unlimited case still WRITES its usage row. Not counting it would be
-- easier and worse: the admin dashboard reads usage_daily, and an account that
-- shows zero questions a day while plainly asking them makes the one view of
-- how much the app is used quietly wrong.
create or replace function consume_quota()
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

  select daily_quota, unlimited_quota
    into cap, unlimited
    from profiles
   where id = uid;

  -- No profile row is still no access: an account that never completed signup
  -- has no quota to spend, unlimited or otherwise.
  if cap is null then
    return -1;
  end if;

  if unlimited then
    insert into usage_daily (user_id, used) values (uid, 1)
    on conflict (user_id, day) do update
      set used = usage_daily.used + 1
    returning used into new_used;
    -- A remaining count the caller will never act on. The route only tests for
    -- -1; anything else means "carry on".
    return 2147483647;
  end if;

  insert into usage_daily (user_id, used) values (uid, 1)
  on conflict (user_id, day) do update
    set used = usage_daily.used + 1
    where usage_daily.used < cap
  returning used into new_used;

  if new_used is null then
    return -1;  -- the WHERE clause blocked the update: quota exhausted
  end if;
  return cap - new_used;
end;
$$;

-- Set it for the teacher, and only the teacher.
--
-- The address is duplicated from web/lib/admin.ts, which is the app's own
-- definition of who the teacher is. Change one and change the other: there is
-- no shared constant a Postgres function and a TypeScript module can both
-- read, and a silent disagreement here means the teacher is metered again.
update profiles
   set unlimited_quota = true
 where lower(email) = 'fvarlee@gmail.com';

-- And keep it across a re-created profile.
--
-- handle_new_user() runs on every signup and builds the profile row from
-- scratch. Without this the flag would survive exactly until the teacher's
-- account was ever recreated, which is the kind of thing that is discovered
-- the day it happens rather than the day it is written.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from allowlist a where lower(a.email) = lower(new.email)) then
    raise exception 'not_invited: % is not on the ChatTobira allowlist', new.email
      using errcode = 'check_violation';
  end if;

  insert into profiles (id, email, display_name, unlimited_quota)
  values (
    new.id,
    new.email,
    split_part(new.email, '@', 1),
    lower(new.email) = 'fvarlee@gmail.com'
  );

  return new;
end;
$$;
