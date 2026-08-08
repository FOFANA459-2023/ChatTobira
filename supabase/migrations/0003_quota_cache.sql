-- Per-user daily quota and semantic-cache access for the web app.
--
-- qa_cache and usage_daily deliberately have NO RLS policies: students reach
-- them only through the security-definer functions below, so nobody can reset
-- their own quota or poison the cache with direct table writes.

create table usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default (now() at time zone 'Asia/Tokyo')::date,
  used    int  not null default 0,
  primary key (user_id, day)
);

alter table usage_daily enable row level security;

-- Atomically consume one unit of today's quota. Returns remaining quota, or -1
-- if exhausted (and consumes nothing).
create or replace function consume_quota()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid    uuid := auth.uid();
  cap    int;
  new_used int;
begin
  if uid is null then
    return -1;
  end if;

  select daily_quota into cap from profiles where id = uid;
  if cap is null then
    return -1;
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

-- Cache probe for signed-in students. Bumps the hit counter on a match.
create or replace function cache_get(
  query_embedding extensions.vector(768),
  query_scope     jsonb default '{}'::jsonb,
  threshold       real  default 0.95
)
returns table (answer text, citations jsonb, similarity real)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  hit_id bigint;
begin
  if auth.uid() is null then
    return;
  end if;

  select q.id into hit_id
    from qa_cache q
   where q.scope = query_scope
     and (1 - (q.embedding <=> query_embedding)) >= threshold
   order by q.embedding <=> query_embedding
   limit 1;

  if hit_id is null then
    return;
  end if;

  update qa_cache set hits = hits + 1 where id = hit_id;

  return query
  select q.answer, q.citations,
         (1 - (q.embedding <=> query_embedding))::real
    from qa_cache q where q.id = hit_id;
end;
$$;

-- Store a generated answer for future cache hits.
create or replace function cache_put(
  q_question  text,
  q_embedding extensions.vector(768),
  q_answer    text,
  q_citations jsonb default '[]'::jsonb,
  q_scope     jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  insert into qa_cache (question, embedding, answer, citations, scope)
  values (q_question, q_embedding, q_answer, q_citations, q_scope);
end;
$$;

-- Locked down: signed-in students only, never anonymous.
revoke execute on function consume_quota() from public, anon;
revoke execute on function cache_get(extensions.vector, jsonb, real) from public, anon;
revoke execute on function cache_put(text, extensions.vector, text, jsonb, jsonb) from public, anon;
grant execute on function consume_quota() to authenticated;
grant execute on function cache_get(extensions.vector, jsonb, real) to authenticated;
grant execute on function cache_put(text, extensions.vector, text, jsonb, jsonb) to authenticated;

-- The old anonymous-signature probe is superseded by cache_get.
drop function if exists match_cached_answer(extensions.vector, jsonb, real);
