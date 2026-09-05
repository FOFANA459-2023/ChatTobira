"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { speakableText, speechSegments } from "./speech";

/* ------------------------------------------------------------------------ */
/* Recording                                                                  */
/* ------------------------------------------------------------------------ */

export type ListenState = "idle" | "listening" | "transcribing" | "error";

/** What went wrong, in words a student can act on. Every one of these is a
 * real state the browser puts us in, not a category invented for tidiness. */
export type VoiceError =
  | "unsupported"
  | "permission"
  | "no_microphone"
  | "recording_failed"
  | "empty"
  | "transcription_failed"
  | "network";

export const VOICE_ERROR_TEXT: Record<VoiceError, string> = {
  unsupported: "This browser cannot record audio. Try Chrome, Edge or Safari.",
  permission: "Microphone access was blocked. Allow it in your browser settings, then try again.",
  no_microphone: "No microphone was found. Plug one in or check your system settings.",
  recording_failed: "The recording did not start. Please try again.",
  empty: "I did not catch anything — try speaking a little closer to the microphone.",
  transcription_failed: "I could not make out that recording. Please try again.",
  network: "The connection dropped. Check your network and try again.",
};

/** The audio format this browser will actually record.
 *
 * Chrome and Firefox produce webm/opus; Safari, including every browser on
 * iOS, produces mp4. Hardcoding webm meant the mic silently failed on iPhone,
 * which is where a student practising speaking is most likely to be. Whisper
 * accepts both, so the only requirement is that we ask for one the browser
 * has and label the upload with what we actually got. */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined; // let the browser choose its own default
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

export interface SpeechToText {
  state: ListenState;
  error: VoiceError | null;
  /** Rough input loudness, 0–1, for the listening indicator. */
  level: number;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  clearError: () => void;
}

/** Microphone capture and transcription, as one state machine.
 *
 * Speech-to-text is the app's existing /api/transcribe — Groq Whisper, no
 * language pin so it detects Japanese or English. This adds only the things a
 * conversation needs that push-to-talk did not: a loudness reading so the
 * student can see they are being heard, a cancel that throws the audio away,
 * and a guarantee that a second recording cannot start while the first is
 * still in flight.
 */
export function useSpeechToText(onTranscript: (text: string) => void): SpeechToText {
  const [state, setState] = useState<ListenState>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [level, setLevel] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  const abandonedRef = useRef(false);
  // Read inside the recorder's callback, which closes over its first value.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const teardown = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    setLevel(0);
  }, []);

  // A student who closes the tab mid-recording should not leave the
  // microphone light on.
  useEffect(() => teardown, [teardown]);

  const fail = useCallback((reason: VoiceError) => {
    setError(reason);
    setState("error");
  }, []);

  const start = useCallback(async () => {
    if (state !== "idle" && state !== "error") return; // no overlapping recordings
    setError(null);
    abandonedRef.current = false;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      fail("unsupported");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Browser-side cleanup costs nothing and measurably helps Whisper in
        // a room with other people in it, which is where this gets used.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (cause) {
      const name = (cause as DOMException | null)?.name;
      fail(
        name === "NotAllowedError" || name === "SecurityError"
          ? "permission"
          : name === "NotFoundError" || name === "DevicesNotFoundError"
            ? "no_microphone"
            : "recording_failed",
      );
      return;
    }
    streamRef.current = stream;

    // The loudness meter. Decorative in the sense that nothing depends on it,
    // and not decorative at all in the sense that a student cannot otherwise
    // tell a listening app from a frozen one.
    try {
      const context = new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
        setLevel(Math.min(1, peak / 64));
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // No meter on this browser; recording is unaffected.
    }

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      teardown();
      fail("recording_failed");
      return;
    }
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onerror = () => {
      teardown();
      fail("recording_failed");
    };
    recorder.onstop = async () => {
      teardown();
      if (abandonedRef.current) {
        setState("idle");
        return;
      }
      const type = recorder.mimeType || mimeType || "audio/webm";
      const audio = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      // A tap rather than a hold: too short to contain speech, and sending it
      // spends a Whisper request to be told so.
      if (audio.size < 1200) {
        fail("empty");
        return;
      }

      setState("transcribing");
      try {
        const body = new FormData();
        body.append("audio", audio, `speech.${extensionFor(type)}`);
        const response = await fetch("/api/transcribe", { method: "POST", body });
        if (!response.ok) {
          fail(response.status >= 500 ? "network" : "transcription_failed");
          return;
        }
        const { text } = (await response.json()) as { text?: string };
        const said = text?.trim() ?? "";
        if (!said) {
          fail("empty");
          return;
        }
        setState("idle");
        onTranscriptRef.current(said);
      } catch {
        fail("network");
      }
    };

    recorderRef.current = recorder;
    recorder.start();
    setState("listening");
  }, [fail, state, teardown]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const cancel = useCallback(() => {
    abandonedRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    else {
      teardown();
      setState("idle");
    }
  }, [teardown]);

  const clearError = useCallback(() => {
    setError(null);
    setState("idle");
  }, []);

  return { state, error, level, start, stop, cancel, clearError };
}

/* ------------------------------------------------------------------------ */
/* Speaking                                                                   */
/* ------------------------------------------------------------------------ */

export interface TextToSpeech {
  speaking: boolean;
  /** True while the audio is being fetched but has not started playing. */
  loading: boolean;
  speak: (markdown: string) => Promise<void>;
  stop: () => void;
}

/** Speak an answer, with the browser's own voice as the safety net.
 *
 * Two engines, deliberately. The server route reads Japanese properly, and it
 * can fail for reasons that have nothing to do with the student: the Google
 * key it shares with vision and embeddings hits a daily limit, the network
 * drops, the model is briefly unavailable. None of that should mean silence,
 * so any failure falls through to speechSynthesis, which is free, local, and
 * always there — worse at Japanese, and far better than nothing.
 *
 * The text is on screen either way. Speech is the second channel, never the
 * only one.
 */
export function useTextToSpeech(): TextToSpeech {
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  // Bumped on every stop and every new utterance, so a slow fetch that
  // resolves after the student moved on cannot start talking over them.
  const turnRef = useRef(0);

  const release = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    audioRef.current = null;
  }, []);

  const stop = useCallback(() => {
    turnRef.current += 1;
    if (audioRef.current) {
      audioRef.current.pause();
      release();
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
    setLoading(false);
  }, [release]);

  useEffect(() => stop, [stop]);

  /** The fallback: the operating system's own voice, one utterance per
   * language run so a Japanese sentence is not read by an English voice. */
  const speakLocally = useCallback((text: string, turn: number) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setSpeaking(false);
      return;
    }
    window.speechSynthesis.cancel();
    const segments = speechSegments(text);
    if (segments.length === 0) {
      setSpeaking(false);
      return;
    }
    segments.forEach((segment, index) => {
      const utterance = new SpeechSynthesisUtterance(segment.text);
      utterance.lang = segment.lang === "ja" ? "ja-JP" : "en-US";
      // Japanese learners are not native listeners; a shade under natural
      // pace is the difference between practice and noise.
      utterance.rate = segment.lang === "ja" ? 0.95 : 1;
      if (index === segments.length - 1) {
        utterance.onend = () => {
          if (turnRef.current === turn) setSpeaking(false);
        };
        utterance.onerror = () => {
          if (turnRef.current === turn) setSpeaking(false);
        };
      }
      window.speechSynthesis.speak(utterance);
    });
  }, []);

  const speak = useCallback(
    async (markdown: string) => {
      const text = speakableText(markdown);
      if (!text) return;

      turnRef.current += 1;
      const turn = turnRef.current;
      if (audioRef.current) {
        audioRef.current.pause();
        release();
      }
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      setSpeaking(true);
      setLoading(true);

      try {
        const response = await fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (turnRef.current !== turn) return; // superseded while fetching
        if (!response.ok) throw new Error(String(response.status));

        const blob = await response.blob();
        if (turnRef.current !== turn) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          if (turnRef.current === turn) {
            setSpeaking(false);
            release();
          }
        };
        audio.onerror = () => {
          // The bytes arrived and would not play — a codec the browser
          // dislikes. The local voice can still say it.
          if (turnRef.current === turn) speakLocally(text, turn);
        };
        setLoading(false);
        await audio.play();
      } catch {
        if (turnRef.current !== turn) return;
        setLoading(false);
        speakLocally(text, turn);
      }
    },
    [release, speakLocally],
  );

  return { speaking, loading, speak, stop };
}
