"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AppShell } from "@/components/app-shell";
import type { ConversationSummary } from "@/lib/history";
import type { ShellUser } from "@/lib/shell";
import { LANGUAGES, type LanguageCode, type SourceLanguage } from "@/lib/translate";
import { useLiveTranslation } from "@/lib/use-live-translate";

/** Remembered between visits: a student sits in the same class every week and
 * should not pick the same two languages every time. Per-browser, which is
 * the right scope — it is a preference about this screen, not about them. */
const REMEMBER_KEY = "tobira.translate.languages";

function minutes(seconds: number): string {
  const whole = Math.floor(seconds / 60);
  return whole < 1 ? "under a minute" : `${whole} minute${whole === 1 ? "" : "s"}`;
}

export function LiveTranslation({
  user,
  conversations,
}: {
  user: ShellUser | null;
  conversations: ConversationSummary[];
}) {
  const live = useLiveTranslation();
  const [source, setSource] = useState<SourceLanguage>("auto");
  const [target, setTarget] = useState<LanguageCode>("en");
  const [subject, setSubject] = useState("");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(REMEMBER_KEY);
      if (!saved) return;
      const { source: s, target: t } = JSON.parse(saved) as {
        source?: string;
        target?: string;
      };
      if (s) setSource(s as SourceLanguage);
      if (t) setTarget(t as LanguageCode);
    } catch {
      /* a browser that refuses storage still gets the defaults */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(REMEMBER_KEY, JSON.stringify({ source, target }));
    } catch {
      /* not worth telling anyone about */
    }
  }, [source, target]);

  /* ------------------------------------------------------- auto-scroll ---- */

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** Following the newest line, until the student scrolls up to read back.
   * Then it stops, and does not start again until they return to the bottom —
   * the spec's "allow users to scroll back", and the thing that makes a long
   * transcript readable while it is still growing. */
  const [following, setFollowing] = useState(true);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setFollowing(atBottom);
  }, []);

  useEffect(() => {
    if (!following) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live.segments, live.pending, following]);

  const running = live.phase === "listening" || live.phase === "connecting";
  const started = running || live.phase === "paused";
  const hasText = live.segments.length > 0 || live.pending !== null;

  return (
    <AppShell page="translate" user={user} conversations={conversations} fullHeight>
      <div className="flex h-full min-h-0 flex-col gap-4 p-4 sm:p-6">
        <header className="shrink-0">
          <h1 className="text-xl font-semibold">Live translation</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Point your microphone at the class. The translation appears as the teacher
            speaks, and is saved to your chats when you finish.
          </p>
        </header>

        {/* The pickers are disabled once a session is under way: the language
            is locked into the token the server minted, so changing it here
            would be a promise the connection cannot keep. */}
        <div className="flex shrink-0 flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600 dark:text-neutral-400">From</span>
            <select
              className="min-w-36 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-neutral-900 placeholder:text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              value={source}
              disabled={started}
              onChange={(e) => setSource(e.target.value as SourceLanguage)}
            >
              <option className="bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100" value="auto">
                Detect automatically
              </option>
              {LANGUAGES.map((l) => (
                <option className="bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100" key={l.code} value={l.code}>
                  {l.label} — {l.native}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600 dark:text-neutral-400">Into</span>
            <select
              className="min-w-36 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-neutral-900 placeholder:text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              value={target}
              disabled={started}
              onChange={(e) => setTarget(e.target.value as LanguageCode)}
            >
              {LANGUAGES.filter((l) => l.code !== source).map((l) => (
                <option className="bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100" key={l.code} value={l.code}>
                  {l.label} — {l.native}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="text-neutral-600 dark:text-neutral-400">
              What the class is about <span className="opacity-60">(optional)</span>
            </span>
            <input
              className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-neutral-900 placeholder:text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              value={subject}
              disabled={started}
              maxLength={200}
              placeholder="e.g. Heian period literature"
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!started && (
            <button
              type="button"
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              onClick={() => live.start({ source, target, subject: subject || undefined })}
            >
              {live.phase === "ended" ? "Start again" : "Start"}
            </button>
          )}
          {live.phase === "listening" && (
            <button
              type="button"
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
              onClick={live.pause}
            >
              Pause
            </button>
          )}
          {live.phase === "paused" && (
            <button
              type="button"
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
              onClick={live.resume}
            >
              Resume
            </button>
          )}
          {started && (
            <button
              type="button"
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
              onClick={live.end}
            >
              End
            </button>
          )}

          <span className="ml-auto text-sm text-neutral-600 dark:text-neutral-400">
            {live.phase === "connecting" && "Connecting…"}
            {live.phase === "listening" && (
              <span className="flex items-center gap-2">
                <span className="inline-block size-2 animate-pulse rounded-full bg-red-500" />
                Listening
              </span>
            )}
            {live.phase === "paused" && "Paused"}
            {live.phase === "ended" && "Finished"}
            {live.remainingSeconds !== null && running && (
              <span className="ml-3 opacity-70">{minutes(live.remainingSeconds)} left</span>
            )}
          </span>
        </div>

        {live.error && (
          <p
            role="alert"
            className="shrink-0 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          >
            {live.error.message}
          </p>
        )}

        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
        >
          {!hasText && (
            <p className="text-sm text-neutral-500">
              {started
                ? "Waiting for someone to speak…"
                : "Nothing yet. Choose your languages and press Start."}
            </p>
          )}

          <ol className="space-y-4">
            {live.segments.map((segment) => (
              <li key={segment.seq}>
                {/* The translation is the thing being read, often from across
                    a lecture theatre on a laptop screen. It gets an explicit
                    colour (inheriting is what made the pickers invisible),
                    the largest size on the page, and full contrast. */}
                <p className="text-base leading-relaxed text-neutral-900 sm:text-lg dark:text-neutral-100">
                  {segment.translated}
                </p>
                {segment.source && (
                  <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                    {segment.source}
                  </p>
                )}
              </li>
            ))}
            {/* The one line still moving. Rendered apart from the finished
                list so React never re-keys what is already settled, which is
                what stops the transcript flickering as this grows. */}
            {live.pending && (
              // The line still arriving. It used to be dimmed to 70% to say
              // "not final", which dimmed the one line the student is
              // actually reading — they are watching the newest text, not the
              // settled text above it. Marked with a rule down the left
              // instead, which says the same thing and costs no contrast.
              <li aria-live="polite" className="border-l-2 border-neutral-400 pl-3 dark:border-neutral-600">
                <p className="text-base leading-relaxed text-neutral-900 sm:text-lg dark:text-neutral-100">
                  {live.pending.translated || "…"}
                </p>
                {live.pending.source && (
                  <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                    {live.pending.source}
                  </p>
                )}
              </li>
            )}
          </ol>
        </div>

        {!following && hasText && (
          <button
            type="button"
            className="shrink-0 self-center rounded-full border border-neutral-300 bg-white px-4 py-1.5 text-xs shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
            onClick={() => setFollowing(true)}
          >
            Jump to the latest
          </button>
        )}

        {live.phase === "ended" && live.conversationId && (
          <p className="shrink-0 text-sm text-neutral-600 dark:text-neutral-400">
            Saved to your chats.{" "}
            <a className="underline" href={`/?c=${live.conversationId}`}>
              Open it
            </a>
          </p>
        )}
      </div>
    </AppShell>
  );
}
