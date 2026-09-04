-- Admin portal: one query per page instead of a paged crawl.
--
-- The admin page answered "who is invited, and have they used it?" by asking
-- the Auth Admin API for every user, 200 at a time, and joining the pages in
-- JavaScript — a second of latency before the list could render, on every
-- load and again inside every invite. Worse, the interesting facts are not
-- all in one place: the invite lives in `allowlist`, the display name in
-- `profiles`, the sign-in history in `auth.users`, and "did they actually
-- use it" only in their messages.
--
-- These functions do that join in the database, where it is one round trip
-- and the planner can use the indexes. No new columns: everything below is
-- already recorded somewhere, and duplicating it into a table the app would
-- have to keep in step is how the two versions start disagreeing.

-- ---------------------------------------------------------------------------
-- Students
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER because auth.users is not reachable any other way: the
-- auth schema is not exposed through PostgREST, so last_sign_in_at,
-- email_confirmed_at and banned_until can only be read from inside the
-- database. Locked to the service role below — this returns the roster of
-- every student and must never be callable by a signed-in student.
create or replace function admin_students()
returns table (
  email           text,
  display_name    text,
  invited_at      timestamptz,
  invited_by      text,
  -- They have an auth account: the sign-in link was used at least once far
  -- enough to create one.
  registered      boolean,
  -- They clicked a link and confirmed. False here with registered true means
  -- the email arrived but was never opened.
  accepted        boolean,
  suspended       boolean,
  last_sign_in_at timestamptz,
  -- The most recent thing they actually DID, which is a better answer to
  -- "are they using this?" than a sign-in six weeks ago.
  last_activity_at timestamptz,
  questions_today int
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    a.email,
    p.display_name,
    a.created_at as invited_at,
    a.invited_by,
    (u.id is not null) as registered,
    (u.email_confirmed_at is not null) as accepted,
    coalesce(u.banned_until > now(), false) as suspended,
    u.last_sign_in_at,
    greatest(u.last_sign_in_at, activity.last_message) as last_activity_at,
    coalesce(quota.used, 0)::int as questions_today
  from allowlist a
  left join auth.users u on lower(u.email) = lower(a.email)
  left join profiles p on p.id = u.id
  left join lateral (
    select max(m.created_at) as last_message
      from conversations c
      join messages m on m.conversation_id = c.id
     where c.user_id = u.id
  ) activity on true
  left join usage_daily quota
    on quota.user_id = u.id
   and quota.day = (now() at time zone 'Asia/Tokyo')::date
  order by a.created_at desc;
$$;

comment on function admin_students is
  'Admin roster: the allowlist joined to auth accounts and real activity. '
  'Service role only — it exposes every student''s email and sign-in history.';

revoke execute on function admin_students() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

-- Deliberately NOT security definer: documents and chunks are ordinary
-- tables, and the service role already reads them. The function exists to
-- turn "list the corpus with its chunk counts" into one round trip instead
-- of a query per document.
create or replace function admin_documents()
returns table (
  id             bigint,
  path           text,
  title          text,
  level          text,
  topic          text,
  topics         text[],
  doc_type       text,
  is_citable     boolean,
  page_count     int,
  ingested_at    timestamptz,
  created_at     timestamptz,
  chunk_count    bigint,
  -- Chunks carrying an embedding. Below chunk_count means the document is
  -- only half searchable, which is invisible from anywhere else.
  embedded_count bigint,
  -- Printed page numbers were read off the pages; without them a citation
  -- can only point at a PDF index the student cannot find in a paper book.
  paged_count    bigint
)
language sql
stable
set search_path = public
as $$
  select
    d.id, d.path, d.title, d.level, d.topic, d.topics, d.doc_type,
    d.is_citable, d.page_count, d.ingested_at, d.created_at,
    count(c.id) as chunk_count,
    count(c.embedding) as embedded_count,
    count(c.book_page) as paged_count
  from documents d
  left join chunks c on c.document_id = d.id
  group by d.id
  order by d.is_citable desc, d.title;
$$;

comment on function admin_documents is
  'Corpus inventory with per-document chunk and embedding counts.';

revoke execute on function admin_documents() from public, anon, authenticated;
