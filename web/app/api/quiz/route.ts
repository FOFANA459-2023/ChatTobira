import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateObject } from "ai";
import { z } from "zod";

import { QuizSchema } from "@/lib/quiz";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

const BodySchema = z.object({
  scope: z
    .object({
      level: z.enum(["F2", "F3", "INT"]).optional(),
      topic: z.string().regex(/^T\d{1,2}$/).optional(),
    })
    .default({}),
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
  const { scope, count } = parsed.data;

  // A quiz costs one model call, so it spends one quota unit like a question.
  const { data: remaining, error: quotaError } = await supabase.rpc("consume_quota");
  if (quotaError) {
    return Response.json({ error: "quota_check_failed" }, { status: 500 });
  }
  if (remaining === -1) {
    return Response.json({ error: "quota_exhausted" }, { status: 429 });
  }

  // Pull drill source material straight by metadata — no embedding needed for
  // a topic-shaped request. Answer keys are prime quiz material.
  let query = supabase
    .from("chunks")
    .select("content, metadata")
    .limit(30);
  if (scope.topic) {
    query = query.eq("metadata->>topic", scope.topic);
  } else if (scope.level) {
    query = query.eq("metadata->>level", scope.level);
  }
  const { data: chunks, error } = await query;
  if (error) {
    return Response.json({ error: "retrieval_failed" }, { status: 500 });
  }
  if (!chunks || chunks.length === 0) {
    return Response.json(
      {
        error: "no_material",
        message: "No course material is loaded for that scope yet.",
      },
      { status: 404 },
    );
  }

  // Shuffle so repeat quizzes on the same topic vary their source pages.
  const sample = [...chunks]
    .sort(() => Math.random() - 0.5)
    .slice(0, 10)
    .map((c, i) => `--- Material ${i + 1} ---\n${c.content}`)
    .join("\n\n");

  const prompt = `Create ${count} drill items from this material.\n\n${sample}`;
  const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });
  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });

  try {
    const { object } = await generateObject({
      model: google(process.env.FALLBACK_MODEL ?? "gemini-3.6-flash"),
      schema: QuizSchema,
      system: SYSTEM,
      prompt,
    });
    return Response.json(object);
  } catch {
    // Gemini quota or transport failure: same request through Groq.
    const { object } = await generateObject({
      model: groq(process.env.CHAT_MODEL ?? "llama-3.3-70b-versatile"),
      schema: QuizSchema,
      system: SYSTEM,
      prompt,
    });
    return Response.json(object);
  }
}
