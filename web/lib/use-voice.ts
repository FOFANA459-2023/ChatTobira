"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { listenChunks, readyClauses, speechSegments } from "./speech";
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
  | "network"
  | "quota";

export const VOICE_ERROR_TEXT: Record<VoiceError, string> = {
  unsupported: "This browser cannot record audio. Try Chrome, Edge or Safari.",
  permission: "Microphone access was blocked. Allow it in your browser settings, then try again.",
  no_microphone: "No microphone was found. Plug one in or check your system settings.",
  recording_failed: "The recording did not start. Please try again.",
  empty: "I did not catch anything — try speaking a little closer to the microphone.",
  transcription_failed: "I could not make out that recording. Please try again.",
  network: "The connection dropped. Check your network and try again.",
  quota: "You have reached today's limit. It resets at midnight (Japan time).",
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
  /** Speak a finished answer. What the Listen button on a typed reply does.
   *
   * Takes no language: there is one voice now, and it says both. The cloud
   * voice (Kore) always could, and the browser fallback is anchored on a
   * Japanese voice for the same reason — see `fallbackVoice`. */
  speak: (markdown: string) => Promise<void>;
  /** Speak an answer that is still arriving.
   *
   * Called on every stream update with the whole answer SO FAR; each call
   * synthesises whatever has become final since the last one. Idempotent by
   * clause — feeding the same text twice sends nothing twice — so the caller
   * can hand it every token without tracking what it has already said.
   *
   * `done` marks the last call of the turn, which is what releases the final
   * clause; see `readyClauses`.
   */
  speakAsItArrives: (markdownSoFar: string, done: boolean) => void;
  /** Synthesise the opening of an answer before anyone asks to hear it.
   *
   * Called when a typed answer finishes, so that pressing Listen plays at
   * once instead of after the 2.5-4.4 seconds the first clause takes to
   * synthesise — no TTS model on this key is faster than that, so the only
   * way to make the button instant is to have started before it was pressed.
   * Only the first clause: it is the one the student waits for in silence,
   * and the rest synthesise behind it while it plays. */
  prefetch: (markdown: string) => void;
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
/** The one browser voice this page speaks in, for both languages.
 *
 * ONE voice, which is the rule the cloud path has always followed: the tutor
 * is one person, and a student who switches to Japanese mid-conversation
 * should hear that same person carry on, not be handed to a different speaker.
 * Kore does this natively. The browser fallback has to be argued into it,
 * because the voices an operating system ships are each built for one
 * language — and the argument turns on a measurement.
 *
 * Measured on Windows with four Japanese voices and two English ones
 * installed, timing each voice against both scripts:
 *
 *                              English sentence    Japanese sentence
 *   Microsoft Ayumi (ja-JP)         6,628ms              3,981ms
 *   Microsoft Zira  (en-US)         4,554ms                775ms
 *
 * Read the Japanese column. Zira does not pronounce 「は」は文のトピックを
 * しめします。 badly in 775ms — she does not say it at all, and Windows
 * reports no error while skipping it. That is what a student heard when this
 * held one voice chosen by CONVERSATION language: an English explanation with
 * silence where every Japanese example should have been.
 *
 * The English column is the other half. Ayumi reads the English sentence in
 * full, ~45% slower and with a Japanese accent. That is a real cost and it is
 * much the smaller one, and it is arguably not a cost at all here: the tutor
 * in this app is a Japanese speaker, and an accented English aside from a
 * Japanese teacher is exactly what a student in that classroom hears.
 *
 * So the held voice is anchored on JAPANESE — the only language whose voices
 * were observed to carry both — rather than on whichever language the
 * conversation happens to be in. One person, nothing silent.
 */
let heldVoice: SpeechSynthesisVoice | null | undefined;

/** Names that mean "this voice speaks more than one language". */
const MULTILINGUAL = /multiling|natural/i;

/** Voices that sound female, by name, because the Web Speech API does not say.
 *
 * There is no gender field on SpeechSynthesisVoice — only name, lang and a
 * default flag — so this is a list of the names the major platforms ship, and
 * it will miss voices nobody here has seen. It earns its place anyway: the
 * cloud voice is Kore, who is female, and a fallback that switches the tutor
 * to a man the moment the network hiccups is a different person teaching the
 * lesson. Matching nothing falls through to the first voice that can speak
 * Japanese, which still beats silence.
 */
const FEMALE_VOICE = new RegExp(
  [
    // Windows
    "ayumi", "haruka", "sayaka", "nanami", "zira", "hazel", "susan",
    // macOS / iOS
    "kyoko", "o-ren", "samantha", "victoria", "karen", "moira", "tessa", "fiona", "allison", "ava",
    // Chrome / Android
    "google 日本語", "female",
  ].join("|"),
  "i",
);

/** The voice this page speaks in, chosen once and held. */
function fallbackVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  // Still the one chosen earlier: identity must not change between replies.
  if (heldVoice !== undefined) return heldVoice;

  // getVoices() is populated asynchronously and returns [] on the first call
  // in some browsers. Returning null WITHOUT holding it is correct — the
  // utterance falls back to the platform default for its lang, and the next
  // reply, by which time the list has loaded, pins one properly.
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  const japanese = voices.filter((voice) => /^ja/i.test(voice.lang));
  const multilingual = voices.filter((voice) => MULTILINGUAL.test(voice.name));

  heldVoice =
    // Best case: one person who speaks both languages natively, as Kore does.
    multilingual.find((voice) => FEMALE_VOICE.test(voice.name)) ??
    // Then a Japanese woman, measured above to carry the English too.
    japanese.find((voice) => FEMALE_VOICE.test(voice.name)) ??
    // Then any Japanese voice. A man reading both is worse than a woman
    // reading both, and far better than the Japanese going unsaid.
    japanese[0] ??
    multilingual[0] ??
    // Nothing Japanese installed at all. Keep the gender consistent with Kore
    // and accept that this device cannot say the Japanese whatever we pick.
    voices.find((voice) => FEMALE_VOICE.test(voice.name)) ??
    null;
  return heldVoice;
}

/** Test seam, and the one legitimate reason to forget the choice: the voice
 * list changes when the student installs or removes a system voice. */
export function resetFallbackVoice(): void {
  heldVoice = undefined;
}

/** A promise that something else will resolve, handed out before it does.
 *
 * The player loop waits on one of these when it runs out of clauses, rather
 * than polling for more. Taken fresh after every wake, and callers must read
 * `promise` BEFORE re-checking the condition it guards or they can sleep
 * through the notification that was meant for them.
 */
function waiter(): { promise: Promise<void>; wake: () => void } {
  let wake!: () => void;
  const promise = new Promise<void>((resolve) => (wake = resolve));
  return { promise, wake };
}

/** How many clauses may be in synthesis at once, counting the one playing.
 *
 * There has to be a number here, and running the Listen button on a five-clause
 * answer is what proved it: with no limit, feeding a FINISHED answer queued
 * every clause at once and fired five simultaneous requests at the speech
 * service. A streamed voice turn staggers itself, because the clauses arrive
 * one at a time — a finished answer has no such rhythm, and the Listen button
 * on a long typed reply would have burst ten.
 *
 * Two things are wrong with that. The Google key also carries vision and
 * embeddings, and a burst is the shape of request most likely to be rate
 * limited — `/api/speak` already names 429 as its one interesting failure. And
 * a student who presses stop after the first sentence has still paid for all
 * ten.
 *
 * 3 was the measured floor for closing the gaps between sentence-sized
 * clauses. It is 4 since the Listen button began reading in GROWING pieces
 * (see listenChunks): those pieces are sized on the assumption that two
 * pieces of audio are playing while the next one synthesises, and the live
 * voice turned out slower than that model on a 293-character piece, leaving
 * 2.6 seconds of silence. A fourth piece in flight gives every piece one more
 * piece of lead than its size assumes — a margin, not a new budget. It does
 * not add requests, only starts them sooner, and a long answer's six or seven
 * still sit under the project's ten a minute. The first clause is unaffected —
 * it is always index 0 and always starts immediately (or was prefetched).
 */
const PREFETCH_DEPTH = 4;

/** Synthesised clauses, by text, for the life of the page.
 *
 * Blobs rather than object URLs: an object URL is revoked when the audio it
 * played is released, and a cached one would be dead the second time it was
 * used. A URL is minted per playback instead.
 *
 * Kept for the page rather than per turn because the Listen button is pressed
 * after the turn that produced the answer is long over, and because pressing
 * it twice should not pay twice. Bounded, oldest out: a clause is a few
 * seconds of 24 kHz audio, and an evening of conversation should not grow
 * without limit. */
const AUDIO_CACHE_LIMIT = 40;
const audioCache = new Map<string, Promise<Blob | null>>();

/** Until when background prefetching stands down, after the speech service
 * said it was over quota. A prefetch is a guess that the student will press
 * Listen; it must not spend the project's ten-a-minute on guesses while a
 * student who actually pressed it is waiting. */
let quotaCooldownUntil = 0;

/** Longest wait honoured for a quota retry. Google's own hint has been 3 to
 * 14 seconds; past this, a student has given up listening anyway. */
const MAX_RETRY_WAIT_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One piece of audio from the server, shared by every caller that wants the
 * same text — a prefetch and the click that follows it get one request.
 *
 * Retries the SAME voice rather than giving up on it, because giving up is
 * what changed the tutor's persona mid-answer: a failed piece used to hand the
 * rest of the reply to the browser's own voice. Two failures are worth waiting
 * out, and both were observed from the app —
 *
 *   429  the ten-requests-a-minute project quota. The route passes on the
 *        wait Google asks for ("retry in 13s"), and the pieces already
 *        synthesised keep playing while it passes.
 *   502  the model returned no audio at all, a few seconds after being asked.
 *        Transient; once more is usually enough.
 *
 * Anything else — 401 signed out, 503 not configured — will not change by
 * retrying and returns null at once, so a signed-out visitor still hears the
 * browser voice without delay. */
function synthesize(text: string): Promise<Blob | null> {
  const cached = audioCache.get(text);
  if (cached) return cached;
  const attempt = async (): Promise<Blob | null> => {
    for (let tries = 0; tries < 3; tries++) {
      let response: Response;
      try {
        response = await fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
      } catch {
        await sleep(500);
        continue;
      }
      if (response.ok) return response.blob();
      if (response.status === 429) {
        const body = (await response.json().catch(() => ({}))) as { retryAfter?: number };
        const wait = Math.min(MAX_RETRY_WAIT_MS, Math.max(1, body.retryAfter ?? 10) * 1000);
        quotaCooldownUntil = Date.now() + wait;
        await sleep(wait);
        continue;
      }
      if (response.status === 502) {
        await sleep(500);
        continue;
      }
      return null;
    }
    return null;
  };
  const pending = attempt().then((blob) => {
    // A failure is not remembered: the next attempt should try again, not be
    // told "no" by a request that failed on a flaky connection.
    if (!blob) audioCache.delete(text);
    return blob;
  });
  audioCache.set(text, pending);
  if (audioCache.size > AUDIO_CACHE_LIMIT) {
    const oldest = audioCache.keys().next().value;
    if (oldest !== undefined) audioCache.delete(oldest);
  }
  return pending;
}

/** Test seam — no production caller. */
export function resetAudioCache(): void {
  audioCache.clear();
  quotaCooldownUntil = 0;
}

/** One spoken answer, from the first clause of the stream to the last. */
interface SpeechJob {
  turn: number;
  /** Clause synthesis in paper order. The fetch for each one starts the
   * moment the clause becomes final, not when its turn to play comes up, so
   * by the time clause 1 has finished playing clause 2 is usually already
   * audio sitting in memory. */
  /** Synthesis is started lazily, a few clauses ahead of the one playing —
   * see PREFETCH_DEPTH — so `audio` is null until this clause is close
   * enough to the front to be worth paying for. */
  clauses: { text: string; audio: Promise<string | null> | null }[];
  /** The clause the player is on. What "ahead" is measured from. */
  playing: number;
  /** The cloud voice has already been heard in this answer. From then on a
   * failed piece is skipped, never handed to a different voice: the one
   * outcome the student noticed and objected to was the tutor turning into
   * someone else half way through a sentence. */
  voiced: boolean;
  /** How many clauses have been taken off the stream so far. */
  taken: number;
  /** The stream has ended and `clauses` is the whole answer. */
  complete: boolean;
  /** The player loop is already running for this job. */
  draining: boolean;
  waiter: { promise: Promise<void>; wake: () => void };
}

/** Speak an answer, a clause at a time, with the browser voice as the net.
 *
 * Clause at a time because the whole reply is the wrong unit, and because
 * synthesis is the slowest thing left in a spoken turn. Measured against the
 * live voice on 2026-09-18, one clause at a time:
 *
 *   6 chars   2.6s      30 chars   4.3s
 *   12 chars  3.0s      69 chars   6.0s
 *
 * — so a short first clause is heard a second and a half sooner than a long
 * one, and every clause after it is covered by the audio already playing.
 *
 * The turn is fed as it STREAMS rather than when it finishes, which is the
 * other half of the same idea and the larger half. Synthesis and generation
 * are both slow and they are not related to each other, so running them one
 * after the other spends the sum where running them together spends only the
 * larger. See `readyClauses` for what makes a clause safe to send early.
 *
 * Three measured facts decide the shape below:
 *
 *   - The first clause is the only one the student waits for in silence. It
 *     is sent the instant it is final.
 *   - Synthesis of a 30-character clause (4.3s) outlasts playback of a
 *     12-character one (2.0s), so a queue that only ever fetches one clause
 *     ahead leaves dead air in the middle of a reply — measured at up to
 *     812ms between clauses. Fetches start as clauses arrive instead of one
 *     at a time, so several are usually in flight at once.
 *   - None of this is worth a second voice. Groq serves TTS now and would
 *     answer far faster than Gemini, but only in English and Arabic; this
 *     tutor teaches Japanese and speaks in one voice on purpose.
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
  const jobRef = useRef<SpeechJob | null>(null);
  const onDoneRef = useRef(options.onDone);
  onDoneRef.current = options.onDone;

  const release = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
    audioRef.current = null;
  }, []);

  const stop = useCallback(() => {
    turnRef.current += 1;
    // Waking the abandoned job lets its player loop reach its turn check and
    // return, instead of sitting on a promise nobody will ever resolve.
    jobRef.current?.waiter.wake();
    jobRef.current = null;
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
      // One voice for every run of the reply. `lang` and `rate` still vary per
      // run — they are pronunciation and pacing hints, not a change of
      // speaker — but `voice` does not, which is the whole point.
      const voice = fallbackVoice();
      segments.forEach((segment, index) => {
        const utterance = new SpeechSynthesisUtterance(segment.text);
        if (voice) utterance.voice = voice;
        utterance.lang = segment.lang === "ja" ? "ja-JP" : "en-US";
        // A Japanese voice reading English is slower to start with; pushing it
        // faster than natural makes the accent harder to follow, not easier.
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

  /** One clause of audio as a playable URL, or null if it could not be had.
   * Served from the cache when a prefetch or an earlier playback got there
   * first; the URL is minted here so it can be released with this turn. */
  const fetchClause = useCallback(async (text: string): Promise<string | null> => {
    const blob = await synthesize(text);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    return url;
  }, []);

  const prefetch = useCallback((markdown: string) => {
    // Never while the service is over quota: the requests belong to students
    // who have actually pressed Listen.
    if (Date.now() < quotaCooldownUntil) return;
    const [first] = listenChunks(markdown);
    if (first) void synthesize(first);
  }, []);

  /** Start synthesis for the clauses close enough to the front to be worth
   * paying for, and no others. Idempotent: a clause already in flight keeps
   * the promise it has. */
  const pump = useCallback(
    (job: SpeechJob) => {
      const until = Math.min(job.clauses.length, job.playing + PREFETCH_DEPTH);
      for (let i = job.playing; i < until; i++) {
        job.clauses[i].audio ??= fetchClause(job.clauses[i].text);
      }
    },
    [fetchClause],
  );

  /** Play the queue in order, waiting for clauses that have not arrived yet.
   *
   * One loop per job, started by the first clause and living until the answer
   * is spoken or the student interrupts. Every await is followed by a turn
   * check, because all three of them — synthesis, playback and waiting on the
   * stream — can outlive the turn that started them.
   */
  const drain = useCallback(
    async (job: SpeechJob) => {
      if (job.draining) return;
      job.draining = true;

      let index = 0;
      while (true) {
        // Read the waiter BEFORE testing the condition, or a clause pushed
        // between the test and the await is a notification slept through.
        const more = job.waiter.promise;
        if (index >= job.clauses.length) {
          if (job.complete) break;
          await more;
          if (turnRef.current !== job.turn) return;
          continue;
        }

        // The window moves with the player rather than with the stream, so
        // the clause about to be spoken is always in flight and the ones far
        // behind it are never paid for.
        job.playing = index;
        pump(job);
        const url = await job.clauses[index].audio;
        if (turnRef.current !== job.turn) return;

        if (!url && job.voiced) {
          // Kore has already been speaking this answer and this piece failed
          // even after retrying. Skip it and carry on in the same voice: a
          // missing sentence is a smaller loss than the tutor turning into a
          // different person, which is what handing over to the browser's
          // voice here used to do.
          console.warn(`voice: skipped a piece after retries (${job.clauses[index].text.slice(0, 30)}…)`);
          index += 1;
          continue;
        }
        if (!url) {
          // The cloud voice never spoke in this answer — signed out, not
          // configured, or down — so the browser's voice reads ALL of it, and
          // it is one voice from start to finish. Only what is already queued
          // can be said here; if the stream is still running its tail is lost.
          setLoading(false);
          speakLocally(
            job.clauses
              .slice(index)
              .map((c) => c.text)
              .join(" "),
            job.turn,
          );
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
        if (turnRef.current !== job.turn) return;
        if (!played && job.voiced) {
          // Same rule as above: once Kore has been heard, never switch voice.
          index += 1;
          continue;
        }
        if (!played) {
          speakLocally(
            job.clauses
              .slice(index)
              .map((c) => c.text)
              .join(" "),
            job.turn,
          );
          return;
        }
        job.voiced = true;
        index += 1;
      }

      if (turnRef.current === job.turn) {
        setSpeaking(false);
        release();
        jobRef.current = null;
        onDoneRef.current?.();
      }
    },
    [pump, release, speakLocally],
  );

  /** Start a turn, discarding whatever was being said. */
  const begin = useCallback(
    (): SpeechJob => {
      turnRef.current += 1;
      if (audioRef.current) {
        audioRef.current.pause();
        release();
      }
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      setSpeaking(true);
      setLoading(true);
      const job: SpeechJob = {
        turn: turnRef.current,
        clauses: [],
        taken: 0,
        playing: 0,
        voiced: false,
        complete: false,
        draining: false,
        waiter: waiter(),
      };
      jobRef.current = job;
      return job;
    },
    [release],
  );

  /** Queue whatever has become final, and wake the player. */
  const feed = useCallback(
    (job: SpeechJob, markdownSoFar: string, done: boolean) => {
      for (const text of readyClauses(markdownSoFar, done, job.taken)) {
        job.taken += 1;
        // Started here rather than when the clause reaches the front of the
        // queue. This is the whole point of feeding the stream.
        job.clauses.push({ text, audio: null });
      }
      if (done) job.complete = true;
      // Only the front of the queue is started here; the player advances the
      // window as it goes.
      pump(job);
      job.waiter.wake();
      job.waiter = waiter();

      // An answer with nothing speakable in it — a table, a bare page
      // reference — must not leave the UI stuck on "speaking" forever.
      if (done && job.clauses.length === 0 && turnRef.current === job.turn) {
        setSpeaking(false);
        setLoading(false);
        jobRef.current = null;
        onDoneRef.current?.();
        return;
      }
      void drain(job);
    },
    [drain, pump],
  );

  const speakAsItArrives = useCallback(
    (markdownSoFar: string, done: boolean) => {
      // The first call of a turn opens the job and the rest top it up, told
      // apart by whether one is already open. So the caller hands over every
      // stream update without tracking which of them was the first.
      const job = jobRef.current ?? begin();
      feed(job, markdownSoFar, done);
    },
    [begin, feed],
  );

  /** A finished answer, spoken from the beginning: the Listen button on a
   * typed reply, which has no stream to follow. */
  const speak = useCallback(
    async (markdown: string) => {
      // In growing pieces rather than sentence by sentence — see
      // listenChunks — so a long answer costs about five requests of the
      // project's ten a minute rather than twenty.
      const pieces = listenChunks(markdown);
      if (pieces.length === 0) return;
      const job = begin();
      for (const text of pieces) job.clauses.push({ text, audio: null });
      job.taken = pieces.length;
      job.complete = true;
      pump(job);
      void drain(job);
    },
    [begin, drain, pump],
  );

  return { speaking, loading, speak, speakAsItArrives, prefetch, stop };
}
