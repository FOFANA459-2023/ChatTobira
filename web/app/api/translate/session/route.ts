import { z } from "zod";

import {
  exhaustedMessage,
  refundAllowance,
  spendAllowance,
  VOICE_HANDOVER_MS,
  VOICE_SLICE_SECONDS,
} from "@/lib/allowance";
import {
  isLanguage,
  TRANSLATE_MODEL,
  TRANSLATE_SILENCE_MS,
  translateSetup,
  type LanguageCode,
  type SourceLanguage,
} from "@/lib/translate";
import { cleanSubject } from "@/lib/speech";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

export const maxDuration = 15;

const BodySchema = z.object({
  /** "auto" leaves the language to the model, which is what a student who
   * cannot yet name it needs. */
  source: z.string().max(10).default("auto"),
  target: z.string().max(10).default("en"),
  /** What the class is about. Terminology guidance only, and cleaned rather
   * than trusted: it is the one part of the instruction a student writes. */
  subject: z.string().max(400).optional(),
  /** Carry a session the server closed onto a new connection, so a lecture
   * survives a renewal without losing what it has heard. */
  resume: z.string().max(2000).optional(),
});

/** How long the browser has to open the socket with this token. */
const OPEN_WITHIN_MS = 30_000;
/** How long one token's session may run: a charged minute plus the handover,
 * the same arithmetic the spoken conversation uses. */
const SLICE_MS = VOICE_SLICE_SECONDS * 1000 + VOICE_HANDOVER_MS;

/** A single-use token for one minute of live translation.
 *
 * Deliberately the same shape as /api/voice/session, and for the same reason:
 * the Google key never leaves the server, and the token it mints can open ONE
 * connection, within thirty seconds, to the model and system instruction set
 * here. A student with the browser console open gets an interpreter and
 * nothing else — not a general-purpose model, not a different prompt, not a
 * second socket.
 *
 * What differs is the counter. A minute here comes out of `translate`, which
 * is a separate allowance from `voice` (0018): a lecture and a conversation
 * are different lengths of thing and neither should be able to spend the
 * other. The browser asks for the next token a few seconds before this one
 * expires; when the allowance is gone there is no next token and the session
 * ends with the minute it is in, so the server never has to trust the browser
 * about how long it listened.
 */
export async function POST(request: Request) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    return Response.json({ error: "translate_not_configured" }, { status: 503 });
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

  // Validated against the list rather than trusted: these go into the
  // instruction, and an unknown code would otherwise become a request to
  // translate into whatever string the client sent.
  const target: LanguageCode = isLanguage(parsed.data.target) ? parsed.data.target : "en";
  const source: SourceLanguage =
    parsed.data.source === "auto"
      ? "auto"
      : isLanguage(parsed.data.source)
        ? parsed.data.source
        : "auto";
  if (source !== "auto" && source === target) {
    return Response.json({ error: "same_language" }, { status: 400 });
  }
  const subject = parsed.data.subject ? cleanSubject(parsed.data.subject) : undefined;

  const spent = await spendAllowance(supabase, "translate", VOICE_SLICE_SECONDS);
  if (!spent.ok) {
    if (spent.exhausted) {
      return Response.json(
        {
          error: "quota_exhausted",
          resetsAt: spent.resetsAt,
          message: exhaustedMessage("translate", spent.resetsAt),
        },
        { status: 429 },
      );
    }
    // The allowance has no ceiling, which means 0018 has not been applied to
    // this database. Said plainly rather than dressed up as a spent quota:
    // "you have used your fifty minutes" on an account that has used none
    // sends whoever reads it looking in entirely the wrong place.
    if (spent.unconfigured) {
      console.error(
        "translate allowance missing: allowance_limit('translate') is NULL — apply 0018_live_translation.sql",
      );
      return Response.json(
        {
          error: "translate_not_configured",
          message:
            "Live translation is not switched on for this server yet. Nothing has been used from your allowance.",
        },
        { status: 503 },
      );
    }
    return Response.json({ error: "quota_check_failed" }, { status: 500 });
  }

  const model = process.env.TRANSLATE_MODEL ?? TRANSLATE_MODEL;
  const setup = translateSetup({
    model,
    source,
    target,
    subject,
    silenceMs: Number(process.env.TRANSLATE_SILENCE_MS ?? TRANSLATE_SILENCE_MS),
    resumeHandle: parsed.data.resume,
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

  // The minute was charged before Google was asked, so if no token comes back
  // nothing was bought: give it back. A browser retrying a failed renewal
  // through a bad network must not spend a lecture's allowance on calls that
  // never opened.
  const tokenFailed = async () => {
    const service = serviceClient();
    if (service) await refundAllowance(service, user.id, "translate", VOICE_SLICE_SECONDS);
    return Response.json({ error: "token_failed" }, { status: 502 });
  };
  if (!response?.ok) {
    const detail = response ? await response.text().catch(() => "") : "unreachable";
    console.error(`translate token failed: ${response?.status ?? "-"} ${detail.slice(0, 300)}`);
    return tokenFailed();
  }
  const token = (await response.json().catch(() => ({}))) as { name?: string };
  if (!token.name) {
    return tokenFailed();
  }

  return Response.json(
    {
      token: token.name,
      model,
      expiresAt: now + SLICE_MS,
      remainingSeconds: spent.remaining,
      resetsAt: spent.resetsAt,
    },
    // A token is a credential. Nothing between here and the browser keeps it.
    { headers: { "Cache-Control": "no-store" } },
  );
}
