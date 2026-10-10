-- Anyone may ask for an account; nobody gets in until the teacher says so.
--
-- These two changes ship together ON PURPOSE and must not be separated. The
-- @apu.ac.jp rule was never only a convenience: it was the ONLY thing keeping
-- strangers out of an app that teaches from copyright-protected APU material.
-- Dropping it without a gate in the same migration would leave the app open
-- to the internet for however long the second half took to arrive.
--
--   before   @apu.ac.jp only, no approval       the domain was the gate
--   after    any address, approval required     the teacher is the gate
--
-- ---------------------------------------------------------------------------
-- 1. The gate
-- ---------------------------------------------------------------------------
--
-- A timestamp rather than a boolean: "approved" and "approved on the 3rd of
-- March" cost the same to store and the second answers questions the first
-- cannot. Null means waiting.

alter table profiles add column if not exists approved_at timestamptz;

comment on column profiles.approved_at is
  'When the teacher approved this account. Null means it is waiting and cannot use the app.';

-- EVERY ACCOUNT THAT ALREADY EXISTS IS APPROVED.
--
-- Without this the gate closes on the whole school the moment it is applied,
-- the teacher's own account included, and there is no way back in through the
-- app to open it. Only accounts created after this migration wait.
update profiles set approved_at = now() where approved_at is null;

-- The middleware reads approval off the session rather than the database, so
-- it costs no round trip on a page view. That means the flag has to live in
-- app_metadata as well — the same place `onboarded` lives (0010) and for the
-- same reason. app_metadata is writable only by the service role and by
-- security-definer functions, never by the student.
update auth.users u
   set raw_app_meta_data =
         coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('approved', true)
  from profiles p
 where p.id = u.id and p.approved_at is not null;

-- ---------------------------------------------------------------------------
-- 2. Approving, and taking it back
-- ---------------------------------------------------------------------------
--
-- Both halves move together or neither does: profiles.approved_at is what the
-- admin screen reads, app_metadata.approved is what the middleware reads, and
-- an account approved in one but not the other is either locked out while
-- showing as approved or admitted while showing as waiting. One function,
-- one transaction, so they cannot drift.
--
-- Service role only. The route behind it is /api/admin/students, which checks
-- the admin password before it calls anything here; this revoke is what makes
-- that check load-bearing rather than decorative.

create or replace function set_student_approval(p_email text, p_approved boolean)
returns timestamptz
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid;
  stamp timestamptz := case when p_approved then now() else null end;
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(p_email);
  if uid is null then
    raise exception 'no_such_account' using errcode = 'no_data_found';
  end if;

  update profiles set approved_at = stamp where id = uid;
  if not found then
    raise exception 'no_profile' using errcode = 'no_data_found';
  end if;

  update auth.users
     set raw_app_meta_data =
           coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('approved', p_approved)
   where id = uid;

  return stamp;
end;
$$;

revoke execute on function set_student_approval(text, boolean) from public, anon, authenticated;

comment on function set_student_approval(text, boolean) is
  'Approve or un-approve one account, writing profiles.approved_at and app_metadata.approved together.';

-- ---------------------------------------------------------------------------
-- 3. The admin roster learns the column
-- ---------------------------------------------------------------------------
--
-- Dropped and recreated rather than replaced: the return type changes, and
-- postgres refuses `create or replace` when it does.

drop function if exists admin_students();

create function admin_students()
returns table (
  email            text,
  full_name        text,
  gender           text,
  gender_self_described text,
  study_level      text,
  college          text,
  semester         text,
  reasons          text[],
  signed_up_at     timestamptz,
  verified         boolean,
  onboarded        boolean,
  -- Null until the teacher approves. The roster sorts on it so the people
  -- waiting are the ones at the top.
  approved_at      timestamptz,
  suspended        boolean,
  last_sign_in_at  timestamptz,
  last_activity_at timestamptz,
  questions_today  int
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    u.email,
    p.full_name,
    p.gender,
    p.gender_self_described,
    p.study_level,
    p.college,
    p.semester,
    p.reasons,
    u.created_at as signed_up_at,
    (u.email_confirmed_at is not null) as verified,
    (p.onboarded_at is not null) as onboarded,
    p.approved_at,
    coalesce(u.banned_until > now(), false) as suspended,
    u.last_sign_in_at,
    greatest(u.last_sign_in_at, activity.last_message) as last_activity_at,
    coalesce(quota.used, 0)::int as questions_today
  from auth.users u
  join profiles p on p.id = u.id
  left join lateral (
    select max(m.created_at) as last_message
      from conversations c
      join messages m on m.conversation_id = c.id
     where c.user_id = u.id
  ) activity on true
  left join usage_daily quota
    on quota.user_id = u.id and quota.day = (now() at time zone 'Asia/Tokyo')::date
$$;

revoke execute on function admin_students() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Any address may sign up
-- ---------------------------------------------------------------------------
--
-- is_apu_email() is left in place and simply stops being called. It is a
-- correct, tested predicate and the admin screen may yet want to show which
-- accounts are university ones; deleting it would throw that away to save
-- nothing.
--
-- The teacher's address stays special for the same reason it always was: it
-- is the one account that is not a student and must never be locked out.

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  name text := coalesce(new.raw_user_meta_data->>'full_name', '');
  is_admin boolean := lower(new.email) = 'fvarlee@gmail.com';
begin
  -- The domain check that stood here is gone. Approval replaces it, and the
  -- new account is NOT approved: profiles.approved_at defaults to null and
  -- nothing in this function sets it. A student who signs up can confirm
  -- their address and then waits.
  insert into profiles (id, email, display_name, full_name, unlimited_quota, approved_at)
  values (
    new.id,
    new.email,
    coalesce(nullif(name, ''), split_part(new.email, '@', 1)),
    nullif(name, ''),
    is_admin,
    -- The teacher approves themselves, since there is nobody else to do it.
    case when is_admin then now() end
  )
  on conflict (id) do nothing;

  if is_admin then
    update auth.users
       set raw_app_meta_data =
             coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('approved', true)
     where id = new.id;
  end if;

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- An account may now move to any address. The trigger stays because it is
-- where an email change is noticed at all; it simply no longer refuses one.
create or replace function enforce_apu_email_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.email is distinct from old.email then
    -- Keep profiles.email in step with the address they actually sign in
    -- with; the admin roster reads auth.users but the app reads profiles.
    update profiles set email = new.email where id = new.id;
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_apu_email_change() from public, anon, authenticated;

comment on function public.enforce_apu_email_change() is
  'Mirrors an email change into profiles. No longer restricts the domain — see 0019.';
