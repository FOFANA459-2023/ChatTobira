-- match_chunks: expose true cosine similarity alongside the RRF score.
--
-- RRF scores are rank-based: the #1 result of a nonsense query scores the
-- same as the #1 result of a perfect match, so they cannot gate citations.
-- Cosine similarity can: below a threshold, the corpus simply does not cover
-- the question and the answer should carry no citations.

drop function if exists match_chunks(extensions.vector, text[], jsonb, int);

create or replace function match_chunks(
  query_embedding extensions.vector(768),
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
  score       real,
  similarity  real
)
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  tsq       tsquery;
  term_list text;
  pool      int := greatest(match_count * 3, 60);
  k         constant real := 60.0;  -- RRF damping
begin
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
         s.pdf_page, s.book_page, s.content, s.metadata, fused.score::real,
         coalesce(1 - (s.embedding <=> query_embedding), 0)::real as similarity
    from fused
    join scoped s on s.id = fused.id
   order by fused.score desc
   limit match_count;
end;
$$;

comment on function match_chunks is
  'Hybrid retrieval with RRF ranking plus raw cosine similarity for '
  'relevance gating. filter accepts {level, topic, citable_only}.';
