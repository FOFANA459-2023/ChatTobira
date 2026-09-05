"use client";

import { VOICE_ERROR_TEXT, type SpeechToText } from "@/lib/use-voice";

/** The microphone, and everything the student needs to know about it.
 *
 * This has been three different controls. It began as push-to-talk that
 * dropped a transcript in the composer to be proof-read. It became a button
 * that sent a turn. It is now a switch: pressing it starts a conversation and
 * pressing it again ends one, and in between the student does not touch it.
 * They speak, they stop speaking, the reply comes back, and the microphone
 * opens again on its own.
 *
 * That is the whole point of the redesign, so the button says which of those
 * is happening at every moment. The failure it replaces was a control that
 * looked identical whether the microphone was live, the upload was in flight,
 * or permission had been silently refused.
 */
export function VoiceInput({
  voice,
  live,
  onLiveChange,
  replying,
  speaking,
  onStopSpeaking,
  disabled,
}: {
  voice: SpeechToText;
  /** True while a spoken conversation is running. */
  live: boolean;
  onLiveChange: (live: boolean) => void;
  /** The tutor is thinking: the turn is not over. */
  replying: boolean;
  /** The tutor is talking. */
  speaking: boolean;
  onStopSpeaking: () => void;
  disabled?: boolean;
}) {
  const { state, error, level, hearing } = voice;
  const listening = state === "listening";
  const transcribing = state === "transcribing";

  const label = !live
    ? "Start a spoken conversation"
    : speaking
      ? "Stop the reply and end the conversation"
      : listening
        ? hearing
          ? "Listening — stop the conversation"
          : "Waiting for you to speak — stop the conversation"
        : transcribing
          ? "Transcribing your speech"
          : replying
            ? "Waiting for the reply"
            : "End the spoken conversation";

  const status = error ? (
    <span className="text-amber-700">{VOICE_ERROR_TEXT[error]}</span>
  ) : !live ? null : hearing ? (
    <span lang="ja">聞いています…</span>
  ) : listening ? (
    <span className="text-stone-400">どうぞ — go ahead</span>
  ) : transcribing ? (
    "Transcribing…"
  ) : speaking ? (
    <span lang="ja">話しています…</span>
  ) : replying ? (
    "Thinking…"
  ) : null;

  function press() {
    if (state === "error") voice.clearError();
    if (live) {
      // One press leaves, whatever the loop happens to be doing.
      onLiveChange(false);
      voice.cancel();
      onStopSpeaking();
      return;
    }
    onLiveChange(true);
    void voice.start();
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={press}
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-pressed={live}
        className={[
          "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition",
          hearing
            ? "border-red-500 bg-red-500 text-white"
            : live
              ? "border-stone-900 bg-stone-900 text-white"
              : state === "error"
                ? "border-amber-400 bg-amber-50 text-amber-700"
                : "border-stone-300 bg-white text-stone-600 hover:bg-stone-100",
        ].join(" ")}
      >
        {/* The ring grows with the student's own voice, so "listening" is
            something they can watch working rather than a word to trust. */}
        {hearing && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full bg-red-400/40 motion-reduce:hidden"
            style={{ transform: `scale(${1 + Math.min(level, 1) * 0.55})` }}
          />
        )}
        {/* Live but quiet: a slow pulse says the microphone is open without
            implying anything is being heard. */}
        {live && listening && !hearing && (
          <span
            aria-hidden="true"
            className="absolute inset-0 animate-ping rounded-full bg-stone-400/30 motion-reduce:hidden"
          />
        )}
        <span className="relative">
          {transcribing || replying ? (
            <SpinnerIcon />
          ) : speaking ? (
            <SpeakerIcon />
          ) : live ? (
            <SquareIcon />
          ) : (
            <MicIcon />
          )}
        </span>
      </button>

      {/* One live region for the whole machine, and only while it has
          something to say: an always-present empty status competes with the
          "thinking" indicator for the same announcement. */}
      {status && (
        <p role="status" aria-live="polite" className="min-w-0 text-xs text-stone-500">
          {status}
        </p>
      )}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function SquareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="animate-spin motion-reduce:animate-none"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  );
}
