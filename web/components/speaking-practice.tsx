"use client";

import { useRef, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { VoiceSession } from "@/components/voice-session";
import type { ConversationLanguage } from "@/lib/conversation";
import type { ConversationSummary } from "@/lib/history";
import type { ShellUser } from "@/lib/shell";
import { useLiveConversation } from "@/lib/use-live-voice";

interface Book {
  id: number;
  title: string;
}

/** The tutor opens in English, greets the student by name, and from its
 * second turn speaks whichever language the student answered in. So this is
 * the language of the FIRST turn only, not of the conversation, and there is
 * nothing here for the student to set. */
const OPENING_LANGUAGE: ConversationLanguage = "en";

/** Speaking practice: read what you can ask for, press the button, say it.
 *
 * There is no picker. What a student wants to practise is a sentence —
 * 「トピック8の練習をしたいです」, "can we go over the te-form?" — and asking
 * them to assemble it out of a radio group, a dropdown and a text box turns
 * starting a conversation into filling in a form. The page says in writing
 * what they can ask for; the asking happens out loud, which is the thing
 * they came here to practise.
 *
 * The audio is not new. It is the same live connection the chat's microphone
 * opens — the same hook, the same session route, the same screen while the
 * call is running.
 */
export function SpeakingPractice({
  firstName,
  books,
  user,
  conversations: initialConversations = [],
}: {
  firstName: string | null;
  books: Book[];
  /** Who the sidebar belongs to. The page is signed-in only, so absent means
   * a student known only by their first name. */
  user?: ShellUser | null;
  conversations?: ConversationSummary[];
}) {
  const shellUser: ShellUser | null =
    user !== undefined ? user : { name: firstName, email: null, isAdmin: false };
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  /** What was said, so the student can read back what they managed to say
   * once the microphone is off. The chat's microphone puts its turns into the
   * chat transcript; this page has none, and throwing them away would make
   * the practice unreviewable. */
  const [turns, setTurns] = useState<{ user: string; assistant: string }[]>([]);

  /** Each call is saved as a chat of its own, so it is listed under Recents
   * and can be reopened and read back like any other. */
  const [conversations, setConversations] = useState(initialConversations);
  const [savedId, setSavedId] = useState<number | null>(null);
  const conversationRef = useRef<number | undefined>(undefined);
  const titleRef = useRef("Speaking practice");
  /** Saves go out one at a time. Two turns saved at once would each find no
   * conversation yet and each create one, splitting a call across two chats. */
  const saving = useRef<Promise<void>>(Promise.resolve());

  function save(turn: { user: string; assistant: string }) {
    saving.current = saving.current.then(async () => {
      try {
        const response = await fetch("/api/voice/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: conversationRef.current,
            user: turn.user,
            assistant: turn.assistant,
            title: titleRef.current,
          }),
        });
        if (!response.ok) return;
        const { conversationId } = (await response.json()) as { conversationId?: number };
        if (!conversationId || conversationRef.current === conversationId) return;
        conversationRef.current = conversationId;
        setSavedId(conversationId);
        setConversations((all) => [
          { id: conversationId, title: titleRef.current, createdAt: new Date().toISOString() },
          ...all.filter((c) => c.id !== conversationId),
        ]);
      } catch {
        // The transcript is on screen either way; a lost save loses the
        // record, never the conversation.
      }
    });
  }

  const live = useLiveConversation({
    onTurn: (turn) => {
      setTurns((all) => [...all, turn]);
      save(turn);
    },
  });

  /** Called straight from the button press: Safari will not let audio play
   * from an AudioContext created any later than the click that asked for it. */
  function start() {
    setFailed(false);
    setStarting(true);
    setTurns([]);
    // A new call is a new chat, named for when it happened.
    conversationRef.current = undefined;
    setSavedId(null);
    titleRef.current = speakingTitle(new Date());
    void live
      .start({ language: OPENING_LANGUAGE, history: [], opening: true })
      .then((result) => {
        // Anything but a live connection ends here. The chat falls back to
        // the classic record-upload-speak loop, but that loop writes its
        // replies into a transcript, and this page has none to write into —
        // so a student is told plainly instead of left with a dead button.
        if (result !== "live") setFailed(true);
      })
      .catch(() => setFailed(true))
      .finally(() => setStarting(false));
  }

  if (live.active) {
    return (
      <div className="flex min-h-viewport flex-col">
        <VoiceSession
          phase={live.phase}
          level={live.level}
          language={OPENING_LANGUAGE}
          heard={live.heard}
          error={live.error}
          realtime
          secondsLeft={live.secondsLeft}
          errorDetail={live.notice}
          onEnd={live.stop}
          onInterrupt={live.interrupt}
        />
      </div>
    );
  }

  return (
    <AppShell page="speaking" user={shellUser} conversations={conversations}>
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">

      <div className="flex-1 px-4 py-8">
        <div className="text-center">
          <p lang="ja" className="text-xl text-stone-600">
            話す練習をしましょう
          </p>
          <h1 className="mt-1 text-lg font-semibold tracking-tight">
            {firstName ? `Speaking practice, ${firstName}` : "Speaking practice"}
          </h1>
        </div>

        <div className="mt-6 space-y-3 text-sm leading-relaxed text-stone-600">
          <p>
            Talk out loud with a tutor that has read your textbooks and class materials. It answers in
            about a second, and you can interrupt it the way you would a person.
          </p>
          <p>
            <span className="font-medium text-stone-800">
              Press the button, then say what you want to work on.
            </span>{" "}
            There is nothing to fill in first. Asking for what you want is itself the
            practice.
          </p>
        </div>

        <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-medium text-stone-800">You can ask for</h2>

          <div className="mt-3 space-y-5 text-sm leading-relaxed text-stone-600">
            <div>
              <p>
                <span className="font-medium text-stone-800">
                  Anything from your textbooks.
                </span>{" "}
                A topic, a grammar point, or the vocabulary from one lesson. The tutor
                looks it up in the book before it answers.
              </p>
              {books.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-stone-500 marker:text-stone-300">
                  {books.map((book) => (
                    <li key={book.id}>{book.title}</li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-stone-400">
                <span lang="ja">「トピック8の練習をしたいです」</span>
                <br />
                &ldquo;Can we go over the te form?&rdquo;
              </p>
            </div>

            <div>
              <p>
                <span className="font-medium text-stone-800">
                  Anything else you want to get better at saying.
                </span>{" "}
                Your weekend, your classes, a speech you have coming up. Or nothing
                in particular: start talking and it will follow you.
              </p>
              <p className="mt-2 text-stone-400">
                <span lang="ja">「週末のことを話したいです」</span>
                <br />
                &ldquo;I want to practise introducing myself.&rdquo;
              </p>
            </div>
          </div>
        </div>

        {/* The whole point of the page: one round button in the middle of it,
            and the click that opens the microphone — which is also the click
            Safari requires the audio to start from. */}
        <div className="mt-8 flex flex-col items-center">
          <button
            type="button"
            onClick={start}
            disabled={starting}
            aria-label="Start speaking"
            className="flex h-40 w-40 flex-col items-center justify-center gap-1.5 rounded-full bg-stone-900 text-white shadow-lg transition hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-stone-300 disabled:opacity-60"
          >
            <MicGlyph />
            <span className="text-base font-medium">
              {starting ? "Connecting…" : "Start"}
            </span>
          </button>

          <p className="mt-4 text-center text-xs text-stone-400">
            Counts against your ten minutes of conversation per five hours.
          </p>
        </div>

        {/* The hook's own sentence when it has one — out of minutes names the
            time they come back — and a plain one when the failure was the
            browser or the connection rather than the account. */}
        {(failed || live.notice) && (
          <p className="mt-4 text-center text-sm text-red-700">
            {live.notice ??
              "A spoken conversation could not be started. Check that the microphone is allowed, and try again."}
          </p>
        )}

        {turns.length > 0 && (
          <div className="mt-10 border-t border-stone-200 pt-6">
            <h2 className="text-sm font-medium text-stone-800">What you just said</h2>
            <p className="mt-0.5 text-xs text-stone-500">
              Your last conversation, as the tutor heard it.
              {savedId !== null && (
                <>
                  {" "}Saved to your chats —{" "}
                  <a href={`/?c=${savedId}`} className="underline hover:text-stone-800">
                    open it
                  </a>
                  .
                </>
              )}
            </p>
            <div className="mt-3 space-y-3">
              {turns.map((turn, i) => (
                <div key={i} className="space-y-1.5">
                  {turn.user && (
                    <p
                      lang="ja"
                      className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-stone-900 px-4 py-2 text-sm text-white"
                    >
                      {turn.user}
                    </p>
                  )}
                  {turn.assistant && (
                    <p
                      lang="ja"
                      className="max-w-[95%] rounded-2xl rounded-bl-sm border border-stone-200 bg-white px-4 py-2 text-sm shadow-sm"
                    >
                      {turn.assistant}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
    </AppShell>
  );
}

/** "Speaking practice 9/22 14:05": which call it was, at a glance in the list. */
export function speakingTitle(at: Date): string {
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `Speaking practice ${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

function MicGlyph() {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}
