"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import Link from "next/link";
import { useRef, useState } from "react";

import { Answer } from "@/components/answer";
import { Citations } from "@/components/citations";
import { FeedbackButtons } from "@/components/feedback-buttons";
import { MagicLinkForm } from "@/components/magic-link-form";
import { MicButton } from "@/components/mic-button";
import { NavBar } from "@/components/nav";
import { UploadButton, type AttachedFile } from "@/components/upload-button";
import type { Citation } from "@/lib/retrieval";
import type { CourseLevel } from "@/lib/uploads";

interface MessageMeta {
  citations?: Citation[];
  model?: string;
  conversationId?: number;
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
  // Files stay attached across turns: a student asks several questions about
  // one worksheet, and re-picking it for each would be absurd.
  const [attached, setAttached] = useState<AttachedFile[]>([]);
  const attachedRef = useRef<AttachedFile[]>([]);
  attachedRef.current = attached;
  // Set by the first answer's metadata; later turns append to the same
  // conversation row so history and feedback attach correctly.
  const conversationRef = useRef<number | undefined>(undefined);

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // Read from a ref so the id set mid-conversation applies immediately.
      body: () => ({
        conversationId: conversationRef.current,
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
    },
  });

  const busy = status === "submitted" || status === "streaming";
  const trialExhausted =
    !authenticated && /trial_exhausted/.test(error?.message ?? "");

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
              {message.role === "assistant" && (
                <>
                  <Citations citations={meta.citations ?? []} />
                  {message.id === messages.at(-1)?.id && !busy && (
                    <FeedbackButtons conversationId={meta.conversationId} />
                  )}
                </>
              )}
            </div>
          );
        })}

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

          <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="質問をどうぞ — ask in Japanese or English"
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
            <MicButton
              disabled={busy}
              onTranscript={(text) =>
                setInput((current) => (current ? `${current} ${text}` : text))
              }
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
