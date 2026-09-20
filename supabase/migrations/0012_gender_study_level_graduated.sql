-- Who the student is, and where they are in the degree.
--
-- Signup asks two more things: gender, and whether they are an undergraduate
-- or a graduate student. Both are required, so both are checked HERE and not
-- only in the form — the anon key ships to every browser, and a rule that
-- lives only in React is a suggestion (0010 says the same thing at more
-- length, and for the same reason).
--
-- And the welcome questions take one more answer. A student who has finished
-- the degree has no semester number, so the list of eight gains Graduated.
--
-- 'graduated' is not a number, so profiles.semester stops being one: it was
-- smallint 1..8 and is now text holding '1'..'8' or 'graduated'. One answer
-- stays in one column, the check constraint lists every legal answer, and the
-- rows already stored cast straight across. The alternative — a ninth number
-- meaning "graduated", or a second boolean column beside the number — either
-- hides the meaning in a magic value or allows a row that says a student is
-- both in their third semester and finished.
--
-- The new column is study_level and not level, because profiles.level is
-- taken: it has meant the textbook scope a student's answers are retrieved
-- from since 0001.

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------

alter table profiles
  add column if not exists gender                text,
  -- What a student who answered 'other' wrote in. Null for every other answer.
  add column if not exists gender_self_described text,
  add column if not exists study_level           text;

comment on column profiles.gender is
  'female | male | other, given at signup. Students from before 0012 have null.';
comment on column profiles.gender_self_described is
  'The write-in beside gender = other; null for every other answer.';
comment on column profiles.study_level is
  'undergraduate | graduate, given at signup. Students from before 0012 have null.';

alter table profiles
  add constraint profiles_gender_check
    check (gender is null or gender in ('female', 'male', 'other')),
  -- The write-in belongs to 'other' and to nothing else: answering female and
  -- sending a description is a client that has gone wrong, not a third answer.
  add constraint profiles_gender_self_described_check
    check (
      case
        when gender = 'other'
          then gender_self_described is not null
               and char_length(btrim(gender_self_described)) between 1 and 40
        else gender_self_described is null
      end
    ),
  add constraint profiles_study_level_check
    check (study_level is null or study_level in ('undergraduate', 'graduate'));

-- ---------------------------------------------------------------------------
-- Semester becomes an answer rather than a number
-- ---------------------------------------------------------------------------

alter table profiles drop constraint if exists profiles_semester_check;
alter table profiles alter column semester type text using semester::text;
alter table profiles
  add constraint profiles_semester_check
    check (
      semester is null
      or semester in ('1', '2', '3', '4', '5', '6', '7', '8', 'graduated')
    );

comment on column profiles.semester is
  'Which semester they are in, 1-8, or graduated once the degree is finished.';

-- profiles_onboarded_complete still holds: it asks only that semester is not
-- null, which is as true of 'graduated' as it was of 3.

-- ---------------------------------------------------------------------------
-- Signup: the two new answers are required, and the trigger is where that is
-- decided
-- ---------------------------------------------------------------------------

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
  gender   text := nullif(btrim(coalesce(new.raw_user_meta_data->>'gender', '')), '');
  self_described text := nullif(btrim(regexp_replace(
                    coalesce(new.raw_user_meta_data->>'gender_self_described', ''),
                    '\s+', ' ', 'g')), '');
  study_level    text := nullif(btrim(coalesce(new.raw_user_meta_data->>'study_level', '')), '');
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
    if gender is null or gender not in ('female', 'male', 'other') then
      raise exception 'gender_required: choose female, male or other'
        using errcode = 'check_violation';
    end if;
    if gender = 'other' then
      if self_described is null or char_length(self_described) > 40 then
        raise exception 'gender_self_described_required: describe it in 40 characters or fewer'
          using errcode = 'check_violation';
      end if;
    else
      -- A description sent alongside female or male is dropped, not stored:
      -- the column means "what they wrote instead", and they wrote nothing.
      self_described := null;
    end if;
    if study_level is null or study_level not in ('undergraduate', 'graduate') then
      raise exception 'study_level_required: choose undergraduate or graduate'
        using errcode = 'check_violation';
    end if;
  else
    -- The admin account is a personal gmail signing in on /admin, and answers
    -- none of the student questions.
    gender := null;
    self_described := null;
    study_level := null;
  end if;

  insert into profiles (
    id, email, display_name, full_name,
    gender, gender_self_described, study_level,
    unlimited_quota
  )
  values (
    new.id,
    new.email,
    coalesce(nullif(name, ''), split_part(new.email, '@', 1)),
    nullif(name, ''),
    gender,
    self_described,
    study_level,
    is_admin
  );

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The welcome questions now accept Graduated
-- ---------------------------------------------------------------------------

-- The semester argument changes type, which would otherwise leave the old
-- int version behind as an overload for a stale client to keep calling.
drop function if exists complete_profile(text, int, text[]);

create or replace function complete_profile(
  p_college  text,
  p_semester text,
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
  if p_semester is null
     or p_semester not in ('1', '2', '3', '4', '5', '6', '7', '8', 'graduated') then
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

revoke execute on function complete_profile(text, text, text[]) from public, anon;
grant  execute on function complete_profile(text, text, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin roster carries the new answers
-- ---------------------------------------------------------------------------

-- The return type changes, which `create or replace` cannot do.
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
    p.gender,
    p.gender_self_described,
    p.study_level,
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
