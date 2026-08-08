-- Security hardening from Supabase advisor findings.

-- handle_new_user is a signup trigger, not an API. Without this, anyone could
-- invoke it directly via /rest/v1/rpc/handle_new_user as SECURITY DEFINER.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Pin search_path so a malicious role cannot shadow tables the functions read.
alter function public.match_chunks(vector, text[], jsonb, int)
  set search_path = public, extensions;
alter function public.match_cached_answer(vector, jsonb, real)
  set search_path = public, extensions;

-- Extensions do not belong in the public (API-exposed) schema. Supabase's role
-- search_path already includes the extensions schema, so this is transparent
-- to every query; object references are by OID and survive the move.
create schema if not exists extensions;
alter extension vector  set schema extensions;
alter extension pg_trgm set schema extensions;
