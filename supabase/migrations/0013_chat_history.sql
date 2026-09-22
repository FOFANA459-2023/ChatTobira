-- Chat history: a sidebar of saved chats a student can reopen, rename and
-- delete, and files that belong to the chat they were added to.
--
-- Conversations and messages have always been saved; what was missing was a
-- way back into them.
--
-- 1. uploads.conversation_id — an upload used to float above the composer for
--    as long as the page was open and belong to no conversation at all, so
--    reopening a chat would have shown the questions about a worksheet
--    without the worksheet. Set by /api/chat when a turn is sent with the
--    upload in context: an upload added at the very start of a new chat has
--    no conversation to point at until the first question creates one.
--    `on delete set null` so a chat going away never takes a file the student
--    may have shared for review with it.
--
-- 2. conversations.deleted_at — "delete" hides a chat from the student and
--    keeps the rows. Every student record is kept (the admin views count
--    messages), so a student's delete is a statement about their sidebar, not
--    about the database.
--
-- The app tolerates both columns being absent — chats open without their
-- files, the list is unfiltered, and delete answers that it is unavailable —
-- so the code may deploy before this is applied.

alter table uploads
  add column if not exists conversation_id bigint
    references conversations(id) on delete set null;

create index if not exists uploads_conversation_idx
  on uploads (conversation_id, created_at)
  where conversation_id is not null;

alter table conversations
  add column if not exists deleted_at timestamptz;

create index if not exists conversations_user_live_idx
  on conversations (user_id, created_at desc)
  where deleted_at is null;
