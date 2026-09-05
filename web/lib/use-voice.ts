"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { speakableText, sentences, speechSegments } from "./speech";

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
 * which is where a student practising speaking is most likely to be. */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

/* --- Voice activity detection -------------------------------------------
 *
 * Built on the AnalyserNode that was already there to draw the level meter,
 * because the alternative is a new dependency: a Silero/ONNX VAD is a better
 * detector and costs a WASM model download and a package this project has
 * not agreed to. Energy over a threshold is cruder and good enough for one
 * speaker close to a microphone, which is the case here.
 *
 * The numbers are the whole design. A pause inside a sentence — 「昨日、
 * 大学の友達と……」 — runs a few hundred milliseconds; the gap after a finished
 * thought runs longer. 1.1 seconds sits between the two: long enough not to
 * cut a student off mid-sentence while they search for a word, short enough
 * that the reply does not feel like it is waiting for permission.
 */
const SPEECH_LEVEL = 0.12; // above this, someone is talking
const SILENCE_LEVEL = 0.07; // below this, nobody is (hysteresis, not one line)
const SILENCE_MS = 1100; // quiet for this long after speech ends the turn
const MIN_SPEECH_MS = 300; // shorter than this was a cough, not a sentence
const MAX_UTTERANCE_MS = 30_000; // a safety stop, never reached in conversation
const LEAD_IN_MS = 6000; // give someone this long to start before giving up

export interface SpeechToText {
  state: ListenState;
  error: VoiceError | null;
  /** Rough input loudness, 0–1, for the listening indicator. */
  level: number;
  /** True once the student has actually started talking this turn. */
  hearing: boolean;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  clearError: () => void;
}

/** Microphone capture, endpointing and transcription, as one state machine.
 *
 * Speech-to-text is the app's existing /api/transcribe — Groq Whisper, no
 * language pin so it detects Japanese or English and the same route serves
 * both. What this adds is the part that makes it a conversation rather than
 * a dictation box: the student does not press stop. Speech is detected,
 * the end of it is detected, and the turn goes on its own.
 */
export function useSpeechToText(
  onTranscript: (text: string) => void,
  options: { onSpeechStart?: () => void } = {},
): SpeechToText {
  const [state, setState] = useState<ListenState>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [level, setLevel] = useState(0);
  const [hearing, setHearing] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  const abandonedRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onSpeechStartRef = useRef(options.onSpeechStart);
  onSpeechStartRef.current = options.onSpeechStart;

  const teardown = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    setLevel(0);
    setHearing(false);
  }, []);

  useEffect(() => teardown, [teardown]);

  const fail = useCallback(
    (reason: VoiceError) => {
      teardown();
      setError(reason);
      setState("error");
    },
    [teardown],
  );

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    if (state === "listening" || state === "transcribing") return;
    setError(null);
    setHearing(false);
    abandonedRef.current = false;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      fail("unsupported");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
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
    recorder.onerror = () => fail("recording_failed");
    recorder.onstop = async () => {
      teardown();
      if (abandonedRef.current) {
        setState("idle");
        return;
      }
      const type = recorder.mimeType || mimeType || "audio/webm";
      const audio = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
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

    // The endpointer. Runs on the same analyser that draws the meter, so
    // listening costs one audio graph rather than two.
    try {
      const context = new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);

      const openedAt = Date.now();
      let speechStartedAt: number | null = null;
      let quietSince: number | null = null;

      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
        const loudness = Math.min(1, peak / 64);
        setLevel(loudness);

        const now = Date.now();
        if (loudness > SPEECH_LEVEL) {
          quietSince = null;
          if (speechStartedAt === null) {
            speechStartedAt = now;
            setHearing(true);
            // Barge-in: the tutor stops talking the moment the student does.
            onSpeechStartRef.current?.();
          }
        } else if (loudness < SILENCE_LEVEL && speechStartedAt !== null) {
          quietSince ??= now;
          const spoken = now - speechStartedAt;
          if (now - quietSince >= SILENCE_MS && spoken >= MIN_SPEECH_MS) {
            stop(); // end of utterance — the student never pressed anything
            return;
          }
        }

        // Two safety stops: an open microphone nobody spoke into, and a turn
        // that has run far past any real sentence.
        if (speechStartedAt === null && now - openedAt > LEAD_IN_MS) {
          abandonedRef.current = true;
          stop();
          return;
        }
        if (speechStartedAt !== null && now - speechStartedAt > MAX_UTTERANCE_MS) {
          stop();
          return;
        }
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // No analyser on this browser: recording still works, the student just
      // has to press stop themselves.
    }

    recorderRef.current = recorder;
    recorder.start();
    setState("listening");
  }, [fail, state, stop, teardown]);

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

  return { state, error, level, hearing, start, stop, cancel, clearError };
}

/* ------------------------------------------------------------------------ */
/* Speaking                                                                   */
/* ------------------------------------------------------------------------ */

export interface TextToSpeech {
  speaking: boolean;
  loading: boolean;
  speak: (markdown: string) => Promise<void>;
  stop: () => void;
}

/** Speak an answer, a sentence at a time, with the browser voice as the net.
 *
 * Sentence at a time because the whole reply is the wrong unit. Measured:
 * the cloud voice takes about four seconds to return audio for a two-sentence
 * reply and about a second for the first sentence alone. Splitting the reply
 * and playing the first clause while the rest is still being synthesised
 * takes time-to-first-audio from four seconds to roughly one — the difference
 * between a conversation and a wait.
 *
 * The fallback stays: any failure drops to speechSynthesis, which is free,
 * local, worse at Japanese and always there. The text is on screen either
 * way; speech is the second channel, never the only one.
 */
export function useTextToSpeech(options: { onDone?: () => void } = {}): TextToSpeech {
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlsRef = useRef<string[]>([]);
  // Bumped on every stop and every new utterance, so a slow fetch that
  // resolves after the student has moved on cannot start talking over them.
  const turnRef = useRef(0);
  const onDoneRef = useRef(options.onDone);
  onDoneRef.current = options.onDone;

  const release = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
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

  /** The operating system's own voice, one utterance per language run so a
   * Japanese sentence is not read by an English voice. */
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
      utterance.rate = segment.lang === "ja" ? 0.95 : 1;
      if (index === segments.length - 1) {
        const finish = () => {
          if (turnRef.current === turn) {
            setSpeaking(false);
            onDoneRef.current?.();
          }
        };
        utterance.onend = finish;
        utterance.onerror = finish;
      }
      window.speechSynthesis.speak(utterance);
    });
  }, []);

  /** One clause of audio from the server, or null if it could not be had. */
  const fetchClause = useCallback(async (text: string): Promise<string | null> => {
    try {
      const response = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) return null;
      const url = URL.createObjectURL(await response.blob());
      urlsRef.current.push(url);
      return url;
    } catch {
      return null;
    }
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

      const clauses = sentences(text);
      // The next clause is fetched while the current one plays, so only the
      // first one is ever waited for.
      let pending = fetchClause(clauses[0]);

      for (let index = 0; index < clauses.length; index++) {
        const url = await pending;
        if (turnRef.current !== turn) return; // superseded, or stopped
        if (index + 1 < clauses.length) pending = fetchClause(clauses[index + 1]);

        if (!url) {
          // The server voice failed. Say the rest with the local one rather
          // than stopping mid-reply.
          setLoading(false);
          speakLocally(clauses.slice(index).join(" "), turn);
          return;
        }

        setLoading(false);
        const played = await new Promise<boolean>((resolve) => {
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => resolve(true);
          audio.onerror = () => resolve(false);
          void audio.play().catch(() => resolve(false));
        });
        if (turnRef.current !== turn) return;
        if (!played) {
          speakLocally(clauses.slice(index).join(" "), turn);
          return;
        }
      }

      if (turnRef.current === turn) {
        setSpeaking(false);
        release();
        onDoneRef.current?.();
      }
    },
    [fetchClause, release, speakLocally],
  );

  return { speaking, loading, speak, stop };
}
