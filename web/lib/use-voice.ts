"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ConversationLanguage } from "./conversation";
import { speakableText, sentences, speechSegments } from "./speech";
import { beginVoiceTurn, endVoiceTurn, markVoiceStage } from "./voice-metrics";

/* ------------------------------------------------------------------------ */
/* The state machine                                                          */
/* ------------------------------------------------------------------------ */

/** Where a spoken turn is, as one value.
 *
 * The loop always had these states; it just kept them in six booleans spread
 * across two hooks and a component, and every place that wanted to render
 * "what is happening" re-derived them slightly differently. One name for each
 * state, derived once, so the button, the status line and the voice screen
 * cannot disagree about whether the tutor is thinking or talking.
 *
 * The cycle is: idle → listening → hearing → transcribing → thinking →
 * responding → speaking → listening. It returns to listening on its own —
 * nobody presses anything between turns — and any state can be interrupted by
 * the student speaking, which is barge-in and lands back at `hearing`.
 */
export type VoicePhase =
  | "idle"
  /** Microphone open, nothing said yet. */
  | "listening"
  /** The student is speaking right now. */
  | "hearing"
  /** Speech captured, Whisper working. */
  | "transcribing"
  /** Sent. The server is deciding what this turn means, retrieving if it has
   * to, and generating. Indistinguishable from here, and deliberately shown
   * as one state: a student does not care which. */
  | "thinking"
  /** The answer is arriving as text but no audio has played yet. */
  | "responding"
  /** The tutor is talking. */
  | "speaking";

export interface VoicePhaseInput {
  live: boolean;
  listenState: ListenState;
  hearing: boolean;
  /** A chat request is in flight. */
  replying: boolean;
  /** Tokens of the answer have started arriving. */
  answerStarted: boolean;
  speaking: boolean;
  /** Audio is being fetched but has not started playing. */
  loadingAudio: boolean;
}

/** The single source of truth for what the voice loop is doing.
 *
 * Ordered by what overrides what, and speaking comes first: audio playing is
 * the most visible fact about the turn, and it briefly overlaps the tail of
 * the request while the last clause is still being fetched.
 */
export function voicePhase(input: VoicePhaseInput): VoicePhase {
  if (!input.live) return "idle";
  if (input.speaking || input.loadingAudio) return "speaking";
  if (input.listenState === "transcribing") return "transcribing";
  if (input.replying) return input.answerStarted ? "responding" : "thinking";
  if (input.listenState === "listening") return input.hearing ? "hearing" : "listening";
  return "idle";
}

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

      markVoiceStage("capture");
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
        markVoiceStage("stt");
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
    beginVoiceTurn();
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
  speak: (markdown: string, language?: ConversationLanguage) => Promise<void>;
  stop: () => void;
}

/* --- One voice, both languages -------------------------------------------
 *
 * The tutor has ONE voice. A student who says "let's speak Japanese" halfway
 * through should hear the same person carry on in Japanese, not be handed to
 * a different speaker — and the app was doing exactly that, twice over: the
 * browser fallback picked a voice per LANGUAGE RUN, so a single bilingual
 * sentence was read by two different people taking turns mid-clause.
 *
 * The cloud path never had this problem and is where the requirement is
 * genuinely met: `/api/speak` synthesises every clause with one prebuilt
 * Gemini voice (Kore by default), which speaks both languages in one voice
 * identity, and nothing in the request varies by language. That is the voice
 * students actually hear.
 *
 * This is the emergency path — the network failed, or the Google key is out
 * of quota — where the browser gives us only whatever voices the student's
 * operating system happens to ship, each pinned to one language. The best
 * available answer, in order:
 *
 *   1. A genuinely multilingual system voice if there is one. The Edge and
 *      Windows "Natural"/"Multilingual" voices speak both, which is the same
 *      guarantee the cloud voice gives.
 *   2. Otherwise one voice chosen for the conversation's language and HELD —
 *      remembered for the life of the page, so it is the same speaker on
 *      every reply rather than being re-picked per utterance.
 *
 * A Japanese voice reading an English clause is worse than an English one, so
 * a single-language pick still sets `lang` per run for pronunciation. What it
 * no longer does is change WHO is speaking part way through a sentence.
 */
let heldVoice: SpeechSynthesisVoice | null = null;

/** Names that mean "this voice speaks more than one language". */
const MULTILINGUAL = /multiling|natural/i;

function fallbackVoice(language: ConversationLanguage): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  // Still the one chosen earlier: identity must not change between replies.
  if (heldVoice) return heldVoice;

  // getVoices() is populated asynchronously and returns [] on the first call
  // in some browsers. Returning null then is correct — the utterance falls
  // back to the platform default for its lang, and the next reply, by which
  // time the list has loaded, pins one properly.
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  const wanted = language === "ja" ? /^ja/i : /^en/i;
  heldVoice =
    voices.find((voice) => MULTILINGUAL.test(voice.name) && wanted.test(voice.lang)) ??
    voices.find((voice) => MULTILINGUAL.test(voice.name)) ??
    voices.find((voice) => wanted.test(voice.lang)) ??
    null;
  return heldVoice;
}

/** Test seam, and the one legitimate reason to forget the choice: the voice
 * list changes when the student installs or removes a system voice. */
export function resetFallbackVoice(): void {
  heldVoice = null;
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

  /** The operating system's own voice: one utterance per language run so the
   * pronunciation is right, but ONE voice across all of them so the speaker
   * does not change identity mid-sentence. */
  const speakLocally = useCallback(
    (text: string, turn: number, language: ConversationLanguage) => {
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
    const voice = fallbackVoice(language);
    segments.forEach((segment, index) => {
      const utterance = new SpeechSynthesisUtterance(segment.text);
      if (voice) utterance.voice = voice;
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
    },
    [],
  );

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
    async (markdown: string, language: ConversationLanguage = "ja") => {
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
          speakLocally(clauses.slice(index).join(" "), turn, language);
          return;
        }

        setLoading(false);
        const played = await new Promise<boolean>((resolve) => {
          const audio = new Audio(url);
          audioRef.current = audio;
          if (index === 0) {
            // The end of the measurement: the first syllable the student
            // actually hears, not the moment the answer finished generating.
            audio.onplaying = () => {
              markVoiceStage("tts_first_audio");
              endVoiceTurn("voice turn");
            };
          }
          audio.onended = () => resolve(true);
          audio.onerror = () => resolve(false);
          void audio.play().catch(() => resolve(false));
        });
        if (turnRef.current !== turn) return;
        if (!played) {
          speakLocally(clauses.slice(index).join(" "), turn, language);
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
