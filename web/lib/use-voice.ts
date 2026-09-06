"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ConversationLanguage } from "./conversation";
import { readyToSpeak, speakableText, sentences, speechSegments } from "./speech";
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
/** Shortest run of text worth sending to the voice on its own. */
const MIN_CLAUSE_CHARS = 12;

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
  const analyserRef = useRef<AnalyserNode | null>(null);
  const frameRef = useRef<number | null>(null);
  const abandonedRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onSpeechStartRef = useRef(options.onSpeechStart);
  onSpeechStartRef.current = options.onSpeechStart;

  /** End of TURN. The microphone stays open.
   *
   * This used to be the same function as shutdown below, and that is what made
   * the conversation feel like a walkie-talkie however little the interface
   * said so: every turn released the microphone and the next one asked the
   * browser for it again. getUserMedia is not free — it re-negotiates the
   * device, re-runs the permission check and re-flashes the recording
   * indicator — and it sat in the gap between the tutor finishing and the
   * student being able to speak, which is the one moment a conversation
   * cannot afford a pause.
   *
   * Holding the stream for the session costs nothing while nobody is
   * recording: the MediaRecorder is stopped, so no audio is captured. It is
   * released the moment the student leaves voice. */
  const endTurn = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    setLevel(0);
    setHearing(false);
  }, []);

  /** End of SESSION. Gives the microphone back. */
  const shutdown = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    analyserRef.current = null;
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    setLevel(0);
    setHearing(false);
  }, []);

  useEffect(() => shutdown, [shutdown]);

  const fail = useCallback(
    (reason: VoiceError) => {
      // An error hands the microphone back: whatever went wrong, holding an
      // open device while showing a failure is the wrong side to err on.
      shutdown();
      setError(reason);
      setState("error");
    },
    [shutdown],
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

    // The stream from the previous turn, if it is still live. A track can end
    // underneath us — the device is unplugged, another app takes it, the OS
    // revokes it — so this checks rather than assumes, and falls back to
    // asking for a new one, which is exactly the old behaviour.
    const held = streamRef.current;
    const stillLive =
      held !== null && held.getAudioTracks().some((track) => track.readyState === "live");

    let stream: MediaStream;
    if (stillLive && held) {
      stream = held;
    } else {
      if (held) shutdown();
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
    }
    streamRef.current = stream;

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      fail("recording_failed");
      return;
    }

    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onerror = () => fail("recording_failed");
    recorder.onstop = async () => {
      endTurn();
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
      // Built once and kept, like the stream: a new AudioContext per turn is
      // both a real cost and a resource browsers cap.
      if (!audioContextRef.current || !analyserRef.current) {
        const context = new AudioContext();
        audioContextRef.current = context;
        const created = context.createAnalyser();
        created.fftSize = 512;
        context.createMediaStreamSource(stream).connect(created);
        analyserRef.current = created;
      }
      // Autoplay policies can leave a context suspended; a suspended analyser
      // reports silence for ever, which reads as "the microphone is dead".
      if (audioContextRef.current.state === "suspended") {
        void audioContextRef.current.resume().catch(() => {});
      }
      const analyser = analyserRef.current;
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
  }, [endTurn, fail, shutdown, state, stop]);

  const cancel = useCallback(() => {
    abandonedRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    shutdown();
    setState("idle");
  }, [shutdown]);

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
  /** Speak a finished answer.
   *
   * Takes no language: the cloud voice speaks both in one voice, and the
   * browser fallback picks its voice per run of text inside the answer, which
   * is the only way a bilingual reply gets read in full. */
  speak: (markdown: string) => Promise<void>;
  /** Speak a reply that is still streaming: the text so far, and whether the
   * stream has finished. Clauses are spoken as they complete. */
  speakStreaming: (soFar: string, done: boolean) => void;
  stop: () => void;
}

/* --- The tutor's voice, and the limits of the browser's -------------------
 *
 * The tutor has ONE voice, and on the path students actually hear she really
 * does: `/api/speak` synthesises every clause with one prebuilt Gemini voice
 * (Kore, female), which speaks Japanese and English in the same voice, and
 * nothing in that request varies by language.
 *
 * This is the emergency path — the network failed, or the daily TTS quota is
 * spent — and here a single voice is not merely hard but wrong. The Web
 * Speech API hands out voices bound to one language, and a bilingual answer
 * is the normal case in this app: an English explanation carrying the
 * Japanese the course teaches. Pinning ONE voice across both, which is what
 * this file did for a day, means every Japanese run is handed to an English
 * voice — and the engines do not approximate it, they skip it. The result was
 * an answer read aloud with all of its Japanese missing, which is the one
 * part a language student needed to hear.
 *
 * So: one voice per language, each held for the life of the page so the
 * speaker never changes between replies, and each chosen female to match Kore
 * so the two languages sound like the same person rather than two strangers.
 * That is as close to one identity as the platform allows, and it beats
 * silence, which is what "one voice" actually bought.
 *
 * The Web Speech API does not expose gender, so this is a name list. It is
 * unavoidably incomplete and deliberately conservative: an unrecognised voice
 * is preferred over a recognised male one, and a recognised male one is used
 * only when there is nothing else in that language at all.
 */
const heldVoices = new Map<ConversationLanguage, SpeechSynthesisVoice>();

/** Names that mean "this voice speaks more than one language". */
const MULTILINGUAL = /multiling|natural/i;

/* The tutor is one person, and she is the voice students already hear.
 *
 * The cloud path speaks with Gemini's Kore, which is female, for every
 * language and every flow. The browser fallback had no such rule: it asked for
 * a voice by LANGUAGE and took whatever the operating system offered first,
 * which on Windows is Microsoft David — male. So a student whose /api/speak
 * call failed heard a different person read the answer than the one who had
 * been talking to them a moment earlier, and the two flows appeared to have
 * two different voices.
 *
 * The Web Speech API does not expose gender, so this is a name list. It is
 * unavoidably incomplete and deliberately conservative: an unrecognised voice
 * is preferred over a recognised male one, and a recognised male one is used
 * only when there is nothing else in the right language at all — a wrong-sex
 * voice still beats silence, and beats English being read by a Japanese voice.
 */
const FEMALE_VOICES =
  /\b(zira|aria|jenny|michelle|ana|sara|nanami|ayumi|haruka|sayaka|mayu|samantha|ava|allison|susan|vicki|victoria|karen|moira|tessa|fiona|kyoko|o-ren|hazel|linda|heera|female)\b/i;

const MALE_VOICES =
  /\b(david|mark|george|james|daniel|alex|fred|guy|eric|christopher|roger|steffan|otoya|hattori|ichiro|keita|male)\b/i;

export function fallbackVoice(language: ConversationLanguage): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  // Still the one chosen earlier for this language: identity must not change
  // between replies.
  const held = heldVoices.get(language);
  if (held) return held;

  // getVoices() is populated asynchronously and returns [] on the first call
  // in some browsers. Returning null WITHOUT caching is the point — the
  // utterance falls back to the platform default for its lang this once, and
  // the next reply, by which time the list has loaded, pins one properly.
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  const wanted = language === "ja" ? /^ja/i : /^en/i;
  const inLanguage = voices.filter((voice) => wanted.test(voice.lang));
  const female = (voice: SpeechSynthesisVoice) => FEMALE_VOICES.test(voice.name);
  const male = (voice: SpeechSynthesisVoice) => MALE_VOICES.test(voice.name);

  const chosen =
    // A known female voice in this language, multilingual first.
    inLanguage.find((v) => female(v) && MULTILINGUAL.test(v.name)) ??
    inLanguage.find(female) ??
    // Nothing recognised. Prefer an unknown voice over a known male one.
    inLanguage.find((v) => !male(v)) ??
    inLanguage[0] ??
    null;

  if (chosen) heldVoices.set(language, chosen);
  return chosen;
}

/** Test seam, and the one legitimate reason to forget the choice: the voice
 * list changes when the student installs or removes a system voice. */
export function resetFallbackVoice(): void {
  heldVoices.clear();
}

/* --- Audio already synthesised -------------------------------------------
 *
 * Synthesis is the same cost every time it is asked for the same sentence, and
 * this app asks for the same sentence more often than it looks: a student
 * presses Listen, reads on, and presses it again; a tutor opens two replies
 * with 「いいですね。」; a spoken turn is replayed after a mishearing. Each of
 * those was a fresh round trip and a fresh second of waiting.
 *
 * Blobs rather than object URLs, because `release()` revokes the URLs it hands
 * out and a revoked URL cannot be played again — the audio is what is worth
 * keeping, and wrapping it in a new URL is free.
 *
 * Small and oldest-first: this is a convenience for the last few minutes of a
 * conversation, not a store. Forty clauses of Gemini's 24 kHz PCM is a couple
 * of megabytes, and it is gone when the page is.
 */
const CLAUSE_CACHE_LIMIT = 40;
const clauseAudio = new Map<string, Blob>();

/* --- When the cloud voice has run out ------------------------------------
 *
 * Measured against the live key on 2026-09-06, the free tier allows TEN
 * requests A DAY for gemini-2.5-flash-preview-tts:
 *
 *   "Quota exceeded ... limit: 10, model: gemini-2.5-flash-tts"
 *
 * A spoken reply is two or three clauses, so a student gets three or four
 * turns before the voice is gone for the rest of the day — and every clause
 * after that was still asking, waiting a few hundred milliseconds to be told
 * no, and only then falling back to the browser. Per clause, all day.
 *
 * So the refusal is remembered. The window is long enough to stop the asking
 * and short enough that a daily reset, or a topped-up plan, recovers on its
 * own without a deploy — the same reasoning as the model provider health in
 * lib/providers.ts.
 */
const CLOUD_VOICE_BACKOFF_MS = 15 * 60 * 1000;
let cloudVoiceBlockedUntil = 0;

function cloudVoiceExhausted(): boolean {
  return Date.now() < cloudVoiceBlockedUntil;
}

function noteCloudVoiceExhausted(): void {
  cloudVoiceBlockedUntil = Date.now() + CLOUD_VOICE_BACKOFF_MS;
}

/** Test seam — no production caller. */
export function resetCloudVoice(): void {
  cloudVoiceBlockedUntil = 0;
}

function rememberClause(text: string, blob: Blob): void {
  // Re-inserting moves the key to the end of the iteration order, so eviction
  // drops the clause nobody has played for longest.
  clauseAudio.delete(text);
  clauseAudio.set(text, blob);
  while (clauseAudio.size > CLAUSE_CACHE_LIMIT) {
    const oldest = clauseAudio.keys().next().value;
    if (oldest === undefined) break;
    clauseAudio.delete(oldest);
  }
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
  const clausesRef = useRef<string[]>([]);
  const streamDoneRef = useRef(true);
  /** True between the first chunk of a streamed reply and its last.
   *
   * Needed because "is this a new reply?" cannot be read off the queue: a
   * finished turn leaves its clauses in place, so the next turn would look
   * like a continuation of it and never start a player. */
  const streamingRef = useRef(false);
  const consumedRef = useRef(0);
  /** Resolved when more clauses arrive, so the player waits without polling. */
  const wakeRef = useRef<(() => void) | null>(null);
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
    // Let a waiting player fall out of its loop rather than leaving it parked
    // on a promise that will never resolve.
    streamingRef.current = false;
    streamDoneRef.current = true;
    clausesRef.current = [];
    consumedRef.current = 0;
    wakeRef.current?.();
    wakeRef.current = null;
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
    // No language parameter: the voice is chosen per RUN of text below, not
    // per reply, because a bilingual answer needs both.
    (text: string, turn: number) => {
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
      // Per RUN, not per reply. A Japanese run read by an English voice is
      // not read at all — the engine skips it — and a bilingual answer is the
      // normal shape of an answer here.
      const voice = fallbackVoice(segment.lang);
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
    // The cloud voice is out of quota. Do not ask it again — go straight to
    // the browser voice, which is the difference between a fallback that
    // costs nothing and one that costs a round trip per clause.
    if (cloudVoiceExhausted()) return null;

    const cached = clauseAudio.get(text);
    if (cached) {
      // A fresh URL each time: `release()` revokes the URLs it handed out, and
      // a revoked one cannot be played again. The BLOB is what is worth
      // keeping, and it costs nothing to wrap it in a new URL.
      const url = URL.createObjectURL(cached);
      urlsRef.current.push(url);
      return url;
    }
    try {
      const response = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (response.status === 429) {
        noteCloudVoiceExhausted();
        return null;
      }
      if (!response.ok) return null;
      const blob = await response.blob();
      rememberClause(text, blob);
      const url = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      return url;
    } catch {
      return null;
    }
  }, []);

  /* --- The player ------------------------------------------------------
   *
   * Clauses go in one end and audio comes out the other, and the list is
   * allowed to GROW while the player is working through it. That is the whole
   * point: the answer is still being written when the tutor starts talking.
   *
   * Before this, speaking began in the chat's onFinish handler — after the
   * last token of the answer had arrived. So the student waited for the model
   * to finish writing a reply they were never going to read, and only THEN
   * for the first clause to be synthesised. The generation time was pure
   * silence, and it is the largest single component of a spoken turn.
   */

  const wake = useCallback(() => {
    wakeRef.current?.();
    wakeRef.current = null;
  }, []);

  const play = useCallback(
    async (turn: number) => {
      let index = 0;
      let pending: Promise<string | null> | null = null;

      for (;;) {
        if (turnRef.current !== turn) return;

        // Nothing ready yet. Either the answer is still being written — wait
        // for the next clause — or it is finished and so are we.
        if (index >= clausesRef.current.length) {
          if (streamDoneRef.current) break;
          await new Promise<void>((resolve) => {
            wakeRef.current = resolve;
          });
          continue;
        }

        if (!pending) pending = fetchClause(clausesRef.current[index]);
        const url = await pending;
        pending = null;
        if (turnRef.current !== turn) return;

        // The next clause is fetched while this one plays, so only the first
        // is ever waited for.
        if (index + 1 < clausesRef.current.length) {
          pending = fetchClause(clausesRef.current[index + 1]);
        }

        if (!url) {
          // The server voice failed. Say the rest with the local one rather
          // than stopping mid-reply.
          setLoading(false);
          speakLocally(clausesRef.current.slice(index).join(" "), turn);
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
          speakLocally(clausesRef.current.slice(index).join(" "), turn);
          return;
        }
        index++;
      }

      if (turnRef.current === turn) {
        setSpeaking(false);
        release();
        onDoneRef.current?.();
      }
    },
    [fetchClause, release, speakLocally],
  );

  /** Reset the queue and take the turn. */
  const beginTurn = useCallback((): number => {
    turnRef.current += 1;
    if (audioRef.current) {
      audioRef.current.pause();
      release();
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    clausesRef.current = [];
    consumedRef.current = 0;
    streamDoneRef.current = false;
    setSpeaking(true);
    setLoading(true);
    return turnRef.current;
  }, [release]);

  /** Turn as much of the answer-so-far as is FINISHED into clauses.
   *
   * Only up to the last sentence terminator, because the text after it is
   * still being written and speaking half a sentence is worse than waiting.
   * Already-queued clauses are never revised — the player may be reading one
   * of them aloud at the time.
   *
   * The minimum length is not tidiness. Measured: 「いいですね！」 sent alone
   * came back from the service with no audio at all, and synthesis latency is
   * mostly fixed cost rather than per-character, so a three-character request
   * costs nearly what a whole sentence costs. A short fragment waits for the
   * next one instead of being sent by itself.
   */
  const enqueue = useCallback(
    (soFar: string, done: boolean) => {
      const text = speakableText(soFar);
      const { region, consumed } = readyToSpeak(
        text,
        consumedRef.current,
        done,
        MIN_CLAUSE_CHARS,
      );
      if (!region) return;

      consumedRef.current = consumed;
      clausesRef.current = [...clausesRef.current, ...sentences(region)];
      wake();
    },
    [wake],
  );

  /** Speak a finished answer — the Listen button, and any reply that arrived
   * complete rather than streamed. */
  const speak = useCallback(
    async (markdown: string) => {
      const text = speakableText(markdown);
      if (!text) return;
      const turn = beginTurn();
      clausesRef.current = sentences(text);
      consumedRef.current = text.length;
      streamDoneRef.current = true;
      streamingRef.current = false;
      await play(turn);
    },
    [beginTurn, play],
  );

  /** Speak an answer WHILE it is still being written.
   *
   * Called as the reply streams, with the text so far. The first call starts
   * the player; later calls only extend its queue; the final call with `done`
   * lets it finish and hand the microphone back. */
  const speakStreaming = useCallback(
    (soFar: string, done: boolean) => {
      if (!streamingRef.current) {
        streamingRef.current = true;
        const turn = beginTurn();
        enqueue(soFar, done);
        if (done) {
          streamDoneRef.current = true;
          streamingRef.current = false;
        }
        wake();
        void play(turn);
        return;
      }
      enqueue(soFar, done);
      if (done) {
        streamDoneRef.current = true;
        streamingRef.current = false;
      }
      wake();
    },
    [beginTurn, enqueue, play, wake],
  );

  return { speaking, loading, speak, speakStreaming, stop };
}
