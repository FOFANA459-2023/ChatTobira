-- Student uploads: private context first, shared corpus only by approval.
--
-- Students upload a photo or PDF of a handout and ask questions about it in
-- the same breath. That file grounds THEIR chat immediately and nobody
-- else's. It reaches the shared corpus only when the admin approves it.
--
-- The gate is not bureaucracy. Chunks are readable by every authenticated
-- student ("signed-in read chunks" in 0001), and retrieved chunks are pasted
-- into the system prompt, so an unreviewed upload would be able to (a) teach
-- the whole cohort a wrong answer off someone's homework, (b) expose a
-- graded paper to 100 classmates, and (c) inject instructions into everyone
-- else's chat. One click of review is what keeps the corpus something the
-- app can honestly cite.

create table uploads (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- Original filename as the student saw it; shown in the UI and used to
  -- build the corpus path on approval.
  filename     text not null,
  content_type text not null,
  size_bytes   int  not null,
  -- Object key in the private chattobira-uploads bucket.
  storage_path text not null unique,
  -- sha256 of the bytes, so the same handout uploaded by five students is
  -- recognisable as one document at review time.
  content_sha  text,

  -- Where this belongs in the course, chosen by the student. Drives the
  -- folder the file lands in when it is promoted into the corpus, which is
  -- what discover.py reads level and topic back out of.
  level        text check (level in ('F2', 'F3', 'INT')),
  topic        text check (topic ~ '^T\d{1,2}$'),

  -- Markdown produced by the vision model at upload time. This is both the
  -- context the student's own chat uses AND the transcript the ingest
  -- pipeline reuses on approval, so an approved upload is never transcribed
  -- twice and costs no second round of vision quota.
  extracted    text,
  -- 'pending'   — uploaded, not yet extracted
  -- 'ready'     — extracted; usable as the uploader's private context
  -- 'failed'    — extraction failed; kept so the student sees why
  -- 'submitted' — the student offered it to the shared corpus
  -- 'approved'  — admin cleared it; awaiting `ingest uploads`
  -- 'ingested'  — in the corpus, readable by everyone
  -- 'rejected'  — admin declined; stays private to the uploader
  status       text not null default 'pending'
                 check (status in ('pending','ready','failed','submitted',
                                   'approved','ingested','rejected')),
  error        text,
  -- Set once the pipeline has pushed it, so the two are traceable both ways.
  document_id  bigint references documents(id) on delete set null,
  reviewed_by  text,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index uploads_user_idx   on uploads (user_id, created_at desc);
create index uploads_status_idx on uploads (status) where status in ('submitted', 'approved');
create index uploads_sha_idx    on uploads (content_sha);

alter table uploads enable row level security;

-- A student sees and manages only their own uploads. Nothing here lets one
-- student read another's file, which is the whole point of the private tier.
create policy "own uploads" on uploads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Review and promotion happen through the service role (the admin API and
-- the ingest pipeline), which bypasses RLS. No policy grants a student the
-- ability to set their own status to 'approved'.

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

-- Private bucket, separate from chattobira-backup: that one is a disaster
-- recovery mirror the app never reads, this one is live student data with
-- its own access rules and retention. Collapsing them would give one policy
-- to two very different things.
insert into storage.buckets (id, name, public)
values ('chattobira-uploads', 'chattobira-uploads', false)
on conflict (id) do nothing;

-- No storage policies are granted to students. Uploads go through a
-- server-issued signed URL and reads happen via the service role, so the
-- bucket is never directly reachable with an anon or authenticated key.

-- ---------------------------------------------------------------------------
-- Per-student upload quota
-- ---------------------------------------------------------------------------

-- Extraction is a vision call, and vision is the scarcest thing in this
-- deployment. Metered separately from the question quota so uploading a
-- worksheet does not eat the questions the student wants to ask about it.
alter table profiles add column if not exists daily_uploads int not null default 5;

create table upload_usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default (now() at time zone 'Asia/Tokyo')::date,
  used    int  not null default 0,
  primary key (user_id, day)
);

alter table upload_usage_daily enable row level security;

-- Same atomic consume-or-refuse shape as consume_quota() in 0003: the update
-- is blocked by its own WHERE clause when the cap is reached, so parallel
-- requests cannot double-spend.
create or replace function consume_upload_quota()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid      uuid := auth.uid();
  cap      int;
  new_used int;
begin
  if uid is null then
    return -1;
  end if;

  select daily_uploads into cap from profiles where id = uid;
  if cap is null then
    return -1;
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

-- Releases a unit when the upload never completed, so a failed extraction or
-- an abandoned picker does not silently cost the student one of five.
create or replace function refund_upload_quota()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  update upload_usage_daily
     set used = greatest(used - 1, 0)
   where user_id = auth.uid()
     and day = (now() at time zone 'Asia/Tokyo')::date;
end;
$$;

revoke execute on function consume_upload_quota() from public, anon;
revoke execute on function refund_upload_quota()  from public, anon;
grant  execute on function consume_upload_quota() to authenticated;
grant  execute on function refund_upload_quota()  to authenticated;
