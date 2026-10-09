import { z } from "zod";

import { isLanguage } from "@/lib/translate";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 10;

/** At most this many segments in one write. A lecture produces a segment every
 * few seconds, so the browser batches them; the cap is what stops a single
 * request from carrying an hour of them. */
const MAX_BATCH = 50;

const SegmentSchema = z.object({
  /** Position in the lecture, assigned by the browser. Unique per
   * conversation, so a segment re-sent after a dropped connection updates the
   * row it already wrote rather than making a second one. */
  seq: z.number().int().nonnegative(),
  source: z.string().max(4000),
  translated: z.string().max(8000),
  /** Milliseconds from the start of the session. */
  offsetMs: z.number().int().nonnegative().optional(),
});

const BodySchema = z.object({
  conversationId: z.number().int().positive().optional(),
  sourceLang: z.string().max(10).optional(),
  targetLang: z.string().max(10),
  /** Names the conversation when this write is the one that creates it. */
  title: z.string().trim().min(1).max(80).optional(),
  segments: z.array(SegmentSchema).min(1).max(MAX_BATCH),
});

/** Segments of a live translation session, written as the lecture runs.
 *
 * Written DURING the session rather than at the end of it, which is the
 * whole point of the endpoint. A browser that dies forty minutes into a
 * lecture should cost the student the last sentence, not the lecture; and a
 * student who closes the tab without pressing End should still find the
 * lecture in their history.
 *
 * Upsert rather than insert, on (conversation_id, seq). Two things need that.
 * A translation is provisional until the sentences after it arrive, so the
 * browser rewrites a segment it has already sent when the model improves it.
 * And a reconnection re-sends whatever it was unsure had landed, which must
 * not double the lecture.
 *
 * RLS on translation_segments reaches the owner through the conversation, so
 * an id belonging to somebody else writes nothing.
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
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { segments, title } = parsed.data;
  const targetLang = isLanguage(parsed.data.targetLang) ? parsed.data.targetLang : "en";
  const sourceLang =
    parsed.data.sourceLang && isLanguage(parsed.data.sourceLang) ? parsed.data.sourceLang : null;
  let { conversationId } = parsed.data;

  if (!conversationId) {
    const { data } = await supabase
      .from("conversations")
      .insert({
        user_id: user.id,
        scope: {},
        title: title ?? `Live translation — ${new Date().toLocaleDateString("en-GB")}`,
      })
      .select("id")
      .single();
    conversationId = (data as { id: number } | null)?.id;
    if (!conversationId) {
      return Response.json({ error: "save_failed" }, { status: 500 });
    }
  }

  // Empty on both sides is nothing to keep: the model produces no output for
  // a stretch that was only filler, and a row with neither half is noise in
  // the saved lecture.
  const rows = segments
    .filter((s) => s.source.trim() || s.translated.trim())
    .map((s) => ({
      conversation_id: conversationId,
      seq: s.seq,
      source_text: s.source,
      translated_text: s.translated,
      source_lang: sourceLang,
      target_lang: targetLang,
      offset_ms: s.offsetMs ?? null,
    }));
  if (rows.length === 0) {
    return Response.json({ conversationId, saved: 0 });
  }

  const { error } = await supabase
    .from("translation_segments")
    .upsert(rows, { onConflict: "conversation_id,seq" });
  if (error) {
    console.error(`translation segments save failed: ${error.message}`);
    return Response.json({ error: "save_failed" }, { status: 500 });
  }

  return Response.json({ conversationId, saved: rows.length });
}
