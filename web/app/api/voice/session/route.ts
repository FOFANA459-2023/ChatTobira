import { z } from "zod";

import { isAdminEmail } from "@/lib/admin";
import { LIVE_MODEL, LIVE_SILENCE_MS, LIVE_VOICE, liveSetup } from "@/lib/live-voice";
import { greetingName } from "@/lib/name";
import { createClient } from "@/lib/supabase/server";
import type { CourseLevel } from "@/lib/uploads";

export const maxDuration = 15;

const BodySchema = z.object({
  language: z.enum(["ja", "en"]).default("ja"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) }))
    .max(40)
    .default([]),
  /** Carry a session the server closed onto a new connection. */
  resume: z.string().max(2000).optional(),
});

/** How long the browser has to open the socket with this token, and how long
 * the conversation it opens may run before a fresh token is needed. The
 * server closes a live connection every ten minutes or so anyway; resumption
 * asks for a new token then, which is what re-checks the quota. */
const OPEN_WITHIN_MS = 60_000;
const SESSION_MS = 30 * 60_000;

/** A single-use token for one live spoken conversation.
 *
 * The Google key never leaves the server. The token it mints can open ONE
 * connection, within a minute, to the model, voice, tools and system prompt
 * set here — the client's own setup message can change none of them. So a
 * student with the browser console open can hold a conversation and nothing
 * else: not a different model, not a different prompt, not a second socket.
 *
 * Each token costs one unit of the student's daily quota, the same as a typed
 * question. A conversation takes a new token when the server rotates its
 * connection, every ten minutes or so, which keeps the daily cap meaningful
 * for a feature that is otherwise billed by the minute.
 */
export async function POST(request: Request) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    return Response.json({ error: "voice_not_configured" }, { status: 503 });
  }

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
  const { language, history, resume } = parsed.data;

  const [{ data: remaining, error: quotaError }, { data: profile }] = await Promise.all([
    supabase.rpc("consume_quota"),
    supabase.from("profiles").select("level").eq("id", user.id).maybeSingle(),
  ]);
  if (quotaError) {
    return Response.json({ error: "quota_check_failed" }, { status: 500 });
  }
  if (remaining === -1) {
    return Response.json({ error: "quota_exhausted" }, { status: 429 });
  }

  const model = process.env.LIVE_MODEL ?? LIVE_MODEL;
  const setup = liveSetup({
    model,
    voice: process.env.LIVE_VOICE ?? process.env.TTS_VOICE ?? LIVE_VOICE,
    silenceMs: Number(process.env.LIVE_SILENCE_MS ?? LIVE_SILENCE_MS),
    level: ((profile as { level?: string } | null)?.level ?? null) as CourseLevel | null,
    language,
    name: isAdminEmail(user.email)
      ? null
      : greetingName(user.user_metadata as Record<string, unknown> | undefined),
    history,
    resumeHandle: resume,
  });

  const now = Date.now();
  const response = await fetch("https://generativelanguage.googleapis.com/v1alpha/auth_tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + SESSION_MS).toISOString(),
      newSessionExpireTime: new Date(now + OPEN_WITHIN_MS).toISOString(),
      bidiGenerateContentSetup: setup,
    }),
  }).catch(() => null);

  if (!response?.ok) {
    const detail = response ? await response.text().catch(() => "") : "unreachable";
    console.error(`live token failed: ${response?.status ?? "-"} ${detail.slice(0, 300)}`);
    return Response.json({ error: "token_failed" }, { status: 502 });
  }
  const token = (await response.json()) as { name?: string };
  if (!token.name) {
    return Response.json({ error: "token_failed" }, { status: 502 });
  }

  return Response.json(
    { token: token.name, model },
    // A token is a credential. Nothing between here and the browser keeps it.
    { headers: { "Cache-Control": "no-store" } },
  );
}
