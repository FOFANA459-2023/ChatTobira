"use client";

import { useCallback, useRef, useState } from "react";

import {
  useSpeechToText,
  useTextToSpeech,
  voicePhase,
  type VoiceError,
  type VoicePhase,
} from "./use-voice";

/** A spoken conversation that does not need Google.
 *
 * Speaking practice runs on Gemini Live: one open connection that listens and
 * talks at once. It is the best version of the page and it has exactly one
 * provider, so when the Google account cannot pay, the page had nothing to
 * offer but "the server's AI service is unavailable". The chat's microphone
 * never had that problem — it falls back to the older loop — but the speaking
 * page had no loop to fall back to.
 *
 * This is that loop, for a page with no chat transcript of its own:
 *
 *   microphone → /api/transcribe (Groq Whisper)
 *              → /api/chat as a spoken turn (whichever answer model is up)
 *              → the voice (Gemini TTS, or the browser's own when that fails)
 *              → the microphone again
 *
 * Slower than live by a couple of seconds a turn, and the student cannot talk
 * over the tutor mid-sentence quite as smoothly. It is still a conversation.
 */

export interface ClassicTurn {
  user: string;
  assistant: string;
}

export interface ClassicConversation {
  active: boolean;
  phase: VoicePhase;
  level: number;
  heard: string | null;
  error: VoiceError | null;
  notice: string | null;
  start: () => void;
  stop: () => void;
  interrupt: () => void;
}

interface Options {
  /** Sent with every turn, so the server keeps the call in one saved chat. */
  conversationId: () => number | undefined;
  /** What a new saved chat is called. */
  title: () => string;
  onTurn: (turn: ClassicTurn) => void;
  /** The server saved the call under this chat. */
  onConversation: (id: number) => void;
}

/** The parts of the chat route's stream this loop needs: the words, the chat
 * the turn was saved under, and a refusal if one arrives mid-stream. */
export interface StreamEvent {
  delta?: string;
  conversationId?: number;
  error?: string;
}

/** One SSE frame of an AI SDK UI message stream, reduced to what matters
 * here. Anything it does not recognise is nothing, not an error: the stream
 * carries framing chunks this loop has no use for. */
export function readStreamFrame(frame: string): StreamEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data || data === "[DONE]") return null;
  let chunk: {
    type?: string;
    delta?: string;
    errorText?: string;
    messageMetadata?: { conversationId?: number };
  };
  try {
    chunk = JSON.parse(data);
  } catch {
    return null;
  }
  const event: StreamEvent = {};
  if (chunk.type === "text-delta" && typeof chunk.delta === "string") event.delta = chunk.delta;
  if (chunk.type === "error") event.error = chunk.errorText ?? "error";
  const id = chunk.messageMetadata?.conversationId;
  if (typeof id === "number") event.conversationId = id;
  return Object.keys(event).length > 0 ? event : null;
}

export function useClassicConversation(options: Options): ClassicConversation {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const replyingRef = useRef(false);
  const [answerStarted, setAnswerStarted] = useState(false);
  const [error, setError] = useState<VoiceError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const historyRef = useRef<{ role: "user" | "assistant"; text: string }[]>([]);
  /** Cleared when the student talks over the reply: the rest of it still
   * arrives and is kept, but is not spoken over them. */
  const speakReplyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const tts = useTextToSpeech({
    // The tutor has finished; the student's turn. Nobody presses anything.
    onDone: () => {
      if (activeRef.current && !replyingRef.current) void sttRef.current?.start();
    },
  });

  const reply = useCallback(
    async (text: string) => {
      if (!activeRef.current || replyingRef.current) return;
      replyingRef.current = true;
      setReplying(true);
      setAnswerStarted(false);
      setHeard(text);
      speakReplyRef.current = true;
      historyRef.current = [...historyRef.current, { role: "user", text }];
      const controller = new AbortController();
      abortRef.current = controller;

      let answer = "";
      let failure: VoiceError | null = null;
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            messages: historyRef.current.map((turn, i) => ({
              id: `classic-${i}`,
              role: turn.role,
              parts: [{ type: "text", text: turn.text }],
            })),
            conversationId: optionsRef.current.conversationId(),
            title: optionsRef.current.title(),
            speaking: { mode: "free" },
          }),
        });
        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
          };
          if (body.message) setNotice(body.message);
          failure =
            body.error === "quota_exhausted"
              ? "quota"
              : body.error === "provider_refused" || body.error === "all_models_unavailable"
                ? "provider"
                : "network";
        } else {
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += value;
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const event = readStreamFrame(frame);
              if (!event) continue;
              if (event.conversationId) optionsRef.current.onConversation(event.conversationId);
              if (event.error) {
                setNotice(event.error);
                failure = "provider";
              }
              if (event.delta) {
                answer += event.delta;
                setAnswerStarted(true);
                if (speakReplyRef.current) tts.speakAsItArrives(answer, false);
              }
            }
          }
        }
      } catch (cause) {
        if ((cause as Error | null)?.name !== "AbortError") failure = "network";
      } finally {
        abortRef.current = null;
        replyingRef.current = false;
        setReplying(false);
      }

      if (answer.trim()) {
        historyRef.current = [...historyRef.current, { role: "assistant", text: answer }];
        optionsRef.current.onTurn({ user: text, assistant: answer });
        if (speakReplyRef.current && activeRef.current) {
          // Releases the last clause; onDone reopens the microphone.
          tts.speakAsItArrives(answer, true);
          return;
        }
      } else {
        // The question got no answer, so it is not part of the conversation
        // the next request describes.
        historyRef.current = historyRef.current.slice(0, -1);
      }
      if (failure && !answer.trim()) {
        setError(failure);
        return;
      }
      if (activeRef.current) void sttRef.current?.start();
    },
    [tts],
  );

  const stt = useSpeechToText((text) => void reply(text), {
    // Barge-in: the student talking is the end of the tutor's turn.
    onSpeechStart: () => {
      speakReplyRef.current = false;
      tts.stop();
    },
  });
  const sttRef = useRef(stt);
  sttRef.current = stt;

  const start = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;
    setActive(true);
    setError(null);
    setNotice(null);
    setHeard(null);
    historyRef.current = [];
    void sttRef.current.start();
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    abortRef.current?.abort();
    sttRef.current.cancel();
    tts.stop();
  }, [tts]);

  const interrupt = useCallback(() => {
    speakReplyRef.current = false;
    tts.stop();
    if (activeRef.current && !replyingRef.current) void sttRef.current.start();
  }, [tts]);

  return {
    active,
    phase: voicePhase({
      live: active,
      listenState: stt.state,
      hearing: stt.hearing,
      replying,
      answerStarted,
      speaking: tts.speaking,
      loadingAudio: tts.loading,
    }),
    level: stt.level,
    heard,
    error: error ?? stt.error,
    notice,
    start,
    stop,
    interrupt,
  };
}
