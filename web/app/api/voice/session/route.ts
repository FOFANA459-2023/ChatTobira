import { z } from "zod";

import { isAdminEmail } from "@/lib/admin";
import {
  exhaustedMessage,
  spendAllowance,
  VOICE_HANDOVER_MS,
  VOICE_SLICE_SECONDS,
} from "@/lib/allowance";
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

/** How long the browser has to open the socket with this token. */
const OPEN_WITHIN_MS = 30_000;
/** How long a token's conversation may run. One charged minute, plus the few
 * seconds a connection takes to open and to hand over to the next token —
 * the client moves on before this, and Google ends the call at it whatever
 * the client does (measured: "closed 1011 auth token has expired"). */
const SLICE_MS = VOICE_SLICE_SECONDS * 1000 + VOICE_HANDOVER_MS;

/** A single-use token for one live spoken conversation.
 *
 * The Google key never leaves the server. The token it mints can open ONE
 * connection, within a minute, to the model, voice, tools and system prompt
 * set here — the client's own setup message can change none of them. So a
 * student with the browser console open can hold a conversation and nothing
 * else: not a different model, not a different prompt, not a second socket.
 *
 * Each token is ONE MINUTE of the student's ten per five-hour window, charged
 * when it is minted. The browser asks for the next one a few seconds before
 * this one runs out and moves the conversation onto it; when the allowance
 * is spent, there is no next token and the call ends with the minute it is
 * in. The server never has to trust the browser about how long it talked.
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

  const [spent, { data: profile }] = await Promise.all([
    spendAllowance(supabase, "voice", VOICE_SLICE_SECONDS),
    supabase.from("profiles").select("level").eq("id", user.id).maybeSingle(),
  ]);
  if (!spent.ok) {
    return spent.exhausted
      ? Response.json(
          {
            error: "quota_exhausted",
            resetsAt: spent.resetsAt,
            message: exhaustedMessage("voice", spent.resetsAt),
          },
          { status: 429 },
        )
      : Response.json({ error: "quota_check_failed" }, { status: 500 });
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
      expireTime: new Date(now + SLICE_MS).toISOString(),
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
    {
      token: token.name,
      model,
      // When this minute's call ends, and how many seconds are left after it
      // — so the browser knows when to move on and what to show.
      expiresAt: now + SLICE_MS,
      remainingSeconds: spent.remaining,
      resetsAt: spent.resetsAt,
    },
    // A token is a credential. Nothing between here and the browser keeps it.
    { headers: { "Cache-Control": "no-store" } },
  );
}
