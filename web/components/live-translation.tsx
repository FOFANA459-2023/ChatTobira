"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AppShell } from "@/components/app-shell";
import type { ConversationSummary } from "@/lib/history";
import type { ShellUser } from "@/lib/shell";
import { LANGUAGES, type LanguageCode, type SourceLanguage } from "@/lib/translate";
import { useLiveTranslation, type TranslatePhase } from "@/lib/use-live-translate";

/** Remembered between visits: a student sits in the same class every week and
 * should not pick the same two languages every time. Per-browser, which is
 * the right scope — it is a preference about this screen, not about them. */
const REMEMBER_KEY = "tobira.translate.languages";

function minutes(seconds: number): string {
  const whole = Math.floor(seconds / 60);
  return whole < 1 ? "under a minute" : `${whole} minute${whole === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------------ */
/* The controls                                                              */
/* ------------------------------------------------------------------------ */

/* WHY THESE ARE WRITTEN OUT RATHER THAN INHERITED.
 *
 * This screen used to carry `dark:` variants — the only file in the app that
 * did. Nothing configures a dark mode here, so they fired on the student's
 * OPERATING SYSTEM preference while the page behind them stayed light
 * (globals.css pins body to bg-stone-50). On a laptop set to dark, Start
 * resolved to a white button with near-white text on a near-white page, which
 * is exactly as invisible as it sounds. Every colour below is stated once, in
 * the stone palette the rest of the app uses.
 *
 * The hierarchy is deliberate and readable at a glance from across a lecture
 * theatre: filled black is the action that begins listening, a heavy outline
 * is the one that stops it for good, a light outline is the reversible one.
 * All three clear 44px, which is the smallest thing a thumb reliably hits. */
const BUTTON_BASE =
  "inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2";
const START_BUTTON = `${BUTTON_BASE} bg-stone-900 px-6 text-white shadow-sm hover:bg-stone-700 focus-visible:outline-stone-900`;
const END_BUTTON = `${BUTTON_BASE} border-2 border-stone-800 bg-white text-stone-900 hover:bg-stone-900 hover:text-white focus-visible:outline-stone-900`;
/* stone-500 rather than the stone-300 a quiet button would normally take: a
 * white pill on a white panel IS its border, and stone-300 against white is
 * 1.5:1, under the 3:1 a control's own boundary is meant to clear. At 4.5:1
 * it is unmistakably a button and still the lightest of the three. */
const PAUSE_BUTTON = `${BUTTON_BASE} border-2 border-stone-500 bg-white text-stone-700 hover:border-stone-700 hover:bg-stone-100 focus-visible:outline-stone-500`;

function MicGlyph() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="4" width="4.5" height="16" rx="1.2" />
      <rect x="13.5" y="4" width="4.5" height="16" rx="1.2" />
    </svg>
  );
}

function StopGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
    </svg>
  );
}

function SpinnerGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden="true"
      className="animate-spin motion-reduce:animate-none"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

/** Four bars rising and falling while the microphone is open.
 *
 * The one thing a student needs to know at a glance — mid-lecture, without
 * reading anything — is whether this is still running. A still icon cannot
 * say that; movement can, and movement is also the first thing to notice when
 * it STOPS. The keyframes live in globals.css and hold at a reduced height
 * when the student has asked for less motion. */
function LiveBars() {
  return (
    <span className="tobira-bars flex h-3.5 items-end gap-[2px]" aria-hidden="true">
      <span className="w-[3px] rounded-full bg-current" />
      <span className="w-[3px] rounded-full bg-current" />
      <span className="w-[3px] rounded-full bg-current" />
      <span className="w-[3px] rounded-full bg-current" />
    </span>
  );
}

/** What the session is doing, as a chip that is always on screen.
 *
 * Red while it is listening, which is the recording convention every student
 * already knows and the one colour on this page that is allowed to shout. It
 * is deliberately not shu: that accent marks where the student IS in the app
 * and would be saying something else here. */
function StatusChip({ phase }: { phase: TranslatePhase }) {
  const chip = "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium";
  if (phase === "connecting") {
    return (
      <span className={`${chip} border-stone-200 bg-stone-100 text-stone-700`}>
        <SpinnerGlyph />
        Starting…
      </span>
    );
  }
  if (phase === "listening") {
    return (
      <span
        role="status"
        className={`${chip} border-red-200 bg-red-50 text-red-700`}
      >
        <LiveBars />
        Translating live
      </span>
    );
  }
  if (phase === "paused") {
    return (
      <span role="status" className={`${chip} border-amber-200 bg-amber-50 text-amber-800`}>
        <PauseGlyph />
        Paused
      </span>
    );
  }
  if (phase === "ended") {
    return (
      <span role="status" className={`${chip} border-stone-200 bg-stone-100 text-stone-600`}>
        <CheckGlyph />
        Finished
      </span>
    );
  }
  return (
    <span className={`${chip} border-stone-200 bg-white text-stone-500`}>
      <MicGlyph />
      Ready
    </span>
  );
}

/* ------------------------------------------------------------------------ */

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
  const field =
    "rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 placeholder:text-stone-400 focus-visible:border-stone-500 focus-visible:outline-none disabled:bg-stone-100 disabled:text-stone-500";

  return (
    <AppShell page="translate" user={user} conversations={conversations} fullHeight>
      <div className="flex h-full min-h-0 flex-col gap-4 p-4 sm:p-6">
        <header className="shrink-0">
          <h1 className="text-xl font-semibold text-stone-900">Live translation</h1>
          <p className="mt-1 text-sm text-stone-600">
            Point your microphone at the class. The translation appears as the teacher
            speaks, and is saved to your chats when you finish.
          </p>
        </header>

        {/* The pickers are disabled once a session is under way: the language
            is locked into the token the server minted, so changing it here
            would be a promise the connection cannot keep. */}
        <div className="flex shrink-0 flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-stone-600">From</span>
            <select
              className={`min-w-36 ${field}`}
              value={source}
              disabled={started}
              onChange={(e) => setSource(e.target.value as SourceLanguage)}
            >
              <option value="auto">Detect automatically</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label} — {l.native}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-stone-600">Into</span>
            <select
              className={`min-w-36 ${field}`}
              value={target}
              disabled={started}
              onChange={(e) => setTarget(e.target.value as LanguageCode)}
            >
              {LANGUAGES.filter((l) => l.code !== source).map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label} — {l.native}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-stone-600">
              What the class is about <span className="font-normal text-stone-400">(optional)</span>
            </span>
            <input
              className={field}
              value={subject}
              disabled={started}
              maxLength={200}
              placeholder="e.g. Heian period literature"
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
        </div>

        {/* One panel, so the controls read as the transport bar they are
            rather than three links adrift on the page. */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-stone-200 bg-white px-3 py-3 shadow-sm">
          <StatusChip phase={live.phase} />

          {live.remainingSeconds !== null && running && (
            <span className="text-sm text-stone-500">{minutes(live.remainingSeconds)} left</span>
          )}

          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {!started && (
              <button
                type="button"
                className={START_BUTTON}
                onClick={() => live.start({ source, target, subject: subject || undefined })}
              >
                <MicGlyph />
                {live.phase === "ended" ? "Start again" : "Start translating"}
              </button>
            )}
            {live.phase === "listening" && (
              <button type="button" className={PAUSE_BUTTON} onClick={live.pause}>
                <PauseGlyph />
                Pause
              </button>
            )}
            {live.phase === "paused" && (
              <button type="button" className={START_BUTTON} onClick={live.resume}>
                <MicGlyph />
                Resume
              </button>
            )}
            {started && (
              <button type="button" className={END_BUTTON} onClick={live.end}>
                <StopGlyph />
                End &amp; save
              </button>
            )}
          </div>
        </div>

        {live.error && (
          <p
            role="alert"
            className="shrink-0 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {live.error.message}
          </p>
        )}

        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-stone-200 bg-white p-4"
        >
          {!hasText && (
            <p className="text-sm text-stone-500">
              {/* Truthful now that the microphone is recorded from the click:
                  audio spoken while the connection comes up is held and sent,
                  not dropped, so a student may start talking straight away. */}
              {live.phase === "connecting"
                ? "Go ahead and speak — recording has already started."
                : started
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
                <p className="text-base leading-relaxed text-stone-900 sm:text-lg">
                  {segment.translated}
                </p>
                {segment.source && (
                  <p className="mt-1 text-sm text-stone-500">{segment.source}</p>
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
              // instead, in the same red as the live chip, which says the
              // same thing and costs no contrast.
              <li aria-live="polite" className="border-l-2 border-red-400 pl-3">
                <p className="text-base leading-relaxed text-stone-900 sm:text-lg">
                  {live.pending.translated || "…"}
                </p>
                {live.pending.source && (
                  <p className="mt-1 text-sm text-stone-500">{live.pending.source}</p>
                )}
              </li>
            )}
          </ol>
        </div>

        {!following && hasText && (
          <button
            type="button"
            className="shrink-0 self-center rounded-full border border-stone-300 bg-white px-4 py-1.5 text-xs font-medium text-stone-700 shadow-sm hover:bg-stone-100"
            onClick={() => setFollowing(true)}
          >
            Jump to the latest
          </button>
        )}

        {/* Said in this order on purpose: the screen has just been emptied,
            so the first thing it has to account for is where the text went. */}
        {live.phase === "ended" && (
          <p className="shrink-0 text-sm text-stone-600">
            {live.saving ? (
              "Saving to your chats…"
            ) : live.conversationId ? (
              <>
                Saved to your chats.{" "}
                <a className="font-medium underline" href={`/?c=${live.conversationId}`}>
                  Open it
                </a>
                . Press Start again for the next class.
              </>
            ) : (
              "Nothing to save — no speech was translated."
            )}
          </p>
        )}
      </div>
    </AppShell>
  );
}
