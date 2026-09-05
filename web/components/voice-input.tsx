"use client";

import { VOICE_ERROR_TEXT, type SpeechToText } from "@/lib/use-voice";

/** The microphone, and everything the student needs to know about it.
 *
 * This replaces the old push-to-talk button, which recorded and dropped text
 * into the composer for review. That was the right call for a written
 * question in a language you are learning — a transcription error should be
 * visible before you send it — and it is the wrong one for a conversation,
 * where stopping to proof-read your own speech is the thing that stops it
 * being a conversation. Here the transcript is sent, and shown as the message
 * it became, so a mishearing is still visible: just afterwards rather than
 * before.
 *
 * Every state the machine can be in has a look, because the failure this
 * replaces was a button that appeared to do nothing while the microphone was
 * live, the upload was in flight, or permission had been silently refused.
 */
export function VoiceInput({
  voice,
  replying,
  speaking,
  onStopSpeaking,
  disabled,
}: {
  voice: SpeechToText;
  /** The tutor is thinking: the turn is not over, so the mic stays shut. */
  replying: boolean;
  /** The tutor is talking. The button becomes a way to stop it. */
  speaking: boolean;
  onStopSpeaking: () => void;
  disabled?: boolean;
}) {
  const { state, error, level } = voice;
  const listening = state === "listening";
  const transcribing = state === "transcribing";

  // One button, four jobs, and only ever one of them available — which is
  // what stops a second recording starting on top of the first.
  const busy = transcribing || replying;
  const label = speaking
    ? "Stop the reply"
    : listening
      ? "Stop recording and send"
      : transcribing
        ? "Transcribing your speech"
        : replying
          ? "Waiting for the reply"
          : "Speak Japanese";

  const status = error ? (
    <span className="text-amber-700">{VOICE_ERROR_TEXT[error]}</span>
  ) : listening ? (
    <span lang="ja">聞いています…</span>
  ) : transcribing ? (
    "Transcribing…"
  ) : speaking ? (
    <span lang="ja">話しています…</span>
  ) : null;

  function press() {
    if (speaking) return onStopSpeaking();
    if (listening) return voice.stop();
    if (busy) return;
    if (state === "error") voice.clearError();
    void voice.start();
  }

  return (
    <div className="flex items-center gap-2">
      {listening && (
        <button
          type="button"
          onClick={voice.cancel}
          className="rounded-lg px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-700"
        >
          Cancel
        </button>
      )}

      <button
        type="button"
        onClick={press}
        disabled={disabled || busy}
        aria-label={label}
        title={label}
        aria-pressed={listening}
        className={[
          "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition",
          listening
            ? "border-red-500 bg-red-500 text-white"
            : speaking
              ? "border-stone-900 bg-stone-900 text-white"
              : state === "error"
                ? "border-amber-400 bg-amber-50 text-amber-700"
                : "border-stone-300 bg-white text-stone-600 hover:bg-stone-100",
          busy ? "cursor-not-allowed opacity-60" : "",
        ].join(" ")}
      >
        {/* The ring grows with the student's own voice, so "listening" is
            something they can see working rather than a word they have to
            trust. Pure decoration in the DOM sense — aria-hidden — because
            the state is already announced below. */}
        {listening && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full bg-red-400/40 motion-reduce:hidden"
            style={{ transform: `scale(${1 + Math.min(level, 1) * 0.55})` }}
          />
        )}
        <span className="relative">
          {speaking ? (
            <StopIcon />
          ) : transcribing || replying ? (
            <SpinnerIcon />
          ) : listening ? (
            <SquareIcon />
          ) : (
            <MicIcon />
          )}
        </span>
      </button>

      {/* One live region for the whole machine, and only while it has
          something to say: an always-present empty status competes with the
          "thinking" indicator for the same announcement, and a screen reader
          reads whichever it reaches first. */}
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

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="4" y="4" width="7" height="16" rx="1.5" />
      <rect x="13" y="4" width="7" height="16" rx="1.5" />
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
