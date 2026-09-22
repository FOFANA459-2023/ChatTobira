import { z } from "zod";

import {
  embedQuery,
  grammarPatterns,
  retrieve,
  retrieveExact,
  selectContext,
  tokensForQuery,
  type RetrievedChunk,
} from "@/lib/retrieval";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 15;

const BodySchema = z.object({ query: z.string().trim().min(1).max(300) });

/** How much of each passage the live tutor is handed. It reads these while a
 * student waits in silence, so they are kept short: enough for the rule and
 * an example, not the page. */
const PASSAGE_CHARS = 700;
const PASSAGES = 3;

/** The live tutor's one tool: the same hybrid retrieval the typed chat uses.
 *
 * Called by the browser when the model asks for it mid-conversation, and only
 * then — ordinary conversation never touches the corpus, which is what keeps
 * those turns under a second. A grammar question pays for one embedding and
 * one search, a few hundred milliseconds, and is answered from the student's
 * own books rather than from whatever the model remembers.
 *
 * Read under the student's own RLS, like every other corpus read.
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
  const { query } = parsed.data;

  try {
    const [vector, exact] = await Promise.all([
      embedQuery(query),
      retrieveExact(supabase, grammarPatterns(query)).catch(() => [] as RetrievedChunk[]),
    ]);
    const ranked = await retrieve(supabase, vector, tokensForQuery(query), {}, 10);
    const seen = new Set<number>();
    const merged = [...exact, ...ranked].filter((chunk) =>
      seen.has(chunk.chunk_id) ? false : (seen.add(chunk.chunk_id), true),
    );
    const passages = selectContext(merged, { limit: PASSAGES }).map((chunk) => ({
      // A textbook is named with its page so the tutor can send the student
      // there. Anything else is "class materials" and nothing more: its file
      // name would be read aloud as the name of a past paper or a handout.
      source: chunk.is_citable
        ? chunk.book_page
          ? `${chunk.doc_title}, p.${chunk.book_page}`
          : chunk.doc_title
        : `class materials${typeof chunk.metadata?.topic === "string" ? `, Topic ${chunk.metadata.topic.replace(/^T/, "")}` : ""}`,
      text: chunk.content.replace(/\s+/g, " ").slice(0, PASSAGE_CHARS),
    }));
    return Response.json({ passages });
  } catch (error) {
    console.error("voice lookup failed:", error instanceof Error ? error.message : error);
    // The tutor still answers, from what it knows, rather than going silent.
    return Response.json({ passages: [], note: "The textbooks and class materials could not be searched just now." });
  }
}
