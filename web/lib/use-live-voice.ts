"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ConversationLanguage } from "./conversation";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToPcm16,
  downsample,
  floatToPcm16,
  freshDownsample,
  INPUT_RATE,
  LIVE_SILENCE_MS,
  LIVE_SOCKET_URL,
  LOOKUP_TOOL,
  OUTPUT_RATE,
  pcm16ToFloat,
  type DownsampleState,
  type LiveTurn,
} from "./live-voice";
import type { VoiceError, VoicePhase } from "./use-voice";

/* ------------------------------------------------------------------------ */
/* Microphone capture                                                        */
/* ------------------------------------------------------------------------ */

/** The capture worklet, as source, because a worklet module has to be a URL
 * and this one is small enough that a separate file would be the harder
 * thing to ship. It does nothing but batch the microphone into ~40ms pieces
 * and hand them to the page; resampling and encoding happen there, in code
 * that has tests. */
const CAPTURE_WORKLET = `
class TobiraCapture extends AudioWorkletProcessor {
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
registerProcessor("tobira-capture", TobiraCapture);
`;

/** Loudness thresholds, on the same 0–1 scale as the classic endpointer so
 * the orb behaves identically. These only drive what the SCREEN says; when a
 * turn ends is decided by the model's own voice activity detection. */
const SPEECH_LEVEL = 0.12;
/** Quiet for this long after speech, the screen says "thinking". Matched to
 * the model's own end-of-speech window (LIVE_SILENCE_MS): any shorter and a
 * pause after 「すみません、」 flickers the screen to "thinking" mid-sentence. */
const HEARING_HOLD_MS = LIVE_SILENCE_MS;
/** At most this much speech is held while connecting: 15s of 40ms pieces. */
const MAX_QUEUED = 375;

/* ------------------------------------------------------------------------ */
/* Playback                                                                   */
/* ------------------------------------------------------------------------ */

/** Plays the reply as it arrives, gaplessly.
 *
 * Every chunk the model sends is scheduled to start exactly where the last
 * one ends, on the audio clock rather than a timer, so there are no seams
 * between chunks however they arrive. The first chunk of a reply is given a
 * few tens of milliseconds of lead so that normal network jitter never
 * starves it. */
class PcmPlayer {
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  constructor(
    private context: AudioContext,
    private onIdle: () => void,
  ) {}

  get playing(): boolean {
    return this.sources.size > 0;
  }

  play(pcm: Int16Array): void {
    if (pcm.length === 0) return;
    const samples = pcm16ToFloat(pcm);
    const buffer = this.context.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.getChannelData(0).set(samples);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const at = Math.max(this.context.currentTime + 0.04, this.next);
    source.start(at);
    this.next = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.onIdle();
    };
  }

  /** Stop at once — the student started talking over it. */
  flush(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.next = 0;
  }
}

/* ------------------------------------------------------------------------ */
/* The conversation                                                           */
/* ------------------------------------------------------------------------ */

/** What starting a live conversation came to. `fallback` means the live
 * service could not be reached and the classic voice loop should take over;
 * the others are final. */
export type LiveStart = "live" | "fallback" | "failed";

export interface LiveConversation {
  active: boolean;
  phase: VoicePhase;
  level: number;
  /** What the student is saying, or last said, as the model heard it. */
  heard: string | null;
  error: VoiceError | null;
  start: (options: { language: ConversationLanguage; history: LiveTurn[] }) => Promise<LiveStart>;
  stop: () => void;
  /** Stop the current reply without ending the conversation. */
  interrupt: () => void;
}

interface ServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: { id: string; name: string; args?: { query?: string } }[] };
  toolCallCancellation?: { ids?: string[] };
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

/** Ask the server for a token. The status decides what the caller does next. */
async function requestToken(body: object): Promise<
  { ok: true; token: string; model: string } | { ok: false; status: number }
> {
  try {
    const response = await fetch("/api/voice/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { ok: false, status: response.status };
    const { token, model } = (await response.json()) as { token: string; model: string };
    return { ok: true, token, model };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Open a socket with a token and wait for the model to say it is ready. */
function openSocket(
  token: string,
  model: string,
  onMessage: (socket: WebSocket, message: ServerMessage) => void,
  onClose: (socket: WebSocket, event: CloseEvent) => void,
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
    }, 8000);
    // The token already fixes everything; the setup message only has to name
    // the model it was minted for.
    socket.onopen = () => socket.send(JSON.stringify({ setup: { model: `models/${model}` } }));
    socket.onmessage = (event) => {
      const message = decode(event.data);
      if (!message) return;
      if (message.setupComplete) give(socket);
      onMessage(socket, message);
    };
    socket.onerror = () => give(null);
    socket.onclose = (event) => {
      give(null);
      onClose(socket, event);
    };
  });
}

/** One spoken conversation over a live connection.
 *
 * `onTurn` receives each finished exchange — what the student said and what
 * the tutor said back, as the model transcribed both — so the caller can put
 * it in the transcript and save it.
 */
export function useLiveConversation(options: {
  onTurn: (turn: { user: string; assistant: string }) => void;
}): LiveConversation {
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState<string | null>(null);
  const [error, setError] = useState<VoiceError | null>(null);

  const onTurnRef = useRef(options.onTurn);
  onTurnRef.current = options.onTurn;

  const socketRef = useRef<WebSocket | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const downsampleRef = useRef<DownsampleState>(freshDownsample());
  const activeRef = useRef(false);
  const handleRef = useRef<string | null>(null);
  const reconnectingRef = useRef(false);
  const languageRef = useRef<ConversationLanguage>("ja");
  /** The exchange in progress: what the student has said and what the tutor
   * has said back, as the transcriptions arrive. */
  const pendingRef = useRef({ user: "", assistant: "" });
  /** Audio of the current reply is being dropped: the student pressed Skip. */
  const mutedRef = useRef(false);
  const cancelledCallsRef = useRef(new Set<string>());
  /** The model's current turn is a tool call. It completes like any other
   * turn, but with nothing said — the answer is a turn of its own after the
   * tool result goes back — so its completion must not end "thinking". It can
   * arrive before or after the tool result, depending on how fast the lookup
   * was. */
  const callTurnRef = useRef(false);
  /** Reached through a ref because the socket handlers are created before it
   * and must call the current one. */
  const reconnectRef = useRef<() => Promise<void>>(async () => {});
  // Voice activity on the page side, for the screen and for the latency log.
  const loudAtRef = useRef(0);
  const speechStartRef = useRef<number | null>(null);
  const speechEndRef = useRef<number | null>(null);
  /** Microphone audio captured before the connection is up, sent the moment
   * it is. Connecting takes a second or more — a token from our server, then
   * the model's own setup — and a student who starts talking as soon as they
   * press the button must not lose their first sentence to it. */
  const queuedRef = useRef<string[]>([]);

  /** Hand the finished exchange to the transcript. */
  const flushExchange = useCallback(() => {
    const { user, assistant } = pendingRef.current;
    if (user.trim() || assistant.trim()) {
      onTurnRef.current({ user: user.trim(), assistant: assistant.trim() });
    }
    pendingRef.current = { user: "", assistant: "" };
  }, []);

  const teardown = useCallback(() => {
    activeRef.current = false;
    reconnectingRef.current = false;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000);
    playerRef.current?.flush();
    playerRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    downsampleRef.current = freshDownsample();
    queuedRef.current = [];
    setActive(false);
    setConnecting(false);
    setSpeaking(false);
    setHearing(false);
    setAwaiting(false);
    setLookingUp(false);
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  /** Run the tutor's tool call: the same retrieval the typed chat uses. */
  const answerToolCall = useCallback(
    async (socket: WebSocket, calls: NonNullable<ServerMessage["toolCall"]>["functionCalls"]) => {
      setLookingUp(true);
      const responses = await Promise.all(
        (calls ?? []).map(async (call) => {
          if (call.name !== LOOKUP_TOOL) {
            return { id: call.id, name: call.name, response: { error: "unknown tool" } };
          }
          try {
            const response = await fetch("/api/voice/lookup", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ query: call.args?.query ?? "" }),
            });
            const body = (await response.json()) as object;
            return { id: call.id, name: call.name, response: body };
          } catch {
            return { id: call.id, name: call.name, response: { passages: [] } };
          }
        }),
      );
      setLookingUp(false);
      const live = responses.filter((r) => !cancelledCallsRef.current.has(r.id));
      if (live.length > 0 && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ toolResponse: { functionResponses: live } }));
        // The tutor is composing its answer now. The turn that carried the
        // call has already completed, so without this the screen would show
        // "listening" for the half second before the answer's audio arrives.
        setAwaiting(true);
      }
    },
    [],
  );

  const handleMessage = useCallback(
    (socket: WebSocket, message: ServerMessage) => {
      // A message from a socket that has been replaced is ignored, except the
      // one that tells us a replacement is needed.
      if (socket !== socketRef.current && !message.setupComplete) return;

      if (message.sessionResumptionUpdate?.newHandle && message.sessionResumptionUpdate.resumable !== false) {
        handleRef.current = message.sessionResumptionUpdate.newHandle;
      }

      const content = message.serverContent;
      if (content) {
        if (content.inputTranscription?.text) {
          // The student is talking again while the last reply is still in
          // hand: that reply is finished, whatever else happens.
          if (pendingRef.current.assistant.trim()) flushExchange();
          pendingRef.current.user += content.inputTranscription.text;
          setHeard(pendingRef.current.user.trim());
        }
        if (content.outputTranscription?.text) {
          pendingRef.current.assistant += content.outputTranscription.text;
        }
        for (const part of content.modelTurn?.parts ?? []) {
          const data = part.inlineData?.data;
          if (!data || mutedRef.current) continue;
          if (speechEndRef.current !== null) {
            console.info(
              `live turn: ${Math.round(performance.now() - speechEndRef.current)}ms from end of speech to first audio`,
            );
            speechEndRef.current = null;
          }
          setAwaiting(false);
          callTurnRef.current = false;
          setSpeaking(true);
          playerRef.current?.play(bytesToPcm16(base64ToBytes(data)));
        }
        if (content.interrupted) {
          // The model heard the student start talking. Stop now, not at the
          // end of the audio already queued.
          playerRef.current?.flush();
          setSpeaking(false);
          mutedRef.current = false;
          if (pendingRef.current.assistant.trim()) flushExchange();
        }
        if (content.turnComplete) {
          mutedRef.current = false;
          if (callTurnRef.current) callTurnRef.current = false;
          else setAwaiting(false);
          // Only a turn with a reply ends the exchange. The turn that carries
          // a tool call completes too, with nothing said yet.
          if (pendingRef.current.assistant.trim()) flushExchange();
        }
      }

      if (message.toolCall?.functionCalls?.length) {
        callTurnRef.current = true;
        setAwaiting(true);
        void answerToolCall(socket, message.toolCall.functionCalls);
      }
      for (const id of message.toolCallCancellation?.ids ?? []) cancelledCallsRef.current.add(id);

      if (message.goAway) void reconnectRef.current();
    },
    [answerToolCall, flushExchange],
  );

  const handleClose = useCallback((socket: WebSocket, event: CloseEvent) => {
    if (socket !== socketRef.current || !activeRef.current) return;
    // The server ended the connection underneath a live conversation. Carry
    // it on if it can be carried; otherwise say so.
    if (handleRef.current && !reconnectingRef.current) {
      void reconnectRef.current();
      return;
    }
    console.warn(`live voice closed: ${event.code} ${event.reason}`);
    setError("network");
    teardown();
  }, [teardown]);

  /** Move the conversation onto a fresh connection, keeping its context. The
   * microphone keeps running; the few hundred milliseconds of audio sent
   * while the new socket opens go to the old one, which is still listening. */
  const reconnect = useCallback(async () => {
    if (reconnectingRef.current || !activeRef.current) return;
    reconnectingRef.current = true;
    const minted = await requestToken({
      language: languageRef.current,
      resume: handleRef.current ?? undefined,
    });
    if (!minted.ok) {
      reconnectingRef.current = false;
      if (!activeRef.current) return;
      setError(minted.status === 429 ? "quota" : "network");
      teardown();
      return;
    }
    const next = await openSocket(minted.token, minted.model, handleMessage, handleClose);
    reconnectingRef.current = false;
    if (!activeRef.current) {
      next?.close(1000);
      return;
    }
    if (!next) {
      setError("network");
      teardown();
      return;
    }
    const previous = socketRef.current;
    socketRef.current = next;
    previous?.close(1000);
  }, [handleClose, handleMessage, teardown]);
  reconnectRef.current = reconnect;

  // A noise the model decided was not speech gets no reply at all, and the
  // screen must not sit on "thinking" forever waiting for one.
  useEffect(() => {
    if (!awaiting) return;
    const timer = setTimeout(() => setAwaiting(false), 6000);
    return () => clearTimeout(timer);
  }, [awaiting]);

  /** One batch of microphone audio: meter it, resample it, send it. */
  const onCapture = useCallback((samples: Float32Array) => {
    const context = contextRef.current;
    if (!context) return;

    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    const loudness = Math.min(1, peak * 2);
    setLevel(loudness);

    const now = performance.now();
    const player = playerRef.current;
    // The tutor's own voice can reach the microphone; while it is talking,
    // the screen trusts the model's barge-in signal instead of the meter.
    if (!player?.playing) {
      if (loudness > SPEECH_LEVEL) {
        loudAtRef.current = now;
        speechStartRef.current ??= now;
        setHearing(true);
      } else if (speechStartRef.current !== null && now - loudAtRef.current > HEARING_HOLD_MS) {
        setHearing(false);
        setAwaiting(true);
        speechEndRef.current = loudAtRef.current;
        speechStartRef.current = null;
      }
    }

    const { samples: resampled, state } = downsample(
      samples,
      context.sampleRate,
      INPUT_RATE,
      downsampleRef.current,
    );
    downsampleRef.current = state;
    if (resampled.length === 0) return;
    const pcm = floatToPcm16(resampled);
    const message = JSON.stringify({
      realtimeInput: {
        audio: {
          data: bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
          mimeType: `audio/pcm;rate=${INPUT_RATE}`,
        },
      },
    });
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    } else if (queuedRef.current.length < MAX_QUEUED) {
      queuedRef.current.push(message);
    }
  }, []);

  const start = useCallback(
    async ({ language, history }: { language: ConversationLanguage; history: LiveTurn[] }) => {
      if (activeRef.current) return "live" as const;
      if (
        typeof window === "undefined" ||
        typeof WebSocket === "undefined" ||
        typeof AudioContext === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        return "fallback" as const;
      }
      setError(null);
      setHeard(null);
      languageRef.current = language;
      handleRef.current = null;
      pendingRef.current = { user: "", assistant: "" };
      activeRef.current = true;
      setActive(true);
      setConnecting(true);

      // Created before the first await, inside the click that started this:
      // Safari will not let audio play from a context created any later.
      const context = new AudioContext();
      contextRef.current = context;
      void context.resume().catch(() => {});

      const began = performance.now();
      let tokenAt = 0;
      // The token is asked for first and not waited on: it is the slowest
      // thing here, and nothing about the microphone depends on it.
      const token = requestToken({ language, history }).then((minted) => {
        tokenAt = performance.now();
        return minted;
      });

      const [microphone, worklet] = await Promise.all([
        navigator.mediaDevices
          .getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          })
          .then(
            (stream) => ({ stream }) as const,
            (cause: unknown) => ({ failure: (cause as DOMException | null)?.name ?? "" }) as const,
          ),
        (async () => {
          const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
          try {
            await context.audioWorklet.addModule(url);
            return true;
          } catch {
            return false;
          } finally {
            URL.revokeObjectURL(url);
          }
        })(),
      ]);

      if (!activeRef.current) {
        if ("stream" in microphone) for (const track of microphone.stream.getTracks()) track.stop();
        return "failed" as const;
      }
      if (!("stream" in microphone)) {
        const name = microphone.failure;
        setError(
          name === "NotAllowedError" || name === "SecurityError"
            ? "permission"
            : name === "NotFoundError"
              ? "no_microphone"
              : "recording_failed",
        );
        teardown();
        return "failed" as const;
      }
      streamRef.current = microphone.stream;
      if (!worklet) {
        teardown();
        return "fallback" as const;
      }

      // The microphone is live from here: the student can start talking now,
      // and whatever they say before the connection is up is queued for it.
      queuedRef.current = [];
      playerRef.current = new PcmPlayer(context, () => setSpeaking(false));
      const source = context.createMediaStreamSource(microphone.stream);
      const capture = new AudioWorkletNode(context, "tobira-capture");
      capture.port.onmessage = (event: MessageEvent<Float32Array>) => onCapture(event.data);
      // A muted path to the output keeps the graph pulling on every browser.
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(capture).connect(sink).connect(context.destination);
      const micAt = performance.now();
      setConnecting(false);

      const minted = await token;
      if (!activeRef.current) return "failed" as const;
      if (!minted.ok) {
        if (minted.status === 429) {
          setError("quota");
          teardown();
          return "failed" as const;
        }
        // Not configured, not reachable: the classic loop still works.
        teardown();
        return "fallback" as const;
      }

      const socket = await openSocket(minted.token, minted.model, handleMessage, handleClose);
      if (!activeRef.current) {
        socket?.close(1000);
        return "failed" as const;
      }
      if (!socket) {
        teardown();
        return "fallback" as const;
      }
      socketRef.current = socket;
      // Everything said while connecting, in order, then live from here on.
      for (const message of queuedRef.current) socket.send(message);
      const caughtUp = queuedRef.current.length;
      queuedRef.current = [];
      const connectedAt = performance.now();
      console.info(
        `live voice: mic ${Math.round(micAt - began)}ms, token ${Math.round(tokenAt - began)}ms, ` +
          `connected ${Math.round(connectedAt - began)}ms (${caughtUp} pieces of early speech sent on)`,
      );

      return "live" as const;
    },
    [handleClose, handleMessage, onCapture, teardown],
  );

  const stop = useCallback(() => {
    if (pendingRef.current.user.trim() || pendingRef.current.assistant.trim()) flushExchange();
    teardown();
    setHeard(null);
  }, [flushExchange, teardown]);

  const interrupt = useCallback(() => {
    playerRef.current?.flush();
    mutedRef.current = true;
    setSpeaking(false);
  }, []);

  const phase: VoicePhase = !active
    ? "idle"
    : connecting
      ? "idle"
      : speaking
        ? "speaking"
        : hearing
          ? "hearing"
          : awaiting || lookingUp
            ? "thinking"
            : "listening";

  return { active, phase, level, heard, error, start, stop, interrupt };
}
