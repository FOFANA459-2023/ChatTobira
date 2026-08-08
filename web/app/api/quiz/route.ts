import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateObject } from "ai";
import { z } from "zod";

import { QuizSchema } from "@/lib/quiz";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

const BodySchema = z.object({
  // The student picks a specific source: quizzes from "everything" produced
  // vague drills and slow generation over an unfocused sample.
  documentId: z.number().int().positive(),
  topic: z.string().regex(/^T\d{1,2}$/).optional(),
  count: z.number().int().min(3).max(10).default(5),
});

const SYSTEM = `You create Japanese practice drills for university students from
provided course material. Rules:
- Base every item ONLY on the provided material; drill the grammar patterns and
  vocabulary that actually appear in it.
- Japanese in Japanese script with furigana as 漢字（かんじ） on first use.
- multiple_choice: exactly 4 choices, one correct, distractors that reflect
  real learner confusions (wrong particle, wrong conjugation, wrong register).
- fill_blank: the question shows a sentence with ＿＿ and asks for the missing
  form; the answer is the exact text that fills the blank.
- explanation: one or two sentences on WHY, in simple English with the
  Japanese pattern named.
- Never reference "the source", file names, or page numbers in questions.`;

async function requireUser() {
  const supabase = await createClient();
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return { supabase, user };
  } catch {
    return { supabase, user: null };
  }
}

/** Books and topics available for quizzing, for the picker UI. */
export async function GET() {
  const { supabase, user } = await requireUser();
  if (!user) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, level, doc_type, topics, is_citable")
    .order("is_citable", { ascending: false })
    .order("title");
  if (error) {
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }

  const books = (data ?? []).map((d) => ({
    id: d.id as number,
    title: d.title as string,
    level: d.level as string | null,
    doc_type: d.doc_type as string,
    topics: (d.topics ?? []) as string[],
  }));
  return Response.json({ books });
}

export async function POST(request: Request) {
  const { supabase, user } = await requireUser();
  if (!user) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { documentId, topic, count } = parsed.data;

  if (!process.env.GOOGLE_API_KEY || !process.env.GROQ_API_KEY) {
    return Response.json({ error: "model_keys_not_configured" }, { status: 503 });
  }

  // A quiz costs one model call, so it spends one quota unit like a question.
  const { data: remaining, error: quotaError } = await supabase.rpc("consume_quota");
  if (quotaError) {
    return Response.json({ error: "quota_check_failed" }, { status: 500 });
  }
  if (remaining === -1) {
    return Response.json({ error: "quota_exhausted" }, { status: 429 });
  }

  let query = supabase
    .from("chunks")
    .select("content, metadata")
    .eq("document_id", documentId)
    .limit(24);
  if (topic) {
    query = query.eq("metadata->>topic", topic);
  }
  const { data: chunks, error } = await query;
  if (error) {
    return Response.json({ error: "retrieval_failed" }, { status: 502 });
  }
  if (!chunks || chunks.length === 0) {
    return Response.json(
      {
        error: "no_material",
        message: "No course material is loaded for that selection yet.",
      },
      { status: 404 },
    );
  }

  // Small, shuffled sample with tight character caps: quiz latency is
  // dominated by prompt size, and 8 focused excerpts out-drill 30 loose ones.
  const sample = [...chunks]
    .sort(() => Math.random() - 0.5)
    .slice(0, 8)
    .map((c, i) => `--- Material ${i + 1} ---\n${(c.content as string).slice(0, 900)}`)
    .join("\n\n");

  const prompt = `Create ${count} drill items from this material.\n\n${sample}`;
  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });

  // Groq first: sub-second token rates make it the fast path, and its daily
  // budget is healthier than gemini-3.6-flash's 20 requests/day. Gemini only
  // catches the failure case.
  try {
    const { object } = await generateObject({
      model: groq(process.env.CHAT_MODEL ?? "llama-3.3-70b-versatile"),
      schema: QuizSchema,
      system: SYSTEM,
      prompt,
    });
    return Response.json(object);
  } catch {
    const { object } = await generateObject({
      model: google(process.env.FALLBACK_MODEL ?? "gemini-3.6-flash"),
      schema: QuizSchema,
      system: SYSTEM,
      prompt,
    });
    return Response.json(object);
  }
}
