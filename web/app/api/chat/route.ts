import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGroq } from "@ai-sdk/groq";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { z } from "zod";

import { detectLanguageMode, withoutLanguageRequest } from "@/lib/language";
import { aspectOf } from "@/lib/topics";
import { contextBlock, recentTurns, systemPrompt, type AttachedUpload } from "@/lib/prompt";
import { isProviderDead, noteProviderFailure } from "@/lib/providers";
import { serviceClient } from "@/lib/supabase/service";
import { trialCookie, trialUsed, TRIALS } from "@/lib/trial";
import {
  broadenQuery,
  buildCitations,
  embedQuery,
  grammarPatterns,
  isSmallTalk,
  isThinResult,
  resolveQuery,
  retrieve,
  retrieveByTopic,
  retrieveExact,
  selectContext,
  tokensForQuery,
  type Citation,
  type RetrievedChunk,
  type StudyScope,
  type Turn,
} from "@/lib/retrieval";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

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
  // Files the student attached to this turn. Their extracted text becomes
  // context; the files themselves never leave Storage.
  uploadIds: z.array(z.number().int().positive()).max(4).optional(),
});

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** The conversation, flattened to what retrieval and the language rule read. */
function turnsOf(messages: UIMessage[]): Turn[] {
  return messages.map((m) => ({ role: m.role, text: textOf(m) }));
}

export async function POST(request: Request) {
  // Fail closed and name the problem, the way middleware does for every
  // non-public route. createClient() throws on construction without
  // credentials, and that throw is outside any try here.
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }

  // The body is parsed before anything reaches the network, because the
  // question inside it is what the embedding call needs and that call is the
  // longest single hop in the route. Firing it here rather than after
  // authentication lets the two overlap instead of queueing.
  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { messages, scope, uploadIds } = parsed.data;
  let { conversationId } = parsed.data;

  // Retrieval used to search on the last message alone, so "what about the
  // past tense?" searched the textbooks for those five words. The model was
  // given the whole conversation and the corpus was searched for a fragment
  // of it, which is how a student ends up asking the same thing three times.
  const turns = turnsOf(messages);
  const language = detectLanguageMode(turns);
  const query = resolveQuery(
    turns.map((t) =>
      t.role === "user" ? { ...t, text: withoutLanguageRequest(t.text) } : t,
    ),
  );
  const question = query.asked;
  if (!question) {
    return Response.json({ error: "empty_question" }, { status: 400 });
  }

  if (!process.env.GOOGLE_API_KEY || !process.env.GROQ_API_KEY) {
    // Misconfiguration must be nameable from the outside, not a bare 500.
    return Response.json({ error: "model_keys_not_configured" }, { status: 503 });
  }

  // Small talk skips the whole retrieval stack — no embedding round-trip, no
  // cache probe, no vector search. Faster first token, and no absurd
  // textbook citation under "hello".
  const trivial = isSmallTalk(question);
  // When the question arrived, so the stored turn keeps its real order even
  // though it is written after the answer has finished streaming.
  const askedAt = new Date().toISOString();

  // In flight while the auth round trip below happens. Nothing about an
  // embedding depends on who is asking; the only cost of starting early is
  // one wasted embed when a trial visitor turns out to be past their limit,
  // paid on the highest-quota model in the stack.
  // Embedded on the RESOLVED query, so a follow-up searches the corpus for
  // what it is actually about rather than for the pronoun it was typed with.
  const embedding = trivial ? Promise.resolve(null) : embedQuery(query.text).catch(() => null);

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
    const used = trialUsed(request, "chat");
    if (used >= TRIALS.chat.limit) {
      return Response.json({ error: "trial_exhausted" }, { status: 401 });
    }
    setCookie = trialCookie("chat", used + 1);
  }

  /** Both message rows for this turn, written once the answer is complete.
   *
   * Neither row is on the path to a first token: nothing the student sees
   * depends on them, and inserting the question before answering it only
   * spent a round trip in front of the model. One statement for the pair
   * costs one round trip instead of two, and the explicit timestamps keep
   * the question ahead of its answer in history. */
  async function persistTurn(
    answer: string,
    citations: Citation[],
    model: string,
  ): Promise<void> {
    if (!conversationId || !answer) return;
    await supabase.from("messages").insert([
      {
        conversation_id: conversationId,
        role: "user",
        content: question,
        created_at: askedAt,
      },
      {
        conversation_id: conversationId,
        role: "assistant",
        content: answer,
        citations,
        model,
        created_at: new Date().toISOString(),
      },
    ]);
  }

  // Signed-in students read under their own RLS; trial visitors read through
  // the service client. A trial without the service key still answers, just
  // ungrounded — a degraded taster beats an error page.
  const db = user ? supabase : serviceClient();

  // Everything the answer is waiting on runs concurrently instead of as a
  // waterfall: at ~100ms per Supabase round trip and 200–400ms for an
  // embedding, this is the cheapest half-second of first-token latency in
  // the route.
  //
  // The conversation row is the one write that cannot wait — its id rides
  // out with the answer's metadata, and the client needs it to keep the next
  // turn in the same conversation.
  const ensureConversation = async (): Promise<number | undefined> => {
    if (!user || conversationId) return conversationId;
    const { data: conversation } = await supabase
      .from("conversations")
      .insert({ user_id: user.id, scope, title: question.slice(0, 60) })
      .select("id")
      .single();
    return (conversation as { id: number } | null)?.id;
  };

  // Files the student attached to this turn. Read under their own RLS, so
  // one student can never attach another's upload by guessing an id.
  const fetchAttached = async (): Promise<AttachedUpload[]> => {
    if (!user || !uploadIds || uploadIds.length === 0) return [];
    const { data: rows } = await supabase
      .from("uploads")
      .select("filename, extracted")
      .in("id", uploadIds)
      .not("extracted", "is", null);
    return ((rows ?? []) as { filename: string; extracted: string }[]).map((r) => ({
      filename: r.filename,
      extracted: r.extracted,
    }));
  };

  // Atomic in SQL, so parallel requests cannot double-spend. An exhausted
  // student still costs zero GENERATION calls — the embedding may have been
  // spent by the time the verdict lands, which trades a cheap, high-quota
  // call in the rare exhausted case for latency in the common one. Trial
  // visitors are metered by the cookie above instead.
  const checkQuota = async (): Promise<Response | null> => {
    if (!user) return null;
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
    return null;
  };

  const [persistedId, quotaVerdict, queryVector, attached] = await Promise.all([
    ensureConversation(),
    checkQuota(),
    embedding,
    fetchAttached(),
  ]);
  conversationId = persistedId ?? conversationId;
  if (quotaVerdict) return quotaVerdict;

  // An answer built from a private file must never enter the shared answer
  // cache: qa_cache is keyed by question embedding and study scope only, so
  // a classmate asking something similar in the same scope would be served
  // the contents of a document they have no right to see. Attachments turn
  // the cache off in both directions for this turn.
  //
  // A resolved follow-up is uncacheable for a second reason: "why?" embeds to
  // roughly the same vector every time anyone types it, so a cache keyed on
  // the question alone would answer this student's "why?" with the answer to
  // a classmate's, from a conversation they never had.
  const cacheable = attached.length === 0 && !query.isFollowUp;

  let vectorLiteral: string | null = null;
  let chunks: RetrievedChunk[] = [];

  if (!trivial && db) {
    if (!queryVector) {
      return Response.json({ error: "embedding_failed" }, { status: 502 });
    }
    vectorLiteral = `[${queryVector.join(",")}]`;

    // Cache probe and vector retrieval both need only the embedding, so they
    // run together: a hit discards the retrieval, a miss — the common case as
    // the corpus grows — has its chunks already in hand instead of paying a
    // second round-trip.
    // What the student named by name is looked up literally, alongside the
    // ranked search: a grammar pattern, and a course division. Two arms rank;
    // these two refuse to lose a page. Both search the WHOLE corpus — a
    // division is a fact about the course, not about whichever document the
    // conversation happened to touch first.
    const patterns = grammarPatterns(query.text);
    const divisions = query.topics;
    const aspect = aspectOf(query.text);

    const [{ data: cached }, retrieval, exact, byTopic] = await Promise.all([
      cacheable
        ? db.rpc("cache_get", {
            query_embedding: vectorLiteral,
            query_scope: scope,
          })
        : Promise.resolve({ data: null }),
      // More candidates than the prompt can hold, because selectContext
      // below drops what is not about the question and keeps one page per
      // passage. Same round trip either way.
      retrieve(db, queryVector, tokensForQuery(query.text), scope, 14).then(
        (rows) => ({ ok: true as const, rows }),
        () => ({ ok: false as const, rows: [] as RetrievedChunk[] }),
      ),
      // Best-effort: the ranked arms are the answer's backbone, and a failure
      // in a supplementary arm should cost a page, not the reply.
      retrieveExact(db, patterns).catch(() => [] as RetrievedChunk[]),
      retrieveByTopic(db, divisions, aspect).catch(() => [] as RetrievedChunk[]),
    ]);

    // Semantic cache: 100 students ask the same ~30 grammar questions, and a
    // hit here costs no Groq/Gemini quota at all.
    if (cached && cached.length > 0) {
      const hit = cached[0] as { answer: string; citations: Citation[] };
      await persistTurn(hit.answer, hit.citations, "cache");
      return cachedAnswerResponse(hit.answer, hit.citations, conversationId, setCookie);
    }

    if (!retrieval.ok) {
      return Response.json({ error: "retrieval_failed" }, { status: 502 });
    }
    // One entry per chunk: a page can be both the closest match and a literal
    // hit, and the literal flag is the one that matters for selection.
    const merge = (...arms: RetrievedChunk[][]) => {
      const byId = new Map<number, RetrievedChunk>();
      for (const chunk of arms.flat()) {
        if (!byId.has(chunk.chunk_id)) byId.set(chunk.chunk_id, chunk);
      }
      return [...byId.values()];
    };
    chunks = merge(byTopic, exact, retrieval.rows);

    // Nothing convincing came back. A ranked search always returns SOMETHING,
    // so this is the moment the app used to mistake a missed search for a gap
    // in the corpus and tell the student to go and open the book themselves.
    // Instead, ask again in the corpus's own words before drawing any
    // conclusion — one embedding, on the minority of turns that need it.
    if (isThinResult(chunks)) {
      const broadened = broadenQuery(query.text, divisions, aspect);
      if (broadened && broadened !== query.text) {
        const retry = await embedQuery(broadened)
          .then((vector) => retrieve(db, vector, tokensForQuery(broadened), scope, 14))
          .catch(() => [] as RetrievedChunk[]);
        chunks = merge(byTopic, exact, retry, retrieval.rows);
      }
    }
  }

  // What the model actually reads: on topic, one page per passage, closest
  // first. Citations come from that same set rather than from every
  // candidate — a page the answer was never built from is not a page the
  // answer can honestly offer to send the student to.
  const context = selectContext(chunks);
  const citations = buildCitations(context);

  const system = `${systemPrompt(scope as StudyScope, {
    language,
    isFollowUp: query.isFollowUp,
    canPointToBook: citations.length > 0,
    hasUploads: attached.length > 0,
  })}\n\n=== SOURCE MATERIAL ===\n${contextBlock(context, attached)}`;
  const modelMessages = await convertToModelMessages(recentTurns(messages));

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

  // Verified against the Groq catalogue: llama-3.3-70b-versatile was retired
  // and every request to it came back 404, which silently demoted the whole
  // cascade to its last-resort tier. gpt-oss-120b is the largest model the
  // free tier serves, and it is the one the quiz route already runs on.
  const groqModel = process.env.CHAT_MODEL ?? "openai/gpt-oss-120b";
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
      // Logged so an all-tiers failure is diagnosable from the worker logs.
      console.error(
        `chat tier ${tier.label} declined:`,
        error instanceof Error ? error.message : error,
      );
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
      await persistTurn(answer, citations, modelUsed);
      // Cache fire-and-forget: a failed write must not break the reply.
      // Small talk is never cached — it has no embedding and no reuse value.
      if (vectorLiteral && db && cacheable) {
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
