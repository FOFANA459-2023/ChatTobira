"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Answer } from "@/components/answer";
import { FeedbackButtons } from "@/components/feedback-buttons";
import { MagicLinkForm } from "@/components/magic-link-form";
import { VoiceInput } from "@/components/voice-input";
import { NavBar } from "@/components/nav";
import { UploadButton, type AttachedFile } from "@/components/upload-button";
import type { Citation } from "@/lib/retrieval";
import type { CourseLevel } from "@/lib/uploads";
import { SPEAKING_MODES, type SpeakingMode } from "@/lib/speech";
import { useSpeechToText, useTextToSpeech } from "@/lib/use-voice";

interface MessageMeta {
  citations?: Citation[];
  model?: string;
  conversationId?: number;
}

/** What the student sees between pressing Send and the first word arriving.
 *
 * That gap is not instant — the question is embedded, the corpus is searched
 * across every book, and only then does a model start writing — and the chat
 * used to show nothing at all for it, which reads as a broken app rather than
 * a working one. The label says what is actually happening, and moves on when
 * the work does. */
function Thinking() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    // Long enough that a fast answer never shows the second label; short
    // enough that a slow one does not sit under a stale word.
    const timer = setTimeout(() => setPhase(1), 1800);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex max-w-[95%] items-center gap-2.5 rounded-2xl rounded-bl-sm border border-stone-200 bg-white px-4 py-3 text-sm text-stone-500 shadow-sm"
    >
      <span className="inline-flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400 motion-reduce:animate-none"
            style={{ animationDelay: `${dot * 0.15}s` }}
          />
        ))}
      </span>
      {phase === 0 ? "Looking through your course material…" : "Writing your answer…"}
    </div>
  );
}

export function Chat({
  firstName,
  isAdmin = false,
  authenticated = true,
  level = null,
}: {
  firstName?: string | null;
  isAdmin?: boolean;
  authenticated?: boolean;
  level?: CourseLevel | null;
}) {
  const [input, setInput] = useState("");
  // Speaking practice: the same conversation, entered by voice and read back
  // aloud. Off by default — a student who came to look something up should
  // not have their answer spoken at them.
  const [speakingPractice, setSpeakingPractice] = useState(false);
  const [speakingMode, setSpeakingMode] = useState<SpeakingMode>("free");
  // Which user turns arrived by voice, so the transcript is shown as the
  // spoken message it was rather than looking like something they typed.
  const [spokenTurns, setSpokenTurns] = useState<Set<string>>(() => new Set());
  const awaitingSpokenId = useRef(false);
  // Read inside the transport body, which is built once.
  const practiceRef = useRef({ on: false, mode: "free" as SpeakingMode });
  practiceRef.current = { on: speakingPractice, mode: speakingMode };
  // Whether the turn now being answered came by voice, so only those replies
  // are spoken. A typed question in the middle of a spoken conversation gets
  // a written answer, which is what typing one means.
  const replyShouldSpeak = useRef(false);
  // Files stay attached across turns: a student asks several questions about
  // one worksheet, and re-picking it for each would be absurd.
  const [attached, setAttached] = useState<AttachedFile[]>([]);
  const attachedRef = useRef<AttachedFile[]>([]);
  attachedRef.current = attached;
  // Set by the first answer's metadata; later turns append to the same
  // conversation row so history and feedback attach correctly.
  const conversationRef = useRef<number | undefined>(undefined);

  const tts = useTextToSpeech();

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // Read from a ref so the id set mid-conversation applies immediately.
      body: () => ({
        conversationId: conversationRef.current,
        // The one thing voice changes about the request. Retrieval, history,
        // scope and grounding are untouched: this only tells the tutor it is
        // being listened to rather than read.
        speaking: practiceRef.current.on
          ? { mode: practiceRef.current.mode, level }
          : undefined,
        // Only files that actually extracted carry context; one still
        // uploading would just be an id the server finds nothing for.
        uploadIds: attachedRef.current
          .filter((f) => f.status === "ready")
          .map((f) => f.id),
      }),
    }),
    onFinish: ({ message }) => {
      const meta = (message.metadata ?? {}) as MessageMeta;
      if (meta.conversationId) conversationRef.current = meta.conversationId;
      // The other half of the conversation. Only turns that arrived by voice
      // are spoken back, and a failure to speak is silent by design: the
      // answer is already on screen, and the useTextToSpeech fallback has
      // tried the browser's own voice before giving up.
      if (!replyShouldSpeak.current) return;
      replyShouldSpeak.current = false;
      const said = message.parts
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (said.trim()) void tts.speak(said);
    },
  });

  const voice = useSpeechToText((text) => {
    // Straight into the same pipeline a typed question uses. No separate
    // conversation, no separate retrieval — sendMessage is the identical
    // call the form makes, so history and context carry across freely.
    if (busyRef.current) return;
    awaitingSpokenId.current = true;
    replyShouldSpeak.current = practiceRef.current.on;
    tts.stop();
    void sendMessage({ text });
  });

  const busy = status === "submitted" || status === "streaming";
  // The transcript callback closes over its first render; a ref keeps it
  // honest about whether a request is already in flight.
  const busyRef = useRef(false);
  busyRef.current = busy;
  const last = messages.at(-1);
  const answerStarted =
    last?.role === "assistant" &&
    last.parts.some((part) => part.type === "text" && part.text.length > 0);
  const pending = busy && !answerStarted;
  const trialExhausted =
    !authenticated && /trial_exhausted/.test(error?.message ?? "");

  // The transcript's message id is only knowable once useChat has added it,
  // so the turn is tagged on the render after it appears.
  useEffect(() => {
    if (!awaitingSpokenId.current) return;
    const spoken = [...messages].reverse().find((message) => message.role === "user");
    if (!spoken) return;
    awaitingSpokenId.current = false;
    setSpokenTurns((all) => new Set(all).add(spoken.id));
  }, [messages]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text });
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col">
      <NavBar active="chat" authenticated={authenticated}>
        {isAdmin && (
          <Link
            href="/admin"
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100"
          >
            Invite students
          </Link>
        )}
      </NavBar>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-6">
        {messages.length === 0 && (
          <div className="mx-auto mt-16 max-w-xl text-center text-stone-500">
            <p className="text-xl font-medium text-stone-700">
              {firstName
                ? `Welcome to ChatTobira, ${firstName}!`
                : "Welcome to ChatTobira"}
            </p>
            <p lang="ja" className="mt-1 text-lg">
              {firstName
                ? `${firstName}さん、ChatTobiraへようこそ！`
                : "ChatTobiraへようこそ"}
            </p>
            <p className="mt-4 text-sm leading-relaxed">
              ChatTobira is built to assist students using textbooks, past
              quizzes and examinations, and other course materials from
              Ritsumeikan Asia Pacific University (APU). Because these
              materials are copyright-protected, ChatTobira does not store or
              retain your chat conversations on the platform.
            </p>
            <p className="mt-2 text-sm leading-relaxed">
              You are welcome to take notes or save your own study materials
              for personal review later.
            </p>
            {!authenticated && (
              <p className="mt-3 text-xs text-stone-400">
                You can try 3 questions free — after that, sign in with your
                invited email.
              </p>
            )}
          </div>
        )}

        {messages.map((message) => {
          const meta = (message.metadata ?? {}) as MessageMeta;
          return (
            <div
              key={message.id}
              className={
                message.role === "user"
                  ? "ml-auto max-w-[85%] break-words rounded-2xl rounded-br-sm bg-stone-900 px-4 py-2.5 text-sm text-white"
                  // Wider than a question bubble: an answer carries word
                  // lists and conjugation tables, and two columns of
                  // vocabulary inside 85% of the column wrap to shreds.
                  : "max-w-[95%] break-words rounded-2xl rounded-bl-sm border border-stone-200 bg-white px-4 py-3 text-sm shadow-sm"
              }
            >
              {message.role === "user" && spokenTurns.has(message.id) && (
                // What the app heard, shown as what it heard it as. A
                // mishearing is the student's to catch, and they can only
                // catch it if it is on the screen.
                <p className="mb-1 flex items-center gap-1 text-[11px] text-white/60">
                  <MicGlyph />
                  spoken
                </p>
              )}
              {message.parts.map((part, index) =>
                part.type === "text" ? (
                  message.role === "assistant" ? (
                    // Laid out like a page of the textbook. A question is
                    // the student's own words and stays exactly as typed.
                    <Answer key={index} text={part.text} />
                  ) : (
                    <p key={index} className="whitespace-pre-wrap leading-relaxed">
                      {part.text}
                    </p>
                  )
                ) : null,
              )}
              {message.role === "assistant" && !busy && (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <SpeakButton
                    text={message.parts
                      .filter((part): part is { type: "text"; text: string } => part.type === "text")
                      .map((part) => part.text)
                      .join("")}
                    tts={tts}
                  />
                  {message.id === messages.at(-1)?.id && (
                    <FeedbackButtons conversationId={meta.conversationId} />
                  )}
                </div>
              )}
            </div>
          );
        })}

        {pending && <Thinking />}

        {error && !trialExhausted && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {/quota/i.test(error.message)
              ? "You have reached today's question limit. It resets at midnight, Japan time."
              : "Something went wrong answering that. Please try again."}
          </div>
        )}
      </div>

      {trialExhausted ? (
        <div className="border-t border-stone-200 bg-white px-4 py-5">
          <div className="mx-auto max-w-sm">
            <p className="text-sm font-medium text-stone-800">
              You are out of free trial. Enter your email below and we will
              send you a sign-in link so you can keep studying.
            </p>
            <div className="mt-3">
              <MagicLinkForm showAdminLink />
            </div>
          </div>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="border-t border-stone-200 bg-white px-4 py-3"
        >
          {attached.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2">
              {attached.map((file) => (
                <li
                  key={file.id}
                  className={`flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                    file.status === "failed"
                      ? "border-red-200 bg-red-50 text-red-700"
                      : "border-stone-200 bg-stone-50 text-stone-700"
                  }`}
                >
                  <span className="truncate font-medium">{file.filename}</span>
                  <span className="shrink-0 text-stone-500">
                    {file.status === "uploading"
                      ? "uploading…"
                      : file.status === "reading"
                        ? "reading…"
                        : file.status === "failed"
                          ? (file.detail ?? "failed")
                          : (file.detail ?? "ready")}
                  </span>
                  {file.status === "ready" && (
                    <button
                      type="button"
                      title="Offer this to your teacher for the shared library. It stays private until they approve it."
                      onClick={() => {
                        setAttached((all) =>
                          all.map((f) =>
                            f.id === file.id
                              ? { ...f, detail: "sent to your teacher" }
                              : f,
                          ),
                        );
                        void fetch("/api/upload", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ id: file.id, action: "share" }),
                        });
                      }}
                      className="shrink-0 text-stone-400 underline decoration-dotted hover:text-stone-700"
                    >
                      share
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${file.filename}`}
                    onClick={() => {
                      setAttached((all) => all.filter((f) => f.id !== file.id));
                      void fetch("/api/upload", {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: file.id }),
                      });
                    }}
                    className="shrink-0 text-stone-400 hover:text-stone-700"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {authenticated && (
            // The one switch that changes what a spoken turn gets back: a
            // conversation partner rather than an explanation. Off by
            // default, because a student who came to look something up wants
            // the written answer they have always had.
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <label className="flex cursor-pointer items-center gap-1.5 text-stone-600">
                <input
                  type="checkbox"
                  checked={speakingPractice}
                  onChange={(e) => {
                    setSpeakingPractice(e.target.checked);
                    if (!e.target.checked) tts.stop();
                  }}
                  className="h-3.5 w-3.5 accent-stone-900"
                />
                <span lang="ja">会話練習</span>
                <span className="text-stone-400">Speaking practice</span>
              </label>
              {speakingPractice && (
                <>
                  <select
                    value={speakingMode}
                    onChange={(e) => setSpeakingMode(e.target.value as SpeakingMode)}
                    aria-label="Practice mode"
                    className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-xs outline-none focus:border-stone-500"
                  >
                    {Object.values(SPEAKING_MODES).map((mode) => (
                      <option key={mode.id} value={mode.id}>
                        {mode.labelJa} — {mode.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-stone-400">
                    Press the microphone and speak — I will reply in Japanese and read it back.
                  </span>
                </>
              )}
            </div>
          )}

          <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              speakingPractice
                ? "話しかけてください — or type your turn"
                : "質問をどうぞ — ask in Japanese or English"
            }
            className="flex-1 rounded-xl border border-stone-300 px-4 py-2.5 text-sm outline-none focus:border-stone-500"
          />
          {authenticated && (
            <UploadButton
              defaultLevel={level}
              disabled={busy}
              onAttached={(file) => setAttached((all) => [...all, file])}
              onUpdate={(id, patch) =>
                setAttached((all) =>
                  all.map((f) => (f.id === id ? { ...f, ...patch } : f)),
                )
              }
            />
          )}
          {authenticated && (
            <VoiceInput
              voice={voice}
              replying={busy}
              speaking={tts.speaking}
              onStopSpeaking={tts.stop}
            />
          )}
          <button
            type="submit"
            disabled={busy || input.trim() === ""}
            className="rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {busy ? "…" : "Send"}
          </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** A small mic glyph for the "this turn was spoken" label. */
function MicGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

/** Play any answer aloud, whether or not it arrived by voice.
 *
 * Separate from the conversation loop on purpose: a student reading a written
 * explanation often wants to HEAR the Japanese in it — that is most of what
 * listening practice is — and they should not have to re-ask by voice to get
 * it. The button is also the manual control the auto-play needs to be
 * acceptable: anything that starts talking on its own must be stoppable.
 */
function SpeakButton({
  text,
  tts,
}: {
  text: string;
  tts: ReturnType<typeof useTextToSpeech>;
}) {
  if (!text.trim()) return null;
  const busy = tts.speaking || tts.loading;
  return (
    <button
      type="button"
      onClick={() => (busy ? tts.stop() : void tts.speak(text))}
      className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-xs text-stone-400 hover:bg-stone-100 hover:text-stone-700"
      aria-label={busy ? "Stop reading this answer" : "Read this answer aloud"}
      title={busy ? "Stop" : "Read aloud"}
    >
      {busy ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M11 5 6 9H2v6h4l5 4V5Z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        </svg>
      )}
      {busy ? "Stop" : "Listen"}
    </button>
  );
}
