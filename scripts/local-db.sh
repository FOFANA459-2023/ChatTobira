#!/usr/bin/env bash
#
# A local copy of the production database, for development and for the quiz
# harness to be run against.
#
# The rule this script exists to enforce: nothing in development writes to
# production. Quiz work needs a corpus — the real books, the real past papers,
# the real chunk metadata — and every way of getting one that ends in "just
# point it at prod for a moment" eventually ends in a re-index against a
# database a hundred students are reading. So the corpus is COPIED, once, by a
# pg_dump that takes nothing but ACCESS SHARE locks, into a container.
#
# Read-only against production is not a comment, it is the only command this
# script sends there: pg_dump. Everything after it runs against localhost.
#
#   scripts/local-db.sh up       start the container and load a fresh copy
#   scripts/local-db.sh refresh  re-dump production into the running container
#   scripts/local-db.sh psql     open a shell on the local copy
#   scripts/local-db.sh export   write the quiz fixture the harness reads
#   scripts/local-db.sh down     stop and delete the container
#
# The local copy's URL, for .env.local:
#   DATABASE_URL=postgresql://postgres:localdev@127.0.0.1:55432/postgres
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER=chattobira-devdb
PORT=55432
PASSWORD=localdev
IMAGE=pgvector/pgvector:pg17
CLIENT=postgres:17-alpine
LOCAL_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres"
# Inside a container talking to the host's published port.
LOCAL_URL_FROM_CONTAINER="postgresql://postgres:${PASSWORD}@host.docker.internal:${PORT}/postgres"
DUMP="${ROOT}/.work/prod-public.dump"

prod_url() {
  # Read from .env rather than the environment, so a shell that happens to
  # have DATABASE_URL pointing at the LOCAL copy cannot make "refresh" a no-op
  # that silently leaves a stale fixture behind.
  local url
  url="$(sed -n 's/^DATABASE_URL=//p' "${ROOT}/.env" | head -1 | tr -d '\r')"
  if [ -z "$url" ]; then
    echo "no DATABASE_URL in ${ROOT}/.env" >&2
    exit 1
  fi
  if printf '%s' "$url" | grep -qE '127\.0\.0\.1|localhost'; then
    echo "DATABASE_URL in .env points at a local database; nothing to copy" >&2
    exit 1
  fi
  printf '%s' "$url"
}

local_psql() {
  docker run --rm -i --add-host=host.docker.internal:host-gateway "$CLIENT" \
    psql "$LOCAL_URL_FROM_CONTAINER" "$@"
}

start_container() {
  if [ -n "$(docker ps -q -f "name=^${CONTAINER}$")" ]; then
    echo "• ${CONTAINER} already running on :${PORT}"
    return
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "• starting ${CONTAINER} (${IMAGE}) on :${PORT}"
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD="$PASSWORD" \
    -p "127.0.0.1:${PORT}:5432" \
    "$IMAGE" >/dev/null
  printf '  waiting for postgres'
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -q -U postgres 2>/dev/null; then
      echo " — ready"
      return
    fi
    printf '.'
    sleep 1
  done
  echo
  echo "postgres did not come up" >&2
  exit 1
}

# Supabase keeps its extensions in an `extensions` schema and its users in
# `auth`, and the dumped public schema refers to both — `extensions.vector` on
# every embedding column, `auth.users` on every user foreign key, `auth.uid()`
# in every RLS policy. Neither schema is in the dump (it is public only, which
# is the point: no auth data leaves production), so they are stubbed here.
# auth.users is left EMPTY on purpose. The copy carries course material and
# nothing about a student.
prepare_schemas() {
  echo "• preparing extensions/ and auth/ stubs"
  local_psql -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists extensions;
create schema if not exists auth;
create extension if not exists vector  with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- The one auth function the public schema's policies call. Returning null is
-- the honest answer here: nobody is signed in on a local copy, so every RLS
-- policy denies, and the harness reads with the service role the way the app
-- does for trial visitors.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'service_role')
$$;
SQL
}

# Tables whose SHAPE is copied and whose ROWS are not.
#
# The corpus is what development needs; the student body is not. profiles and
# allowlist are a list of a hundred classmates' email addresses, quiz_items is
# what each of them was asked and messages is what each of them typed, and
# none of it makes a generated paper one line better. Copying it would put a
# named student's coursework on a laptop for no reason — the same objection
# the ingest pipeline answers for the scanned past papers, and the answer is
# the same one: leave it where it is.
#
# The tables still arrive, empty, because the app queries them and a copy that
# 404s on quiz history is not a copy of the app's database.
PRIVATE_TABLES=(
  allowlist profiles conversations messages feedback qa_cache
  quiz_items uploads upload_usage_daily usage_daily
)

dump_production() {
  echo "• dumping production public schema (read-only, corpus rows only)"
  mkdir -p "${ROOT}/.work"
  local excludes=()
  for table in "${PRIVATE_TABLES[@]}"; do
    excludes+=(--exclude-table-data="public.${table}")
  done
  # --schema=public: course material and app tables. No auth schema, no
  # storage schema, no vault — nothing that identifies a student leaves the
  # production database, and the copy cannot be used to sign anybody in.
  docker run --rm "$CLIENT" pg_dump \
    --format=custom --no-owner --no-privileges --schema=public \
    "${excludes[@]}" \
    "$(prod_url)" > "$DUMP"
  echo "  $(du -h "$DUMP" | cut -f1) → ${DUMP#"$ROOT/"}"
}

restore_local() {
  echo "• restoring into the local copy"
  # --clean --if-exists so a refresh replaces the previous copy rather than
  # colliding with it. Errors are shown but not fatal: a dump made against
  # Supabase always fails a few statements that only its own roles may run
  # (event triggers, publication grants), and none of them are the corpus.
  docker run --rm -i --add-host=host.docker.internal:host-gateway "$CLIENT" \
    pg_restore --no-owner --no-privileges --clean --if-exists \
    --dbname "$LOCAL_URL_FROM_CONTAINER" < "$DUMP" 2>&1 |
    grep -vE 'does not exist, skipping|must be owner|permission denied for schema (auth|storage)' || true
}

summarise() {
  echo
  echo "local copy: $LOCAL_URL"
  local_psql -tAc "
    select '  documents ' || count(*) || ' (' ||
           count(*) filter (where doc_type = 'past_paper') || ' past papers, ' ||
           count(*) filter (where is_citable) || ' citable)'
      from documents
    union all
    select '  chunks    ' || count(*) from chunks
    union all
    select '  chunk text ' || pg_size_pretty(sum(length(content))::bigint) from chunks
    union all
    select '  students  ' || (select count(*) from profiles) || ' profiles, ' ||
           (select count(*) from quiz_items) || ' quiz items, ' ||
           (select count(*) from auth.users) || ' users  (empty by design)';"
}

case "${1:-up}" in
  up)
    start_container
    prepare_schemas
    dump_production
    restore_local
    summarise
    ;;
  refresh)
    dump_production
    restore_local
    summarise
    ;;
  psql)
    shift
    local_psql "$@"
    ;;
  export)
    node "${ROOT}/web/scripts/export-fixture.mjs"
    ;;
  down)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "• ${CONTAINER} removed"
    ;;
  url)
    echo "$LOCAL_URL"
    ;;
  *)
    sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
