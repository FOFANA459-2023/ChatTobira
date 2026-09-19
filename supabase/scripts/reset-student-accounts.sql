-- ONE-OFF, IRREVERSIBLE. Run once, by hand, after 0010_open_signup.sql.
--
-- The move to open signup asks every student to register again with their
-- @apu.ac.jp address and a password. Their old invite-era accounts have to go
-- first, for two reasons:
--
--   * Supabase answers a signup for an address that already has a confirmed
--     account with a silent success and sends nothing (it will not reveal that
--     the address exists). A student with an old account would press
--     "Create account", be told to check their inbox, and never get an email.
--   * The old accounts have no password, so they could never sign in anyway.
--
-- Deleting an auth user cascades to everything keyed on it: profile,
-- conversations, messages, feedback, quiz history, uploads, usage. That is the
-- point, and it is also why this file is NOT in migrations/.
--
-- The admin account is kept.
--
-- Supabase dashboard -> SQL editor. Look at the preview first.

-- 1. Preview: who is removed.
select id, email, created_at, last_sign_in_at
  from auth.users
 where lower(email) <> 'fvarlee@gmail.com'
 order by created_at;

-- 2. Remove them. Uncomment to run.
-- delete from auth.users where lower(email) <> 'fvarlee@gmail.com';
