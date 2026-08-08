-- ChatTobira — initial schema
--
-- Design notes that matter:
--   * embeddings are 768-dim (gemini-embedding-001, MRL-truncated) so the whole
--     corpus fits inside Supabase's 500MB free tier with room to spare.
--   * Postgres has no Japanese FTS configuration. chunks.tokens holds
--     space-joined morphemes produced by fugashi at ingest time and is indexed
--     with the 'simple' config, which gives real lexical search over Japanese.
--   * only the three textbooks may be cited (documents.is_citable). Class
--     handouts are indexed and ground answers but are never named in a citation.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Access control: invite-only allowlist
-- ---------------------------------------------------------------------------

create table allowlist (
  email      text primary key,
  note       text,
  invited_by text,
  created_at timestamptz not null default now()
);

comment on table allowlist is
  'Invite-only gate. Signup is rejected for any email absent from this table.';

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  display_name text,
  -- 'F2' | 'F3' | 'INT' — default retrieval scope for this student
  level       text,
  -- 'adaptive' | 'en' | 'ja'
  reply_lang  text not null default 'adaptive',
  daily_quota int  not null default 40,
  created_at  timestamptz not null default now()
);

-- Enforce the allowlist at signup. Raising here aborts the auth.users insert,
-- so a non-invited student cannot create an account at all.
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

  insert into profiles (id, email, display_name)
  values (new.id, new.email, split_part(new.email, '@', 1));

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- Corpus
-- ---------------------------------------------------------------------------

create table documents (
  id          bigserial primary key,
  -- path relative to MATERIALS_ROOT; the natural key for re-ingestion
  path        text not null unique,
  title       text not null,
  -- 'F2' | 'F3' | 'INT'
  level       text,
  -- primary topic, 'T6'..'T17'. Null for textbooks, which span all topics.
  topic       text,
  -- every topic covered. Review sheets span several ("T15-T17ふくしゅう"), and a
  -- student scoped to T17 must still retrieve them.
  topics      text[] not null default '{}',
  -- 'textbook' | 'grammar' | 'reading' | 'kanji' | 'answer_key' | 'slides'
  doc_type    text not null,
  -- TRUE for the three textbooks only. Citations must never reference a
  -- document with is_citable = false.
  is_citable  boolean not null default false,
  page_count  int,
  content_sha text,
  ingested_at timestamptz,
  created_at  timestamptz not null default now()
);

create index documents_level_topic_idx on documents (level, topic);
create index documents_topics_idx      on documents using gin (topics);
create index documents_citable_idx     on documents (is_citable) where is_citable;

create table chunks (
  id           bigserial primary key,
  document_id  bigint not null references documents(id) on delete cascade,
  -- index of the page within the PDF (1-based)
  pdf_page     int not null,
  -- printed folio read off the page by the vision model. Differs from pdf_page
  -- by the front matter; this is the number shown to students.
  book_page    text,
  ord          int not null default 0,
  content      text not null,
  -- space-joined fugashi morphemes, written by the ingest pipeline
  tokens_text  text,
  -- Derived rather than written directly: casting arbitrary text to tsvector
  -- breaks on tokens containing quotes or colons, and Japanese material is full
  -- of 「」『』（） and ～. to_tsvector handles the escaping for us.
  tokens       tsvector generated always as
                 (to_tsvector('simple', coalesce(tokens_text, ''))) stored,
  -- kana reading, so a query for みえる matches material written 見える
  reading      text,
  embedding    vector(768),
  -- {level, topic, grammar_point, is_answer_key, heading}
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (document_id, pdf_page, ord)
);

create index chunks_embedding_idx on chunks
  using hnsw (embedding vector_cosine_ops);
create index chunks_tokens_idx   on chunks using gin (tokens);
create index chunks_reading_idx  on chunks using gin (reading gin_trgm_ops);
create index chunks_document_idx on chunks (document_id);
create index chunks_topic_idx    on chunks ((metadata->>'topic'));

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

create table conversations (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text,
  -- study-mode filter, e.g. {"level":"F3","topic":"T13"}; {} means unscoped
  scope      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index conversations_user_idx on conversations (user_id, created_at desc);

create table messages (
  id              bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  -- [{document_id, title, book_page, quote}] — citable documents only
  citations       jsonb not null default '[]'::jsonb,
  -- provider actually used, so fallbacks are visible after the fact
  model           text,
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on messages (conversation_id, created_at);

create table feedback (
  id         bigserial primary key,
  message_id bigint not null references messages(id) on delete cascade,
  user_id    uuid   not null references auth.users(id) on delete cascade,
  rating     smallint not null check (rating in (-1, 1)),
  note       text,
  created_at timestamptz not null default now(),
  unique (message_id, user_id)
);

-- Semantic cache. 100 students ask the same ~30 grammar questions; a hit here
-- is what keeps the deployment inside Groq's 1,000 requests/day free ceiling.
create table qa_cache (
  id         bigserial primary key,
  question   text not null,
  embedding  vector(768) not null,
  answer     text not null,
  citations  jsonb not null default '[]'::jsonb,
  scope      jsonb not null default '{}'::jsonb,
  hits       int not null default 0,
  created_at timestamptz not null default now()
);

create index qa_cache_embedding_idx on qa_cache
  using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table profiles      enable row level security;
alter table conversations enable row level security;
alter table messages      enable row level security;
alter table feedback      enable row level security;
alter table documents     enable row level security;
alter table chunks        enable row level security;
alter table allowlist     enable row level security;
alter table qa_cache      enable row level security;

create policy "own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "own conversations" on conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own messages" on messages
  for all using (
    exists (select 1 from conversations c
            where c.id = messages.conversation_id and c.user_id = auth.uid())
  ) with check (
    exists (select 1 from conversations c
            where c.id = messages.conversation_id and c.user_id = auth.uid())
  );

create policy "own feedback" on feedback
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Corpus is readable by any signed-in student; writes happen only through the
-- service role during ingestion, which bypasses RLS.
create policy "signed-in read documents" on documents
  for select using (auth.role() = 'authenticated');
create policy "signed-in read chunks" on chunks
  for select using (auth.role() = 'authenticated');

-- allowlist and qa_cache: no policies. Service role only.

-- ---------------------------------------------------------------------------
-- Hybrid retrieval: pgvector + Japanese FTS, fused with Reciprocal Rank Fusion
-- ---------------------------------------------------------------------------

create or replace function match_chunks(
  query_embedding vector(768),
  query_tokens    text[]  default '{}',
  filter          jsonb   default '{}'::jsonb,
  match_count     int     default 20
)
returns table (
  chunk_id    bigint,
  document_id bigint,
  doc_title   text,
  doc_type    text,
  is_citable  boolean,
  pdf_page    int,
  book_page   text,
  content     text,
  metadata    jsonb,
  score       real
)
language plpgsql
stable
as $$
declare
  tsq       tsquery;
  term_list text;
  pool      int := greatest(match_count * 3, 60);
  k         constant real := 60.0;  -- RRF damping
begin
  -- Build an OR tsquery from the caller's morphemes. OR rather than AND: recall
  -- matters more than precision here because RRF and the reranker filter after.
  select string_agg(quote_literal(t), ' | ')
    into term_list
    from unnest(query_tokens) as t
   where t is not null and btrim(t) <> '';

  if term_list is not null then
    tsq := to_tsquery('simple', term_list);
  end if;

  return query
  with scoped as (
    select c.id, c.document_id, c.pdf_page, c.book_page, c.content,
           c.metadata, c.embedding, c.tokens,
           d.title, d.doc_type, d.is_citable
      from chunks c
      join documents d on d.id = c.document_id
     where (filter->>'level' is null or d.level = filter->>'level' or d.is_citable)
       -- Textbooks carry no topic because they span all of them. Without the
       -- is_citable carve-out, scoping a conversation to T13 would exclude every
       -- citable source and the answer would come back with no citations at all.
       and (filter->>'topic' is null
            or d.is_citable
            or d.topic = filter->>'topic'
            or d.topics @> array[filter->>'topic'])
       and (filter->>'citable_only' is null
            or filter->>'citable_only' = 'false'
            or d.is_citable)
  ),
  vec as (
    select s.id, row_number() over (order by s.embedding <=> query_embedding) as rank
      from scoped s
     where s.embedding is not null
     order by s.embedding <=> query_embedding
     limit pool
  ),
  fts as (
    select s.id, row_number() over (order by ts_rank_cd(s.tokens, tsq) desc) as rank
      from scoped s
     where tsq is not null and s.tokens @@ tsq
     limit pool
  ),
  fused as (
    select coalesce(v.id, f.id) as id,
           coalesce(1.0 / (k + v.rank), 0.0)
         + coalesce(1.0 / (k + f.rank), 0.0) as score
      from vec v
      full outer join fts f on f.id = v.id
  )
  select s.id, s.document_id, s.title, s.doc_type, s.is_citable,
         s.pdf_page, s.book_page, s.content, s.metadata, fused.score::real
    from fused
    join scoped s on s.id = fused.id
   order by fused.score desc
   limit match_count;
end;
$$;

comment on function match_chunks is
  'Hybrid retrieval. Pass query_tokens as fugashi morphemes of the query. '
  'filter accepts {level, topic, citable_only}. Ranking is tunable here '
  'without redeploying the Worker.';

-- Semantic cache probe. Returns a hit only above the similarity threshold and
-- only within the same study scope.
create or replace function match_cached_answer(
  query_embedding vector(768),
  query_scope     jsonb default '{}'::jsonb,
  threshold       real  default 0.95
)
returns table (id bigint, answer text, citations jsonb, similarity real)
language sql
stable
as $$
  select q.id, q.answer, q.citations,
         (1 - (q.embedding <=> query_embedding))::real as similarity
    from qa_cache q
   where q.scope = query_scope
     and (1 - (q.embedding <=> query_embedding)) >= threshold
   order by q.embedding <=> query_embedding
   limit 1;
$$;
