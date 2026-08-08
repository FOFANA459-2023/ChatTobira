import { createGroq } from "@ai-sdk/groq";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { z } from "zod";

import { contextBlock, systemPrompt } from "@/lib/prompt";
import {
  buildCitations,
  embedQuery,
  retrieve,
  tokensForQuery,
  type Citation,
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
  if (!user) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
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

  // Persist under RLS as the signed-in student. Failures here must never
  // block an answer — history is valuable, the answer is the product.
  if (!conversationId) {
    const { data: conversation } = await supabase
      .from("conversations")
      .insert({ user_id: user.id, scope, title: question.slice(0, 60) })
      .select("id")
      .single();
    conversationId = (conversation as { id: number } | null)?.id;
  }
  if (conversationId) {
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
  // so parallel requests cannot double-spend.
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

  if (!process.env.GOOGLE_API_KEY || !process.env.GROQ_API_KEY) {
    // Misconfiguration must be nameable from the outside, not a bare 500.
    return Response.json({ error: "model_keys_not_configured" }, { status: 503 });
  }

  let embedding: number[];
  try {
    embedding = await embedQuery(question);
  } catch {
    return Response.json({ error: "embedding_failed" }, { status: 502 });
  }
  const vectorLiteral = `[${embedding.join(",")}]`;

  // Semantic cache: 100 students ask the same ~30 grammar questions, and a hit
  // here costs no Groq/Gemini quota at all.
  const { data: cached } = await supabase.rpc("cache_get", {
    query_embedding: vectorLiteral,
    query_scope: scope,
  });
  if (cached && cached.length > 0) {
    const hit = cached[0] as { answer: string; citations: Citation[] };
    await persistAssistant(hit.answer, hit.citations, "cache");
    return cachedAnswerResponse(hit.answer, hit.citations, conversationId);
  }

  let chunks;
  try {
    chunks = await retrieve(supabase, embedding, tokensForQuery(question), scope);
  } catch {
    return Response.json({ error: "retrieval_failed" }, { status: 502 });
  }
  const citations = buildCitations(chunks);

  const system = `${systemPrompt(scope as StudyScope)}\n\n=== SOURCE MATERIAL ===\n${contextBlock(chunks)}`;
  const modelMessages = await convertToModelMessages(messages);

  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });

  // Groq free tier is 30 requests/minute and 1,000/day; when it declines, fall
  // back to Gemini rather than surfacing an error to the student.
  let modelUsed = process.env.CHAT_MODEL ?? "llama-3.3-70b-versatile";
  let result = streamText({
    model: groq(modelUsed),
    system,
    messages: modelMessages,
    temperature: 0.3,
  });

  try {
    // Resolves once the provider accepts the request; rejects on 429/5xx
    // before any tokens stream, which is exactly the fallback window.
    await result.warnings;
  } catch {
    modelUsed = process.env.FALLBACK_MODEL ?? "gemini-3.6-flash";
    result = streamText({
      model: google(modelUsed),
      system,
      messages: modelMessages,
      temperature: 0.3,
    });
  }

  return result.toUIMessageStreamResponse({
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
      try {
        await supabase.rpc("cache_put", {
          q_question: question,
          q_embedding: vectorLiteral,
          q_answer: answer,
          q_citations: citations,
          q_scope: scope,
        });
      } catch {
        /* cache is best-effort */
      }
    },
  });
}

/** Serve a cache hit in the same UI-message-stream shape as a live answer. */
function cachedAnswerResponse(
  answer: string,
  citations: Citation[],
  conversationId?: number,
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
    },
  });
}
