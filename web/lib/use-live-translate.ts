"use client";

/** The browser half of live translation: microphone in, readable text out,
 * while the speaker is still talking.
 *
 * It is deliberately NOT the speaking hook with a different prompt. The two
 * share their plumbing — the socket, the token, the 16kHz capture, all from
 * live-voice.ts — and nothing else, because they are doing opposite things.
 * Speaking practice is a conversation: it plays audio back, it interrupts,
 * it waits its turn. This listens and never speaks, so there is no playback
 * path, no barge-in, and no turn to take. Keeping them apart is also what
 * stops them fighting over the microphone, which is the one resource neither
 * can share.
 *
 * WHAT A SEGMENT IS. The model decides where speech stops, and each stretch
 * it decides about produces two things: a transcription of what was heard,
 * and a translation of it. Those two arrive interleaved and finish together
 * at `turnComplete`, so a segment is "everything between one turnComplete and
 * the next". Up to that point it is PROVISIONAL and is shown as such; after
 * it, it is finished and never rewritten. That rule is what keeps the screen
 * from flickering: finished text is never touched again, and only the last
 * line on screen is still moving.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  bytesToBase64,
  downsample,
  floatToPcm16,
  freshDownsample,
  INPUT_RATE,
  LIVE_SOCKET_URL,
  type DownsampleState,
} from "./live-voice";
import type { LanguageCode, SourceLanguage } from "./translate";

/* ------------------------------------------------------------------------ */
/* Capture                                                                    */
/* ------------------------------------------------------------------------ */

/** Its own processor name, so registering it cannot collide with the speaking
 * page's worklet if both have ever been opened in this tab. */
const CAPTURE_WORKLET = `
class TobiraTranslateCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * 0.04);
    this.buffer = new Float32Array(this.size);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i];
        if (this.filled === this.size) {
          this.port.postMessage(this.buffer.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("tobira-translate-capture", TobiraTranslateCapture);
`;

/* ------------------------------------------------------------------------ */
/* Wire shapes                                                                */
/* ------------------------------------------------------------------------ */

interface ServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    /** Spoken audio of the translation. Deliberately ignored — see
     * translateSetup for why this session asks for speech at all. */
    modelTurn?: { parts?: { inlineData?: unknown }[] };
    /** What the microphone heard. */
    inputTranscription?: { text?: string };
    /** THE TRANSLATION. With responseModalities AUDIO this is where the text
     * is; there is no text part to read. */
    outputTranscription?: { text?: string };
    turnComplete?: boolean;
  };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  goAway?: { timeLeft?: string };
}

function decode(data: unknown): ServerMessage | null {
  try {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    return JSON.parse(text) as ServerMessage;
  } catch {
    return null;
  }
}

export interface Segment {
  seq: number;
  /** What the microphone heard. */
  source: string;
  /** What it means. */
  translated: string;
  /** Milliseconds from the start of the session. */
  offsetMs: number;
}

export type TranslatePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "paused"
  | "ended"
  | "error";

export interface TranslateError {
  kind: "microphone" | "quota" | "network" | "config" | "unknown";
  message: string;
}

/** Above this many seconds left, the account is unmetered (the admin's) and
 * no countdown is shown. */
const UNMETERED_SECONDS = 24 * 60 * 60;
/** Move onto the next token this long before the current one expires. */
const RENEW_LEAD_MS = 6_000;
/** How many times a reconnection is tried, and the first pause between tries
 * (doubling after each). */
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_MS = 500;
/** Finished segments are written in batches: whichever of these comes first.
 * Small enough that a browser that dies loses a sentence, not a lecture. */
const SAVE_EVERY_SEGMENTS = 5;
const SAVE_EVERY_MS = 15_000;
/** The server refuses more than this in one write. */
const MAX_BATCH = 50;

type Minted =
  | { ok: true; token: string; model: string; expiresAt: number; remainingSeconds: number }
  | { ok: false; status: number; message?: string };

async function requestToken(body: object): Promise<Minted> {
  try {
    const response = await fetch("/api/translate/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { message?: string };
      return { ok: false, status: response.status, message: detail.message };
    }
    const minted = (await response.json()) as {
      token: string;
      model: string;
      expiresAt?: number;
      remainingSeconds?: number;
    };
    return {
      ok: true,
      token: minted.token,
      model: minted.model,
      expiresAt: minted.expiresAt ?? Date.now() + 60_000,
      remainingSeconds: minted.remainingSeconds ?? Number.MAX_SAFE_INTEGER,
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

function openSocket(
  token: string,
  model: string,
  onMessage: (message: ServerMessage) => void,
  onClose: () => void,
): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(`${LIVE_SOCKET_URL}?access_token=${encodeURIComponent(token)}`);
    socket.binaryType = "arraybuffer";
    const give = (value: WebSocket | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.close();
      give(null);
    }, 8_000);
    socket.onopen = () => socket.send(JSON.stringify({ setup: { model: `models/${model}` } }));
    socket.onmessage = (event) => {
      const message = decode(event.data);
      if (!message) return;
      if (message.setupComplete) give(socket);
      onMessage(message);
    };
    socket.onerror = () => give(null);
    socket.onclose = () => {
      give(null);
      onClose();
    };
  });
}

export interface LiveTranslation {
  phase: TranslatePhase;
  /** Finished segments, oldest first. Never rewritten once here. */
  segments: Segment[];
  /** The segment still being spoken, or null between segments. */
  pending: { source: string; translated: string } | null;
  error: TranslateError | null;
  /** Seconds of translation left, or null when the account is unmetered. */
  remainingSeconds: number | null;
  /** The conversation these segments are being saved into, once there is one. */
  conversationId: number | null;
  start: (options: { source: SourceLanguage; target: LanguageCode; subject?: string }) => void;
  pause: () => void;
  resume: () => void;
  end: () => void;
}

/** Sentence endings in every language this translates into, plus the CJK
 * full stops, since a target language may be Japanese or Chinese. */
/** A sentence ending, in any language this translates into. The CJK stops
 * are here because the TARGET may be Japanese or Chinese, not only the
 * source. Deliberately contains no backslash escapes — an earlier version
 * lost them in transit and silently matched nothing. */
const SENTENCE_END = /[.!?。．！？]["'”’)]?[ 	]*$/;

/** Dr., e.g., i.e. — a full stop that ends no sentence. One or two letters
 * before the stop, possibly repeated. Closing on these cuts a sentence in
 * half. */
const ABBREVIATION = /(?:^|[ (])(?:[A-Za-z]{1,2}[.])+$/;

/** Below this, a 'sentence' is a fragment. Eight characters clears every
 * abbreviation and still admits a short real sentence in any script. */
const MIN_SEGMENT_CHARS = 8;

/** A segment long enough to close on its own with no full stop in sight.
 * A lecturer who does not pause produces one unbroken clause, and a line
 * that never settles is a line that never gets saved. */
const RUNAWAY_CHARS = 320;

export function shouldClose(translated: string): boolean {
  const text = translated.trimEnd();
  if (!text) return false;
  if (text.length >= RUNAWAY_CHARS) return true;
  if (!SENTENCE_END.test(text)) return false;
  if (ABBREVIATION.test(text)) return false;
  // Counting WORDS here would have been the obvious guard and is wrong:
  // Japanese and Chinese have no spaces, so a finished sentence counts as
  // one word and would never close. Length works in every script.
  return text.length >= MIN_SEGMENT_CHARS;
}

export function useLiveTranslation(): LiveTranslation {
  const [phase, setPhase] = useState<TranslatePhase>("idle");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [pending, setPending] = useState<{ source: string; translated: string } | null>(null);
  const [error, setError] = useState<TranslateError | null>(null);
  const [remainingSeconds, setRemaining] = useState<number | null>(null);
  const [conversationId, setConversationId] = useState<number | null>(null);

  /* Everything below is a ref rather than state: it changes on every audio
   * block or socket frame, and re-rendering a ninety-minute transcript at
   * that rate is the one thing that would make this unusable. */
  const socketRef = useRef<WebSocket | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const downsampleRef = useRef<DownsampleState>(freshDownsample());
  const renewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** The live session's own state, read inside callbacks that must not close
   * over a stale render. */
  const optionsRef = useRef<{ source: SourceLanguage; target: LanguageCode; subject?: string }>({
    source: "auto",
    target: "en",
  });
  const resumeHandleRef = useRef<string | undefined>(undefined);
  const startedAtRef = useRef<number>(0);
  const seqRef = useRef(0);
  const draftRef = useRef<{ source: string; translated: string }>({ source: "", translated: "" });
  const unsavedRef = useRef<Segment[]>([]);
  const conversationRef = useRef<number | null>(null);
  /** Set while deliberately stopping, so an expected close is not reported as
   * a dropped connection. */
  const closingRef = useRef(false);
  const pausedRef = useRef(false);

  /* ---------------------------------------------------------------- saving */

  const flush = useCallback(async () => {
    const batch = unsavedRef.current.splice(0, MAX_BATCH);
    if (batch.length === 0) return;
    try {
      const response = await fetch("/api/translate/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationRef.current ?? undefined,
          sourceLang: optionsRef.current.source === "auto" ? undefined : optionsRef.current.source,
          targetLang: optionsRef.current.target,
          segments: batch.map((s) => ({
            seq: s.seq,
            source: s.source,
            translated: s.translated,
            offsetMs: s.offsetMs,
          })),
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const saved = (await response.json()) as { conversationId?: number };
      if (saved.conversationId && conversationRef.current === null) {
        conversationRef.current = saved.conversationId;
        setConversationId(saved.conversationId);
      }
    } catch {
      // Put them back at the front and try again on the next tick. A lecture
      // must survive a network blip without losing what it already heard, and
      // the upsert on (conversation_id, seq) makes a re-send harmless.
      unsavedRef.current.unshift(...batch);
    }
  }, []);

  /* ------------------------------------------------------------- the socket */

  const teardownSocket = useCallback(() => {
    if (renewTimerRef.current) clearTimeout(renewTimerRef.current);
    renewTimerRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
  }, []);

  /** Close the current segment and move it to the finished list. */
  const finishSegment = useCallback(() => {
    const draft = draftRef.current;
    draftRef.current = { source: "", translated: "" };
    setPending(null);
    if (!draft.source.trim() && !draft.translated.trim()) return;
    const segment: Segment = {
      seq: seqRef.current++,
      source: draft.source.trim(),
      translated: draft.translated.trim(),
      offsetMs: Math.max(0, Date.now() - startedAtRef.current),
    };
    setSegments((previous) => [...previous, segment]);
    unsavedRef.current.push(segment);
    if (unsavedRef.current.length >= SAVE_EVERY_SEGMENTS) void flush();
  }, [flush]);

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      if (message.sessionResumptionUpdate?.newHandle) {
        resumeHandleRef.current = message.sessionResumptionUpdate.newHandle;
      }
      const content = message.serverContent;
      if (!content) return;

      const heard = content.inputTranscription?.text;
      // The translation arrives on outputTranscription in fragments, a few
      // hundred milliseconds behind the matching fragment of the source.
      // modelTurn carries audio nobody plays and is dropped on the floor.
      const meant = content.outputTranscription?.text ?? "";
      if (!heard && !meant) {
        if (content.turnComplete) finishSegment();
        return;
      }
      draftRef.current = {
        source: draftRef.current.source + (heard ?? ""),
        translated: draftRef.current.translated + meant,
      };
      setPending({ ...draftRef.current });

      // WHERE A SEGMENT ENDS.
      //
      // The translate model never sends turnComplete. It is not answering
      // turns; it is interpreting a stream, and the stream does not stop
      // until the student does. Waiting for a turn that never comes would
      // leave one segment growing for ninety minutes, saved only at the end
      // and lost entirely if the tab closed.
      //
      // So a sentence ending in the TRANSLATION closes a segment, with
      // whatever source has arrived by then. The two run about a third of a
      // second apart, so the pairing is close but not exact — a word of the
      // source occasionally lands in the next segment. That is a cosmetic
      // cost in the smaller, secondary line, and the alternative is aligning
      // two streams that nothing promises are alignable.
      if (content.turnComplete || shouldClose(draftRef.current.translated)) {
        finishSegment();
      }
    },
    [finishSegment],
  );

  /** Open a connection, renewing the one before it if there was one. Returns
   * false when the session cannot continue — out of allowance, or the network
   * has gone for good. */
  const connect = useCallback(
    async (attempt = 0): Promise<boolean> => {
      const minted = await requestToken({
        source: optionsRef.current.source,
        target: optionsRef.current.target,
        subject: optionsRef.current.subject,
        resume: resumeHandleRef.current,
      });

      if (!minted.ok) {
        if (minted.status === 429) {
          setError({
            kind: "quota",
            message: minted.message ?? "You have used your live translation time for now.",
          });
          return false;
        }
        if (minted.status === 401) {
          setError({ kind: "config", message: "Please sign in again to keep translating." });
          return false;
        }
        // The server knows the feature is not switched on. Retrying cannot
        // help, and retrying silently is how this looked like a quota problem
        // in the first place.
        if (minted.status === 503) {
          setError({
            kind: "config",
            message: minted.message ?? "Live translation is not switched on for this server yet.",
          });
          return false;
        }
        if (attempt < RECONNECT_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS * 2 ** attempt));
          return connect(attempt + 1);
        }
        setError({
          kind: "network",
          message: "Lost the connection and could not get it back. What you have is saved.",
        });
        return false;
      }

      setRemaining(
        minted.remainingSeconds >= UNMETERED_SECONDS ? null : minted.remainingSeconds,
      );

      const previous = socketRef.current;
      const socket = await openSocket(minted.token, minted.model, handleMessage, () => {
        // An unexpected close mid-lecture: get back on, carrying the handle so
        // the new session still knows the lecture.
        if (closingRef.current || pausedRef.current) return;
        void connect();
      });
      if (!socket) {
        if (attempt < RECONNECT_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS * 2 ** attempt));
          return connect(attempt + 1);
        }
        setError({ kind: "network", message: "Could not reach the translation service." });
        return false;
      }

      socketRef.current = socket;
      // Only now close the one being replaced, so no audio falls between them.
      if (previous && previous !== socket) {
        previous.onclose = null;
        try {
          previous.close();
        } catch {
          /* already gone */
        }
      }

      if (renewTimerRef.current) clearTimeout(renewTimerRef.current);
      renewTimerRef.current = setTimeout(
        () => {
          if (!closingRef.current && !pausedRef.current) void connect();
        },
        Math.max(1_000, minted.expiresAt - Date.now() - RENEW_LEAD_MS),
      );
      return true;
    },
    [handleMessage],
  );

  /* -------------------------------------------------------------- the mic  */

  const openMicrophone = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError({ kind: "microphone", message: "This browser cannot reach a microphone." });
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          // A lecture is one voice across a room, not a phone call. Browser
          // noise suppression is tuned for the latter and eats a speaker at
          // the far end of a lecture theatre.
          noiseSuppression: false,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const context = new AudioContext();
      contextRef.current = context;
      const blob = new Blob([CAPTURE_WORKLET], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const source = context.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(context, "tobira-translate-capture");
      capture.port.onmessage = (event) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN || pausedRef.current) return;
        const { samples, state } = downsample(
          event.data as Float32Array,
          context.sampleRate,
          INPUT_RATE,
          downsampleRef.current,
        );
        downsampleRef.current = state;
        if (samples.length === 0) return;
        const pcm = floatToPcm16(samples);
        const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        socket.send(
          JSON.stringify({
            realtimeInput: {
              audio: { mimeType: `audio/pcm;rate=${INPUT_RATE}`, data: bytesToBase64(bytes) },
            },
          }),
        );
      };
      source.connect(capture);
      // Connected to the destination through a silent gain node: without a
      // path to the output some browsers never run the worklet at all, and
      // with a loud one the lecture comes back out of the laptop speakers.
      const mute = context.createGain();
      mute.gain.value = 0;
      capture.connect(mute).connect(context.destination);
      return true;
    } catch {
      setError({
        kind: "microphone",
        message: "ChatTobira needs permission to use the microphone.",
      });
      return false;
    }
  }, []);

  const closeMicrophone = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    downsampleRef.current = freshDownsample();
  }, []);

  /* ------------------------------------------------------------- controls  */

  const start = useCallback(
    (options: { source: SourceLanguage; target: LanguageCode; subject?: string }) => {
      if (phase === "connecting" || phase === "listening") return;
      optionsRef.current = options;
      closingRef.current = false;
      pausedRef.current = false;
      startedAtRef.current = Date.now();
      setError(null);
      setPhase("connecting");
      void (async () => {
        if (!(await openMicrophone())) {
          setPhase("error");
          return;
        }
        if (!(await connect())) {
          closeMicrophone();
          setPhase("error");
          return;
        }
        if (saveTimerRef.current) clearInterval(saveTimerRef.current);
        saveTimerRef.current = setInterval(() => void flush(), SAVE_EVERY_MS);
        setPhase("listening");
      })();
    },
    [phase, openMicrophone, connect, closeMicrophone, flush],
  );

  const pause = useCallback(() => {
    if (phase !== "listening") return;
    pausedRef.current = true;
    // The segment in flight is closed rather than abandoned: whatever has
    // already been heard and translated is kept.
    finishSegment();
    // The socket is let go rather than held. Holding it would keep renewing
    // tokens and spend a lecture's allowance on silence; the resumption handle
    // is what makes resuming the same session rather than a new one.
    teardownSocket();
    void flush();
    setPhase("paused");
  }, [phase, finishSegment, teardownSocket, flush]);

  const resume = useCallback(() => {
    if (phase !== "paused") return;
    pausedRef.current = false;
    setError(null);
    setPhase("connecting");
    void (async () => {
      if (!(await connect())) {
        setPhase("error");
        return;
      }
      setPhase("listening");
    })();
  }, [phase, connect]);

  const end = useCallback(() => {
    closingRef.current = true;
    pausedRef.current = true;
    finishSegment();
    teardownSocket();
    closeMicrophone();
    if (saveTimerRef.current) clearInterval(saveTimerRef.current);
    saveTimerRef.current = null;
    void flush();
    setPhase("ended");
  }, [finishSegment, teardownSocket, closeMicrophone, flush]);

  /** A tab closed mid-lecture still saves what it has. */
  useEffect(() => {
    const save = () => {
      if (unsavedRef.current.length > 0) void flush();
    };
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      closingRef.current = true;
      teardownSocket();
      closeMicrophone();
      if (saveTimerRef.current) clearInterval(saveTimerRef.current);
    };
  }, [flush, teardownSocket, closeMicrophone]);

  return {
    phase,
    segments,
    pending,
    error,
    remainingSeconds,
    conversationId,
    start,
    pause,
    resume,
    end,
  };
}
