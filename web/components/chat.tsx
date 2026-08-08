"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRef, useState } from "react";

import { Citations } from "@/components/citations";
import { FeedbackButtons } from "@/components/feedback-buttons";
import { MicButton } from "@/components/mic-button";
import { NavBar } from "@/components/nav";
import { ScopePicker } from "@/components/scope-picker";
import type { Citation, StudyScope } from "@/lib/retrieval";

interface MessageMeta {
  citations?: Citation[];
  model?: string;
  conversationId?: number;
}

export function Chat({ firstName }: { firstName?: string | null }) {
  const [scope, setScope] = useState<StudyScope>({});
  const [input, setInput] = useState("");
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // Set by the first answer's metadata; later turns append to the same
  // conversation row so history and feedback attach correctly.
  const conversationRef = useRef<number | undefined>(undefined);

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // Read from refs so mid-conversation changes apply immediately.
      body: () => ({
        scope: scopeRef.current,
        conversationId: conversationRef.current,
      }),
    }),
    onFinish: ({ message }) => {
      const meta = (message.metadata ?? {}) as MessageMeta;
      if (meta.conversationId) conversationRef.current = meta.conversationId;
    },
  });

  const busy = status === "submitted" || status === "streaming";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text });
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col">
      <NavBar active="chat">
        <ScopePicker scope={scope} onChange={setScope} />
      </NavBar>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-6">
        {messages.length === 0 && (
          <div className="mt-16 text-center text-stone-500">
            <p lang="ja" className="text-xl">
              {firstName ? `${firstName}さん、何を勉強しますか？` : "何を勉強しますか？"}
            </p>
            <p className="mt-2 text-sm">
              Ask about grammar, vocabulary, or kanji from your course. Answers
              cite the textbook page they come from.
            </p>
          </div>
        )}

        {messages.map((message) => {
          const meta = (message.metadata ?? {}) as MessageMeta;
          return (
            <div
              key={message.id}
              className={
                message.role === "user"
                  ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-stone-900 px-4 py-2.5 text-sm text-white"
                  : "max-w-[85%] rounded-2xl rounded-bl-sm border border-stone-200 bg-white px-4 py-3 text-sm shadow-sm"
              }
            >
              {message.parts.map((part, index) =>
                part.type === "text" ? (
                  <p key={index} className="whitespace-pre-wrap leading-relaxed">
                    {part.text}
                  </p>
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

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {/quota/i.test(error.message)
              ? "You have reached today's question limit. It resets at midnight, Japan time."
              : "Something went wrong answering that. Please try again."}
          </div>
        )}
      </div>

      <form
        onSubmit={submit}
        className="flex gap-2 border-t border-stone-200 bg-white px-4 py-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="質問をどうぞ — ask in Japanese or English"
          className="flex-1 rounded-xl border border-stone-300 px-4 py-2.5 text-sm outline-none focus:border-stone-500"
        />
        <MicButton
          disabled={busy}
          onTranscript={(text) =>
            setInput((current) => (current ? `${current} ${text}` : text))
          }
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ""}
          className="rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
        >
          {busy ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
