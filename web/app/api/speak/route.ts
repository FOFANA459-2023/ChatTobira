import { z } from "zod";

import { speakableText, SPEAKABLE_LIMIT } from "@/lib/speech";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 30;

/** Text-to-speech for the spoken half of the conversation.
 *
 * Groq serves this project's speech-to-text and no TTS at all — asked for its
 * model list, the key returns two Whisper builds and nothing else — so the
 * voice comes from Gemini, on the Google key that already does vision and
 * embeddings. No new provider, no new secret.
 *
 * The browser's own speechSynthesis is the fallback rather than the default,
 * and the client falls back to it on any failure here. It costs nothing and
 * needs no key, but its Japanese depends entirely on which voices the
 * student's operating system happens to ship; a language app should not teach
 * pronunciation it cannot vouch for when a better voice is one call away.
 */

const BodySchema = z.object({
  text: z.string().min(1).max(4000),
  /** Which prebuilt Gemini voice. Named here rather than hardcoded so a
   * different one can be tried without a deploy. */
  voice: z.string().max(40).optional(),
});

/** Gemini returns raw signed 16-bit little-endian PCM at 24 kHz, which no
 * browser will play from an <audio> element or decode as a blob URL. Wrapping
 * it in a 44-byte RIFF header makes it a WAV file, which every browser plays.
 * Cheaper and far less fragile than re-encoding to MP3 in a Worker. */
function wavFromPcm(pcm: Uint8Array, sampleRate = 24000, channels = 1): Uint8Array {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true); // file length minus the first 8 bytes
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);

  const wav = new Uint8Array(44 + pcm.length);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm, 44);
  return wav;
}

/** The sample rate Gemini actually returned, from its own mime type
 * ("audio/L16;codec=pcm;rate=24000"). Read rather than assumed: a header that
 * disagrees with the data plays at the wrong pitch, which on a language app
 * would be teaching the wrong thing in the most literal way. */
function rateFrom(mimeType: string | undefined): number {
  const match = /rate=(\d+)/.exec(mimeType ?? "");
  return match ? Number(match[1]) : 24000;
}

interface TtsResponse {
  candidates?: {
    content?: {
      parts?: { inlineData?: { data?: string; mimeType?: string } }[];
    };
  }[];
  error?: { message?: string };
}

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

  if (!process.env.GOOGLE_API_KEY) {
    // Nameable rather than a bare 500: the client falls back to the browser
    // voice on any failure, and this one is a deployment problem.
    return Response.json({ error: "tts_not_configured" }, { status: 503 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  // Cleaned here as well as on the client. The client strips it to decide
  // what to speak; this is the boundary that decides what is PAID for, and a
  // caller sending 4,000 characters of Markdown should not bill four thousand
  // characters of audio.
  const text = speakableText(parsed.data.text, SPEAKABLE_LIMIT);
  if (!text) {
    return Response.json({ error: "nothing_to_say" }, { status: 400 });
  }

  const model = process.env.TTS_MODEL ?? "gemini-2.5-flash-preview-tts";
  // Kore reads Japanese clearly and unhurriedly. The voice is a env-level
  // choice because "which voice teaches best" is a judgement for the teacher,
  // not a constant for the code.
  const voice = parsed.data.voice ?? process.env.TTS_VOICE ?? "Kore";

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GOOGLE_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        }),
      },
    );
  } catch {
    // The network, not the service. Same verdict for the caller either way.
    return Response.json({ error: "tts_unreachable" }, { status: 502 });
  }

  if (!response.ok) {
    // 429 is the one worth naming: the Google key also carries vision and
    // embeddings, so a busy ingestion run can starve the voice. The client
    // reads the status and falls back to the browser rather than going silent.
    console.error(`tts ${model} failed: ${response.status} ${await response.text()}`);
    return Response.json(
      { error: response.status === 429 ? "tts_quota" : "tts_failed" },
      { status: 502 },
    );
  }

  const json = (await response.json()) as TtsResponse;
  const inline = json.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData;
  if (!inline?.data) {
    return Response.json({ error: "tts_no_audio" }, { status: 502 });
  }

  const pcm = Uint8Array.from(atob(inline.data), (char) => char.charCodeAt(0));
  const wav = wavFromPcm(pcm, rateFrom(inline.mimeType));

  return new Response(wav as BodyInit, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(wav.length),
      // The same answer is spoken once. Caching it would serve a student's
      // own reply back to them and nobody else.
      "Cache-Control": "no-store",
    },
  });
}
