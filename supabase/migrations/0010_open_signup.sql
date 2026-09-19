-- Open signup for APU students, replacing the invite list.
--
-- ChatTobira was invite-only: the admin allowlisted an address and emailed a
-- magic link. It is now open to anyone holding an APU address, who signs up
-- with a password, confirms the address by the link Supabase emails, and then
-- tells us their college, semester and why they are here.
--
-- The rules live HERE and not only in the signup form, because the form is not
-- the only way in. The anon key ships to every browser, and with it anyone can
-- call Supabase's /auth/v1/signup directly with whatever address they like. A
-- domain check that exists only in React is a suggestion; one that raises
-- inside the auth.users insert is a rule.
--
-- The one exception is the admin account, which is a personal gmail and signs
-- in with a password on /admin. Its address is duplicated from web/lib/admin.ts
-- exactly as 0009 duplicates it — change one and change the other.

-- ---------------------------------------------------------------------------
-- Profile fields
-- ---------------------------------------------------------------------------

alter table profiles
  add column if not exists full_name    text,
  add column if not exists college      text,
  add column if not exists semester     smallint,
  add column if not exists reasons      text[],
  -- Set once, by complete_profile(). Null means the student verified their
  -- email but has not answered the welcome questions yet.
  add column if not exists onboarded_at timestamptz;

-- Constraints rather than trust in the one function that writes these: a
-- future code path that forgets to validate still cannot store a fourth
-- college or a ninth semester.
alter table profiles
  add constraint profiles_college_check
    check (college is null or college in ('APS', 'APM', 'ST')),
  add constraint profiles_semester_check
    check (semester is null or semester between 1 and 8),
  add constraint profiles_reasons_check
    check (
      reasons is null
      or (cardinality(reasons) >= 1
          and reasons <@ array['japanese_class', 'jpt_prep', 'improve_japanese'])
    ),
  add constraint profiles_onboarded_complete
    check (
      onboarded_at is null
      or (college is not null and semester is not null and reasons is not null)
    );

comment on column profiles.full_name is
  'Full name as printed on the APU student ID card, given at signup.';
comment on column profiles.college is 'APS | APM | ST';
comment on column profiles.reasons is
  'Why they use ChatTobira, at least one of: japanese_class, jpt_prep, improve_japanese.';

-- ---------------------------------------------------------------------------
-- Students may read their profile, never write it directly
-- ---------------------------------------------------------------------------

-- The old policy was `for all`, which let a signed-in student UPDATE their own
-- row through PostgREST — every column of it, daily_quota and unlimited_quota
-- included. One line in the browser console made any account unmetered. With
-- signup now open to every APU address that is not a theoretical hole.
--
-- Reads stay (the chat page reads `level`). Every write goes through a
-- security-definer function that decides which columns it may touch.
drop policy if exists "own profile" on profiles;
create policy "read own profile" on profiles
  for select using (auth.uid() = id);

revoke insert, update, delete on profiles from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Signup: APU addresses only, and a name is required
-- ---------------------------------------------------------------------------

create or replace function is_apu_email(address text)
returns boolean
language sql
immutable
as $$
  -- Exactly apu.ac.jp: not a subdomain, not apu.ac.jp.example.com.
  select coalesce(lower(address) ~ '^[a-z0-9._%+-]+@apu\.ac\.jp$', false);
$$;

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := lower(new.email) = 'fvarlee@gmail.com';
  name     text := btrim(regexp_replace(
                    coalesce(new.raw_user_meta_data->>'full_name', ''), '\s+', ' ', 'g'));
begin
  if not is_admin then
    if not is_apu_email(new.email) then
      raise exception 'not_apu_email: ChatTobira accepts @apu.ac.jp addresses only'
        using errcode = 'check_violation';
    end if;
    if char_length(name) < 2 or char_length(name) > 100 then
      raise exception 'full_name_required: give your full name as on your student ID'
        using errcode = 'check_violation';
    end if;
  end if;

  insert into profiles (id, email, display_name, full_name, unlimited_quota)
  values (
    new.id,
    new.email,
    coalesce(nullif(name, ''), split_part(new.email, '@', 1)),
    nullif(name, ''),
    is_admin
  );

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- The signup check alone leaves a side door: sign up with an APU address, then
-- change the account's email to a gmail one. Supabase confirms the new
-- address and writes it to auth.users, never touching the insert trigger.
create or replace function enforce_apu_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email
     and lower(coalesce(old.email, '')) <> 'fvarlee@gmail.com'
     and not is_apu_email(new.email) then
    raise exception 'not_apu_email: ChatTobira accepts @apu.ac.jp addresses only'
      using errcode = 'check_violation';
  end if;
  -- Keep the profile's copy in step, so the admin roster shows the address
  -- the student actually signs in with.
  if new.email is distinct from old.email then
    update profiles set email = new.email where id = new.id;
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_apu_email_change() from public, anon, authenticated;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  before update of email on auth.users
  for each row execute function enforce_apu_email_change();

-- ---------------------------------------------------------------------------
-- The welcome questions
-- ---------------------------------------------------------------------------

-- The only way a student writes their profile. Validates every answer, stores
-- them, and stamps `onboarded` into app_metadata — which the student cannot
-- write themselves (user_metadata they can), and which the middleware reads
-- off the user it already fetches on every navigation, so gating the app on a
-- finished profile costs no extra round trip.
create or replace function complete_profile(
  p_college  text,
  p_semester int,
  p_reasons  text[]
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid     uuid := auth.uid();
  cleaned text[];
begin
  if uid is null then
    raise exception 'not_signed_in' using errcode = 'insufficient_privilege';
  end if;
  if p_college is null or p_college not in ('APS', 'APM', 'ST') then
    raise exception 'bad_college' using errcode = 'check_violation';
  end if;
  if p_semester is null or p_semester not between 1 and 8 then
    raise exception 'bad_semester' using errcode = 'check_violation';
  end if;

  select array_agg(distinct r order by r)
    into cleaned
    from unnest(coalesce(p_reasons, '{}')) as r;
  if cleaned is null
     or not cleaned <@ array['japanese_class', 'jpt_prep', 'improve_japanese'] then
    raise exception 'bad_reasons' using errcode = 'check_violation';
  end if;

  update profiles
     set college      = p_college,
         semester     = p_semester,
         reasons      = cleaned,
         onboarded_at = coalesce(onboarded_at, now())
   where id = uid;
  if not found then
    raise exception 'no_profile' using errcode = 'no_data_found';
  end if;

  update auth.users
     set raw_app_meta_data =
           coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('onboarded', true)
   where id = uid;
end;
$$;

revoke execute on function complete_profile(text, int, text[]) from public, anon;
grant  execute on function complete_profile(text, int, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- The invite list is gone
-- ---------------------------------------------------------------------------

drop table if exists allowlist;

-- ---------------------------------------------------------------------------
-- Admin roster, now read off accounts rather than invites
-- ---------------------------------------------------------------------------

-- The return type changes, which `create or replace` cannot do.
drop function if exists admin_students();

create function admin_students()
returns table (
  email            text,
  full_name        text,
  college          text,
  semester         smallint,
  reasons          text[],
  signed_up_at     timestamptz,
  -- They clicked the confirmation link.
  verified         boolean,
  -- They answered the welcome questions.
  onboarded        boolean,
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
    p.college,
    p.semester,
    p.reasons,
    u.created_at as signed_up_at,
    (u.email_confirmed_at is not null) as verified,
    (p.onboarded_at is not null) as onboarded,
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
    on quota.user_id = u.id
   and quota.day = (now() at time zone 'Asia/Tokyo')::date
  order by u.created_at desc;
$$;

comment on function admin_students is
  'Admin roster: every account with its profile answers and real activity. '
  'Service role only — it exposes every student''s email and sign-in history.';

revoke execute on function admin_students() from public, anon, authenticated;
