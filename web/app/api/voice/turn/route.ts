import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

export const maxDuration = 10;

const BodySchema = z.object({
  conversationId: z.number().int().positive().optional(),
  user: z.string().trim().max(4000),
  assistant: z.string().trim().max(8000),
});

/** One spoken exchange from a live conversation, written to the same
 * conversation as a typed one — so the history, the admin's activity column
 * and a reload all see spoken turns exactly as they see typed ones.
 *
 * Written by the browser, from the transcripts the live model sends of both
 * sides, once each exchange is over. Nothing here is on the path to anything
 * the student hears.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
  if (!user) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success || (!parsed.data.user && !parsed.data.assistant)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { user: said, assistant: replied } = parsed.data;
  let { conversationId } = parsed.data;

  if (!conversationId) {
    const { data } = await supabase
      .from("conversations")
      .insert({ user_id: user.id, scope: {}, title: (said || replied).slice(0, 60) })
      .select("id")
      .single();
    conversationId = (data as { id: number } | null)?.id;
    if (!conversationId) {
      return Response.json({ error: "save_failed" }, { status: 500 });
    }
  }

  const now = Date.now();
  const rows = [
    said && {
      conversation_id: conversationId,
      role: "user",
      content: said,
      created_at: new Date(now - 1).toISOString(),
    },
    replied && {
      conversation_id: conversationId,
      role: "assistant",
      content: replied,
      model: process.env.LIVE_MODEL ?? "live",
      created_at: new Date(now).toISOString(),
    },
  ].filter(Boolean);

  // RLS on messages checks the conversation belongs to this student, so an
  // id from someone else's conversation inserts nothing.
  const { error } = await supabase.from("messages").insert(rows);
  if (error) {
    return Response.json({ error: "save_failed" }, { status: 500 });
  }
  return Response.json({ conversationId });
}
