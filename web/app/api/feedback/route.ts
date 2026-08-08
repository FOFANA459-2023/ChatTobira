import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

const BodySchema = z.object({
  conversationId: z.number().int().positive(),
  rating: z.union([z.literal(1), z.literal(-1)]),
  note: z.string().max(500).optional(),
});

/** Thumbs on the most recent answer in a conversation.
 * RLS scopes everything to the signed-in student: the conversation lookup
 * only sees their own rows, and the feedback insert checks user_id. */
export async function POST(request: Request) {
  const supabase = await createClient();
  let user = null;
  try {
    ({
      data: { user },
    } = await supabase.auth.getUser());
  } catch {
    /* unreachable auth backend reads as signed out */
  }
  if (!user) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { conversationId, rating, note } = parsed.data;

  const { data: message } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!message) {
    return Response.json({ error: "no_message" }, { status: 404 });
  }

  const { error } = await supabase.from("feedback").upsert(
    {
      message_id: (message as { id: number }).id,
      user_id: user.id,
      rating,
      note: note ?? null,
    },
    { onConflict: "message_id,user_id" },
  );
  if (error) {
    return Response.json({ error: "save_failed" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
