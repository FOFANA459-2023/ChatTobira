"use client";

import type { ConversationLanguage } from "@/lib/conversation";
import { VOICE_ERROR_TEXT, type VoiceError, type VoicePhase } from "@/lib/use-voice";

/** The screen while a spoken conversation is running.
 *
 * The chat transcript is the wrong interface for this, and watching it made
 * that obvious: a student holding a conversation out loud was shown their own
 * speech appearing as a chat bubble, then a reply being typed out word by word
 * underneath it, while the actual conversation happened in their ears a
 * sentence behind. Two channels saying the same thing at different speeds,
 * and the eye wins — students stopped listening and started reading, which is
 * the one thing speaking practice is supposed to prevent.
 *
 * So voice takes the screen. What is on it is what a person needs while
 * talking to someone: whether they are being heard, whether the other side is
 * thinking, whether it is talking, and how to stop. The transcript is still
 * being recorded the whole time — every turn goes into the same conversation
 * as a typed one — and it comes back in full the moment the conversation ends.
 *
 * The one exception to "no transcript" is the caption below the orb, which
 * shows the LAST thing heard and nothing before it. That is not a transcript;
 * it is the only way a student catches Whisper mishearing 「聞こえます」 as
 * 「消えます」, and losing that was not worth the purity.
 */

interface PhaseCopy {
  /** What is happening, in the language of the conversation. */
  ja: string;
  en: string;
  /** Screen-reader text: the same fact, always in English, because a student
   * running a screen reader has it configured for one language. */
  announce: string;
}

const PHASE_COPY: Record<VoicePhase, PhaseCopy> = {
  idle: { ja: "準備中", en: "Getting ready", announce: "Getting ready" },
  // Deliberately the same words as `hearing`. The microphone being open
  // and the microphone hearing you are the app's business, not the
  // student's, and labelling the gap between the tutor finishing and the
  // student starting — "Go ahead", 「どうぞ」 — turned every turn into a
  // handover with a cue to wait for. A conversation does not announce
  // whose turn it is; you just talk.
  listening: { ja: "聞いています", en: "Listening", announce: "Listening" },
  hearing: { ja: "聞いています", en: "Listening", announce: "Hearing you" },
  transcribing: { ja: "聞き取り中", en: "Catching that", announce: "Working out what you said" },
  thinking: { ja: "考えています", en: "Thinking", announce: "Thinking" },
  responding: { ja: "考えています", en: "Thinking", announce: "Writing a reply" },
  speaking: { ja: "話しています", en: "Speaking", announce: "Speaking" },
};

export function VoiceSession({
  phase,
  level,
  language,
  heard,
  error,
  onEnd,
  onInterrupt,
}: {
  phase: VoicePhase;
  /** Microphone loudness, 0–1. */
  level: number;
  /** The language the conversation is being held in — shown because it is now
   * a persistent property of the conversation rather than a guess made afresh
   * every turn, and a student who wants to change it should be able to see
   * what they are changing. */
  language: ConversationLanguage;
  /** The last thing the app heard the student say. */
  heard?: string | null;
  error?: VoiceError | null;
  onEnd: () => void;
  /** Stop the tutor talking without ending the conversation. */
  onInterrupt: () => void;
}) {
  const copy = PHASE_COPY[phase];
  const speaking = phase === "speaking";
  const hearing = phase === "hearing";
  const busy = phase === "transcribing" || phase === "thinking" || phase === "responding";

  // The orb breathes with whichever side is making noise: the student's own
  // input level while they talk, a steady pulse while the tutor does. A
  // student can tell at a glance whether the microphone is hearing them,
  // which is the single most common thing to be unsure about.
  const scale = hearing ? 1 + Math.min(level, 1) * 0.5 : speaking ? 1.12 : 1;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-10">
      <div className="relative flex h-48 w-48 items-center justify-center">
        {/* Rings rather than a bar meter: this is ambient, and a student
            glancing up should read it without focusing on it. */}
        <span
          aria-hidden="true"
          className={[
            "absolute inset-0 rounded-full transition-transform duration-100 motion-reduce:transform-none",
            hearing ? "bg-red-400/25" : speaking ? "bg-stone-900/10" : "bg-stone-300/25",
          ].join(" ")}
          style={{ transform: `scale(${scale})` }}
        />
        {(speaking || busy) && (
          <span
            aria-hidden="true"
            className={[
              "absolute inset-4 animate-ping rounded-full motion-reduce:hidden",
              speaking ? "bg-stone-900/15" : "bg-stone-400/20",
            ].join(" ")}
          />
        )}
        <span
          aria-hidden="true"
          className={[
            "relative flex h-28 w-28 items-center justify-center rounded-full text-white shadow-lg transition-colors",
            hearing ? "bg-red-500" : speaking ? "bg-stone-900" : "bg-stone-700",
          ].join(" ")}
        >
          {speaking ? <SpeakerGlyph /> : busy ? <ThinkingGlyph /> : <MicGlyph />}
        </span>
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        {/* Everything the student can SEE about the current state is
            aria-hidden, and the one live region below is what is announced.
            Otherwise the phase is in the accessibility tree twice — once in
            the conversation's language and once in English — and an error is
            announced twice over, which is how a screen reader turns a single
            "microphone blocked" into a stutter. */}
        <p
          aria-hidden="true"
          className={`text-lg font-medium ${error ? "text-amber-800" : "text-stone-800"}`}
          lang={error ? "en" : language === "ja" ? "ja" : "en"}
        >
          {/* A failed microphone is not a phase of the conversation, and
              labelling it "Getting ready" over an error message reads as the
              app not knowing what it is doing. */}
          {error
            ? "Can't hear you"
            : language === "ja"
              ? copy.ja
              : copy.en}
        </p>
        <p role="status" aria-live="polite" className="sr-only">
          {error ? VOICE_ERROR_TEXT[error] : copy.announce}
        </p>
        <p className="text-xs text-stone-400">
          {language === "ja" ? "日本語で会話中" : "Talking in English"}
          {" · "}
          Say &ldquo;let&rsquo;s speak {language === "ja" ? "English" : "Japanese"}&rdquo; to switch
        </p>
      </div>

      {/* What it heard. One turn, never a scrollback — see the note above. */}
      <div className="flex min-h-[3.5rem] w-full max-w-md items-start justify-center">
        {error ? (
          <p
            aria-hidden="true"
            className="rounded-xl bg-amber-50 px-4 py-2 text-center text-sm text-amber-800"
          >
            {VOICE_ERROR_TEXT[error]}
          </p>
        ) : heard ? (
          <p className="text-center text-sm leading-relaxed text-stone-500">
            <span className="text-stone-400">You said: </span>
            {heard}
          </p>
        ) : (
          <p className="text-center text-sm text-stone-300">
            {language === "ja" ? "話しかけてください。" : "Just start talking."}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        {speaking && (
          // Barge-in already stops the tutor when the student talks over it.
          // This is for the student who wants it to stop without having to
          // say something to make it.
          <button
            type="button"
            onClick={onInterrupt}
            className="rounded-full border border-stone-300 bg-white px-5 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-100"
          >
            Skip
          </button>
        )}
        <button
          type="button"
          onClick={onEnd}
          className="rounded-full bg-stone-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-stone-700"
        >
          End conversation
        </button>
      </div>

      <p className="text-xs text-stone-400">
        The full transcript is saved and appears here when you finish.
      </p>
    </div>
  );
}

function MicGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function SpeakerGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

function ThinkingGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="animate-spin motion-reduce:animate-none">
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  );
}
