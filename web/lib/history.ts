import type { SupabaseClient } from "@supabase/supabase-js";
import type { UIMessage } from "ai";

import type { Citation } from "./retrieval";

/** One saved chat, as the history list shows it. */
export interface ConversationSummary {
  id: number;
  title: string;
  createdAt: string;
}

/** A file the student added to a chat. It sits in the transcript at the point
 * it was added — `after` is how many messages came before it — rather than
 * pinned above the composer, so reopening the chat shows it where it was. */
export interface ChatUpload {
  id: number;
  filename: string;
  status: "uploading" | "reading" | "ready" | "failed";
  detail?: string;
  after: number;
}

interface MessageRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  citations: Citation[] | null;
  model: string | null;
  created_at: string;
}

interface UploadRow {
  id: number;
  filename: string;
  status: string;
  error: string | null;
  created_at: string;
}

/** The chats a student can go back to, newest first, without the ones they
 * deleted. RLS limits the rows to their own, so there is no user filter here
 * to forget. */
export async function listConversations(
  supabase: SupabaseClient,
  limit = 100,
): Promise<ConversationSummary[]> {
  const query = () =>
    supabase
      .from("conversations")
      .select("id, title, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
  let { data, error } = await query().is("deleted_at", null);
  // Before migration 0013 there is no deleted_at to filter on, and nothing
  // has been deleted either: the unfiltered list is the right list.
  if (error) ({ data, error } = await query());
  return ((data ?? []) as { id: number; title: string | null; created_at: string }[]).map(
    (row) => ({
      id: row.id,
      title: row.title?.trim() || "Untitled chat",
      createdAt: row.created_at,
    }),
  );
}

/** Longest title the sidebar keeps. */
export const MAX_TITLE = 80;

/** Rename a chat. False when it is not this student's or does not exist. */
export async function renameConversation(
  supabase: SupabaseClient,
  id: number,
  title: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("conversations")
    .update({ title: title.trim().slice(0, MAX_TITLE) })
    .eq("id", id)
    .select("id");
  return (data ?? []).length > 0;
}

/** Take a chat out of the sidebar.
 *
 * For a student the rows stay: every student record is kept, and the admin
 * views count these messages. "unavailable" before migration 0013, when
 * there is no column to mark it with.
 *
 * `permanent` is the admin's own account, whose chats are testing rather than
 * coursework: the conversation goes, and its messages and feedback with it
 * (both cascade). */
export async function deleteConversation(
  supabase: SupabaseClient,
  id: number,
  { permanent = false }: { permanent?: boolean } = {},
): Promise<"deleted" | "not_found" | "unavailable"> {
  const { data, error } = permanent
    ? await supabase.from("conversations").delete().eq("id", id).select("id")
    : await supabase
        .from("conversations")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");
  if (error) return "unavailable";
  return (data ?? []).length > 0 ? "deleted" : "not_found";
}

/** The two rows one chat turn is saved as: the question and its answer.
 *
 * Both rows carry every column, on purpose. They go to PostgREST as one bulk
 * insert, and a bulk insert fills a column one row leaves out with NULL, not
 * with its default — so a question row without `citations` sent NULL into a
 * NOT NULL column and failed the whole insert. Every chat turn was lost that
 * way until it was noticed. */
export function turnRows(turn: {
  conversationId: number;
  question: string;
  askedAt: string;
  answer: string;
  answeredAt: string;
  citations: Citation[];
  model: string;
}) {
  return [
    {
      conversation_id: turn.conversationId,
      role: "user" as const,
      content: turn.question,
      citations: [] as Citation[],
      model: null,
      created_at: turn.askedAt,
    },
    {
      conversation_id: turn.conversationId,
      role: "assistant" as const,
      content: turn.answer,
      citations: turn.citations,
      model: turn.model,
      created_at: turn.answeredAt,
    },
  ];
}

/** Saved rows in the shape useChat renders. Ids are prefixed so they can never
 * collide with the ids useChat mints for new turns. */
export function toUIMessages(rows: MessageRow[], conversationId: number): UIMessage[] {
  return rows.map((row) => ({
    id: `saved-${row.id}`,
    role: row.role,
    parts: [{ type: "text", text: row.content }],
    metadata:
      row.role === "assistant"
        ? { citations: row.citations ?? [], model: row.model ?? undefined, conversationId }
        : undefined,
  }));
}

/** Where each upload sits among the messages: after every message written no
 * later than it was added. */
export function placeUploads(uploads: UploadRow[], messages: MessageRow[]): ChatUpload[] {
  const times = messages.map((m) => Date.parse(m.created_at));
  return uploads
    // 'pending' never finished uploading, so there is nothing to show.
    .filter((u) => u.status !== "pending")
    .map((u) => {
      const at = Date.parse(u.created_at);
      return {
        id: u.id,
        filename: u.filename,
        status: u.status === "failed" ? ("failed" as const) : ("ready" as const),
        detail: u.status === "failed" ? (u.error ?? undefined) : undefined,
        after: times.filter((t) => t <= at).length,
      };
    });
}

/** One saved chat, whole: its messages and the files added to it. Null when
 * it does not exist, was deleted, or is not this student's — RLS returns no
 * row for someone else's conversation, which is the same as it not existing.
 *
 * One round trip, not two: the three reads go out together, and the messages
 * are simply discarded if the conversation turns out not to be readable. RLS
 * already returns no messages for a conversation that is not the student's,
 * so asking for them first costs nothing in safety. */
export async function loadConversation(
  supabase: SupabaseClient,
  id: number,
): Promise<{ id: number; messages: UIMessage[]; uploads: ChatUpload[] } | null> {
  const [{ data: conversation }, { data: messageRows }, uploadsResult] = await Promise.all([
    // "*" rather than naming deleted_at, so this still reads before
    // migration 0013 adds the column.
    supabase.from("conversations").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("messages")
      .select("id, role, content, citations, model, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("uploads")
      .select("id, filename, status, error, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true }),
  ]);
  if (!conversation || (conversation as { deleted_at?: string | null }).deleted_at) return null;

  const messages = (messageRows ?? []) as MessageRow[];
  // A database without uploads.conversation_id yet (migration 0013 not
  // applied) answers with an error here. The chat still opens, without files.
  const uploads = uploadsResult.error ? [] : ((uploadsResult.data ?? []) as UploadRow[]);

  return {
    id,
    messages: toUIMessages(messages, id),
    uploads: placeUploads(uploads, messages),
  };
}
