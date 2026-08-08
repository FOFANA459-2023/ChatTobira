"use client";

import { useRef, useState } from "react";

type MicState = "idle" | "recording" | "transcribing" | "error";

/** Push-to-talk: record, send to /api/transcribe, hand the text back to the
 * composer. The student reviews the transcription before sending — errors in
 * a language you are still learning should be visible, not auto-submitted. */
export function MicButton({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<MicState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        for (const track of stream.getTracks()) track.stop();
        setState("transcribing");
        try {
          const audio = new Blob(chunksRef.current, { type: "audio/webm" });
          const body = new FormData();
          body.append("audio", audio);
          const response = await fetch("/api/transcribe", { method: "POST", body });
          if (!response.ok) throw new Error(String(response.status));
          const { text } = (await response.json()) as { text: string };
          if (text) onTranscript(text);
          setState("idle");
        } catch {
          setState("error");
          setTimeout(() => setState("idle"), 2500);
        }
      };

      recorderRef.current = recorder;
      recorder.start();
      setState("recording");
    } catch {
      // Microphone permission denied or unavailable.
      setState("error");
      setTimeout(() => setState("idle"), 2500);
    }
  }

  function stop() {
    recorderRef.current?.stop();
  }

  const label =
    state === "recording"
      ? "Stop recording"
      : state === "transcribing"
        ? "Transcribing"
        : "Record a spoken question";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || state === "transcribing"}
      onClick={state === "recording" ? stop : start}
      className={
        state === "recording"
          ? "rounded-xl bg-red-600 px-3 py-2.5 text-sm font-medium text-white"
          : "rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm hover:bg-stone-100 disabled:opacity-50"
      }
    >
      {state === "recording" ? "■" : state === "transcribing" ? "…" : "🎤"}
    </button>
  );
}
