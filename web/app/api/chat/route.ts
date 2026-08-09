import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGroq } from "@ai-sdk/groq";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createClient as createSupabase, type SupabaseClient } from "@supabase/supabase-js";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { z } from "zod";

import { contextBlock, systemPrompt } from "@/lib/prompt";
import { isProviderDead, noteProviderFailure } from "@/lib/providers";
import {
  buildCitations,
  embedQuery,
  isSmallTalk,
  retrieve,
  tokensForQuery,
  type Citation,
  type RetrievedChunk,
  type StudyScope,
} from "@/lib/retrieval";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

const BodySchema = z.object({
  messages: z.array(z.custom<UIMessage>()),
  scope: z
    .object({
      level: z.enum(["F2", "F3", "INT"]).optional(),
      topic: z.string().regex(/^T\d{1,2}$/).optional(),
    })
    .default({}),
  conversationId: z.number().int().positive().optional(),
});

/** Anonymous trial: a visitor may ask this many questions before they must
 * sign in. Counted in a cookie — a determined visitor can clear it, but this
 * is a taster, not a security boundary; the real gate stays the invite. */
const TRIAL_LIMIT = 3;
const TRIAL_COOKIE = "tobira_trial";

function trialUsed(request: Request): number {
  const match = request.headers
    .get("cookie")
    ?.match(new RegExp(`(?:^|;\\s*)${TRIAL_COOKIE}=(\\d+)`));
  return match ? Number(match[1]) : 0;
}

function trialCookie(used: number): string {
  return `${TRIAL_COOKIE}=${used}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}

/** Retrieval/cache tables are readable by signed-in students only, so the
 * trial reads them through the service role — server-side, read/cache use
 * only, and only after the trial counter allowed the request. */
function trialRetrievalClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createSupabase(url, key, { auth: { persistSession: false } });
}

function lastUserText(messages: UIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return last.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export async function POST(request: Request) {
  const supabase = await createClient();
  let user = null;
  try {
    ({
      data: { user },
    } = await supabase.auth.getUser());
  } catch {
    // Auth backend unreachable is indistinguishable from signed out for the
    // caller, and must never surface as a 500.
  }
  // Anonymous visitors get a short trial; past it, the client shows sign-in.
  let setCookie: string | null = null;
  if (!user) {
    const used = trialUsed(request);
    if (used >= TRIAL_LIMIT) {
      return Response.json({ error: "trial_exhausted" }, { status: 401 });
    }
    setCookie = trialCookie(used + 1);
  }

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { messages, scope } = parsed.data;
  let { conversationId } = parsed.data;

  const question = lastUserText(messages);
  if (!question) {
    return Response.json({ error: "empty_question" }, { status: 400 });
  }

  // Persist under RLS as the signed-in student; trial visitors have no row
  // to write to and no history. Failures here must never block an answer —
  // history is valuable, the answer is the product.
  if (user && !conversationId) {
    const { data: conversation } = await supabase
      .from("conversations")
      .insert({ user_id: user.id, scope, title: question.slice(0, 60) })
      .select("id")
      .single();
    conversationId = (conversation as { id: number } | null)?.id;
  }
  if (user && conversationId) {
    await supabase
      .from("messages")
      .insert({ conversation_id: conversationId, role: "user", content: question });
  }

  async function persistAssistant(
    answer: string,
    citations: Citation[],
    model: string,
  ): Promise<number | undefined> {
    if (!conversationId || !answer) return undefined;
    const { data } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        role: "assistant",
        content: answer,
        citations,
        model,
      })
      .select("id")
      .single();
    return (data as { id: number } | null)?.id;
  }

  // Quota first: an exhausted student costs zero model calls. Atomic in SQL,
  // so parallel requests cannot double-spend. Trial visitors are metered by
  // the cookie above instead.
  if (user) {
    const { data: remaining, error: quotaError } = await supabase.rpc("consume_quota");
    if (quotaError) {
      return Response.json({ error: "quota_check_failed" }, { status: 500 });
    }
    if (remaining === -1) {
      return Response.json(
        {
          error: "quota_exhausted",
          message:
            "You have reached today's question limit. The limit resets at midnight (Japan time).",
        },
        { status: 429 },
      );
    }
  }

  if (!process.env.GOOGLE_API_KEY || !process.env.GROQ_API_KEY) {
    // Misconfiguration must be nameable from the outside, not a bare 500.
    return Response.json({ error: "model_keys_not_configured" }, { status: 503 });
  }

  // Small talk skips the whole retrieval stack — no embedding round-trip, no
  // cache probe, no vector search. Faster first token, and no absurd
  // textbook citation under "hello".
  const trivial = isSmallTalk(question);

  // Signed-in students read under their own RLS; trial visitors read through
  // the service client. A trial without the service key still answers, just
  // ungrounded — a degraded taster beats an error page.
  const db = user ? supabase : trialRetrievalClient();

  let vectorLiteral: string | null = null;
  let chunks: RetrievedChunk[] = [];

  if (!trivial && db) {
    let embedding: number[];
    try {
      embedding = await embedQuery(question);
    } catch {
      return Response.json({ error: "embedding_failed" }, { status: 502 });
    }
    vectorLiteral = `[${embedding.join(",")}]`;

    // Semantic cache: 100 students ask the same ~30 grammar questions, and a
    // hit here costs no Groq/Gemini quota at all.
    const { data: cached } = await db.rpc("cache_get", {
      query_embedding: vectorLiteral,
      query_scope: scope,
    });
    if (cached && cached.length > 0) {
      const hit = cached[0] as { answer: string; citations: Citation[] };
      await persistAssistant(hit.answer, hit.citations, "cache");
      return cachedAnswerResponse(hit.answer, hit.citations, conversationId, setCookie);
    }

    try {
      chunks = await retrieve(db, embedding, tokensForQuery(question), scope, 8);
    } catch {
      return Response.json({ error: "retrieval_failed" }, { status: 502 });
    }
  }

  const citations = buildCitations(chunks);

  const system = `${systemPrompt(scope as StudyScope)}\n\n=== SOURCE MATERIAL ===\n${contextBlock(chunks)}`;
  const modelMessages = await convertToModelMessages(messages);

  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });

  // Provider cascade, cheapest-and-freest first. Groq's free tier (30/min,
  // 1,000/day) is spent before anything is billed. DeepSeek then absorbs the
  // overflow: it has no daily request cap at all, only a concurrency limit, so
  // it is what actually removes the daily wall. Gemini stays last — rarely
  // reached now, which leaves the Google key for vision and embeddings, the
  // two jobs no other provider in this stack can do.
  const tiers: {
    provider: string;
    label: string;
    start: () => ReturnType<typeof streamText>;
  }[] = [];
  const chatOptions = { system, messages: modelMessages, temperature: 0.3 };

  const groqModel = process.env.CHAT_MODEL ?? "llama-3.3-70b-versatile";
  tiers.push({
    provider: "groq",
    label: groqModel,
    start: () => streamText({ model: groq(groqModel), ...chatOptions }),
  });

  // Skipped once it has answered 402 (unfunded balance) or 401 (bad key):
  // that verdict holds until the account is topped up, and re-asking every
  // request would just add a round-trip in front of Gemini.
  if (process.env.DEEPSEEK_API_KEY && !isProviderDead("deepseek")) {
    const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });
    const deepseekModel = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
    tiers.push({
      provider: "deepseek",
      label: deepseekModel,
      start: () => streamText({ model: deepseek(deepseekModel), ...chatOptions }),
    });
  }

  const geminiModel = process.env.FALLBACK_MODEL ?? "gemini-3.6-flash";
  tiers.push({
    provider: "google",
    label: geminiModel,
    start: () => streamText({ model: google(geminiModel), ...chatOptions }),
  });

  let result: ReturnType<typeof streamText> | undefined;
  let modelUsed = "";
  for (const tier of tiers) {
    const attempt = tier.start();
    try {
      // Resolves once the provider accepts the request; rejects on 429/5xx
      // before any tokens stream, which is exactly the fallback window.
      await attempt.warnings;
      result = attempt;
      modelUsed = tier.label;
      break;
    } catch (error) {
      // Rate limit or outage: try the next tier, retry this one next request.
      // Unfunded or revoked: stop offering it until the isolate recycles.
      noteProviderFailure(tier.provider, error);
    }
  }

  if (!result) {
    return Response.json({ error: "all_models_unavailable" }, { status: 502 });
  }

  return result.toUIMessageStreamResponse({
    headers: setCookie ? { "Set-Cookie": setCookie } : undefined,
    messageMetadata: ({ part }) => {
      if (part.type === "finish") {
        return { citations, model: modelUsed, conversationId };
      }
    },
    onFinish: async ({ responseMessage }) => {
      const answer = responseMessage.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (!answer) return;
      await persistAssistant(answer, citations, modelUsed);
      // Cache fire-and-forget: a failed write must not break the reply.
      // Small talk is never cached — it has no embedding and no reuse value.
      if (vectorLiteral && db) {
        try {
          await db.rpc("cache_put", {
            q_question: question,
            q_embedding: vectorLiteral,
            q_answer: answer,
            q_citations: citations,
            q_scope: scope,
          });
        } catch {
          /* cache is best-effort */
        }
      }
    },
  });
}

/** Serve a cache hit in the same UI-message-stream shape as a live answer. */
function cachedAnswerResponse(
  answer: string,
  citations: Citation[],
  conversationId?: number,
  setCookie?: string | null,
): Response {
  const encoder = new TextEncoder();
  const id = crypto.randomUUID();
  const events = [
    { type: "start" },
    { type: "text-start", id },
    { type: "text-delta", id, delta: answer },
    { type: "text-end", id },
    {
      type: "message-metadata",
      messageMetadata: { citations, model: "cache", conversationId },
    },
    { type: "finish" },
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "x-vercel-ai-ui-message-stream": "v1",
      ...(setCookie ? { "Set-Cookie": setCookie } : {}),
    },
  });
}
