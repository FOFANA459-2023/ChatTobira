import { createClient } from "@/lib/supabase/server";

export const maxDuration = 30;

/** Speech-to-text via Groq Whisper (free tier: 2,000 requests/day).
 * Students speak a question in Japanese or English; the text lands in the
 * chat input for review before sending — transcription errors in a language
 * you are still learning should be visible, not silently submitted. */
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

  const form = await request.formData();
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return Response.json({ error: "no_audio" }, { status: 400 });
  }
  if (audio.size > 10 * 1024 * 1024) {
    return Response.json({ error: "audio_too_large" }, { status: 413 });
  }

  const upstream = new FormData();
  upstream.append("file", audio, "question.webm");
  upstream.append("model", process.env.STT_MODEL ?? "whisper-large-v3-turbo");
  // No language pin: students ask in Japanese or English and Whisper detects.

  const response = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: upstream,
    },
  );

  if (!response.ok) {
    return Response.json({ error: "transcription_failed" }, { status: 502 });
  }

  const { text } = (await response.json()) as { text: string };
  return Response.json({ text: text.trim() });
}
