-- ONE-OFF, IRREVERSIBLE. Deletes every chat of the admin account
-- (fvarlee@gmail.com) and nothing else.
--
-- Paste the whole file into Supabase dashboard -> SQL Editor and press Run.
-- The editor will warn that the query is destructive; confirm to run it.
--
-- Deleting a conversation cascades to its messages and to the feedback on
-- them. Nothing a student owns is touched: the delete is keyed on the admin's
-- user id alone. The admin's account, profile, usage and uploads stay (after
-- migration 0013 the uploads are simply unlinked from the deleted chats).
--
-- The result grid lists every chat that was deleted. An empty grid means the
-- admin had no chats left to delete.

begin;

delete from public.conversations
 where user_id = (
   select id from auth.users where lower(email) = 'fvarlee@gmail.com'
 )
returning id, title, created_at;

commit;
