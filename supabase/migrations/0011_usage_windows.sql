-- Five-hour usage windows: 20 requests and 10 minutes of conversation.
--
-- The daily quota (40 units, reset at midnight Japan time, spent by chat,
-- practice tests AND each live voice connection) is replaced by two
-- allowances per student that renew five hours after they start:
--
--   chat   20 requests — a chat question or a practice test, one each
--   voice  600 seconds — ten minutes of live spoken conversation
--
-- A window opens at the first use after the previous one has ended and runs
-- for five hours from then, so a student who studies at 9am and again at 3pm
-- gets a full allowance both times, and nobody's allowance renews while they
-- are asleep and unable to use it.
--
-- Voice is spent a MINUTE AT A TIME, when each minute starts. The browser
-- talks to the live model directly, so the server never sees how long a call
-- lasts — but it mints the token every connection needs, and a token's expiry
-- ends a running call (measured: "closed 1011 auth token has expired" at the
-- second). So each token is minted for one minute and one minute is charged
-- for it, and the call moves onto the next token without a break. Nothing a
-- student does in the browser can make a minute last longer. A call that ends
-- part way through a minute has used that minute, as a phone call does.
--
-- The teacher's account is still unmetered (profiles.unlimited_quota, 0009).
-- usage_daily is still written, because the admin roster reads "questions
-- today" from it; it no longer limits anything.

create table if not exists usage_windows (
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- 'chat' | 'voice'
  kind         text not null check (kind in ('chat', 'voice')),
  window_start timestamptz not null default now(),
  -- requests for chat, seconds for voice
  used         int not null default 0,
  primary key (user_id, kind)
);

-- No policies: students reach this only through the functions below, so
-- nobody can reset their own allowance with a direct write.
alter table usage_windows enable row level security;

comment on table usage_windows is
  'Each student''s current five-hour window per allowance. Service/definer access only.';

create or replace function allowance_limit(p_kind text)
returns int
language sql
immutable
as $$
  select case p_kind when 'chat' then 20 when 'voice' then 600 end;
$$;

create or replace function allowance_window()
returns interval
language sql
immutable
as $$
  select interval '5 hours';
$$;

/** Spend `p_amount` from the caller's allowance, atomically.
 *
 * Returns what is left and when the window renews. `allowed` is false — and
 * nothing is spent — when the amount does not fit. One UPDATE both rolls an
 * expired window over and spends from it, so two requests racing each other
 * cannot both be allowed by a check the other has not yet written past. */
create or replace function consume_allowance(p_kind text, p_amount int)
returns table (allowed boolean, remaining int, resets_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  cap       int := allowance_limit(p_kind);
  unlimited boolean;
  row_start timestamptz;
  row_used  int;
begin
  if uid is null or cap is null or p_amount < 1 then
    return query select false, 0, null::timestamptz;
    return;
  end if;

  select p.unlimited_quota into unlimited from profiles p where p.id = uid;
  -- No profile row is still no access: an account that never completed
  -- signup has nothing to spend.
  if unlimited is null then
    return query select false, 0, null::timestamptz;
    return;
  end if;

  insert into usage_windows (user_id, kind, window_start, used)
  values (uid, p_kind, now(), 0)
  on conflict (user_id, kind) do nothing;

  update usage_windows w
     set window_start = case when w.window_start <= now() - allowance_window()
                             then now() else w.window_start end,
         used = (case when w.window_start <= now() - allowance_window()
                      then 0 else w.used end) + p_amount
   where w.user_id = uid
     and w.kind = p_kind
     and (unlimited
          or (case when w.window_start <= now() - allowance_window()
                   then 0 else w.used end) + p_amount <= cap)
  returning w.window_start, w.used into row_start, row_used;

  if row_start is null then
    -- Did not fit. Report the window as it stands.
    select w.window_start, w.used into row_start, row_used
      from usage_windows w where w.user_id = uid and w.kind = p_kind;
    return query select false, greatest(cap - row_used, 0), row_start + allowance_window();
    return;
  end if;

  -- Kept for the admin roster's "questions today" column.
  if p_kind = 'chat' then
    insert into usage_daily (user_id, used) values (uid, 1)
    on conflict (user_id, day) do update set used = usage_daily.used + 1;
  end if;

  return query select
    true,
    case when unlimited then 2147483647 else greatest(cap - row_used, 0) end,
    row_start + allowance_window();
end;
$$;

revoke execute on function consume_allowance(text, int) from public, anon;
grant  execute on function consume_allowance(text, int) to authenticated;

/** What the caller has left, without spending anything — for the UI. */
create or replace function allowance_status()
returns table (kind text, used int, allowance int, resets_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select k.kind,
         case when w.window_start is null or w.window_start <= now() - allowance_window()
              then 0 else w.used end,
         allowance_limit(k.kind),
         case when w.window_start is null or w.window_start <= now() - allowance_window()
              then null else w.window_start + allowance_window() end
    from (values ('chat'), ('voice')) as k(kind)
    left join usage_windows w on w.user_id = auth.uid() and w.kind = k.kind
   where auth.uid() is not null;
$$;

revoke execute on function allowance_status() from public, anon;
grant  execute on function allowance_status() to authenticated;

/** One chat request or practice test. Same signature and meaning the routes
 * already rely on: remaining count, or -1 when there is none left. */
create or replace function consume_quota()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  verdict record;
begin
  select * into verdict from consume_allowance('chat', 1);
  if not verdict.allowed then
    return -1;
  end if;
  return verdict.remaining;
end;
$$;

revoke execute on function consume_quota() from public, anon;
grant  execute on function consume_quota() to authenticated;
