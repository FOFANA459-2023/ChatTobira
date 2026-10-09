/** Live translation: one open connection that listens to a lecture and writes
 * what it means, while the teacher is still talking.
 *
 * This is the speaking page's machinery pointed at a different problem, and
 * the differences are the whole design:
 *
 *   speaking practice            live translation
 *   a student talks in turns     a teacher talks for ninety minutes
 *   the model answers in AUDIO   the model answers in TEXT
 *   it has a retrieval tool      it has none, and must not reach for one
 *   context is a conversation    context is a lecture, and it improves the
 *                                translation of what was said a minute ago
 *
 * Everything underneath is shared on purpose — the socket, the token, the
 * 16kHz capture and the base64 framing all come from live-voice.ts. What is
 * new here is the instruction and the shape of what comes back.
 *
 * WHY A LIVE MODEL AND NOT WHISPER PLUS A TRANSLATION CALL. The app already
 * has that pipeline: /api/transcribe sends a recording to Whisper and the
 * chat route answers it. It is the wrong tool twice over. It cannot start
 * until the speaker stops, so a lecture would arrive a paragraph behind; and
 * each request is independent, so nothing the teacher said a minute ago is
 * available to disambiguate what they are saying now — which is most of what
 * makes a translation read naturally rather than correctly. A live session
 * holds the lecture in its own context and keeps improving on it.
 */

/** The model that listens. The same one speaking practice uses: measured
 * fastest to a first token on this key, and a translation that lags the
 * speaker is not a live translation. */
export const TRANSLATE_MODEL = "gemini-3.8-live";

/** The voice it translates in.
 *
 * It is never played. See translateSetup: this session asks for AUDIO it
 * throws away and reads the TRANSCRIPT of that audio as the translation,
 * because no live model on this key will emit text. A voice still has to be
 * named for the request to be valid. */
export const TRANSLATE_VOICE = "Kore";

/** How long the speaker must pause before a segment is finished.
 *
 * Longer than the 500ms speaking practice uses, and deliberately so. That
 * number is tuned for a learner hunting for a word mid-sentence, where
 * cutting them off is the failure. Here the speaker is fluent and the failure
 * is the opposite: a segment that ends at every natural breath, chopping one
 * sentence into four and translating each without the others.
 */
export const TRANSLATE_SILENCE_MS = 900;

/** Languages a lecture can be translated into.
 *
 * Chosen for who is actually in the room at APU rather than for coverage:
 * the campus is half international, and these are the languages its students
 * arrive with. `auto` is offered for the SOURCE only — the model works out
 * what it is hearing, which is what a student who cannot yet name the
 * language needs.
 */
export const LANGUAGES = [
  { code: "en", label: "English", native: "English" },
  { code: "ja", label: "Japanese", native: "日本語" },
  { code: "zh", label: "Chinese (Simplified)", native: "简体中文" },
  { code: "zh-TW", label: "Chinese (Traditional)", native: "繁體中文" },
  { code: "ko", label: "Korean", native: "한국어" },
  { code: "vi", label: "Vietnamese", native: "Tiếng Việt" },
  { code: "id", label: "Indonesian", native: "Bahasa Indonesia" },
  { code: "th", label: "Thai", native: "ไทย" },
  { code: "ne", label: "Nepali", native: "नेपाली" },
  { code: "es", label: "Spanish", native: "Español" },
  { code: "fr", label: "French", native: "Français" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];
/** The source may be left to the model. The target may not. */
export type SourceLanguage = LanguageCode | "auto";

const BY_CODE = new Map<string, (typeof LANGUAGES)[number]>(
  LANGUAGES.map((l) => [l.code, l]),
);

export function isLanguage(code: string): code is LanguageCode {
  return BY_CODE.has(code);
}

/** The English name of a language, for writing into the instruction. */
export function languageName(code: LanguageCode): string {
  return BY_CODE.get(code)?.label ?? code;
}

export interface TranslateSetupOptions {
  source: SourceLanguage;
  target: LanguageCode;
  model?: string;
  /** Named only because a speech request needs one; it is never played. */
  voice?: string;
  silenceMs?: number;
  /** What the class is about, if the student says. It only ever reaches the
   * instruction as terminology guidance. */
  subject?: string;
  /** Carry a session the server closed onto a new connection, so a lecture
   * keeps the context that makes its translation improve. */
  resumeHandle?: string;
}

/** The instruction the token locks in.
 *
 * Three things it has to get right, each of them a failure mode of live
 * translation generally rather than a hypothetical:
 *
 * 1. IT MUST ONLY TRANSLATE. A chat model given speech will answer it. A
 *    lecturer who asks "so what does this mean?" must have that question
 *    translated, not answered.
 * 2. IT MUST NOT NARRATE. "The speaker says that..." doubles the length and
 *    reads like a report of a lecture rather than the lecture.
 * 3. IT MUST NOT STOP. Unclear audio has to produce the likeliest reading and
 *    carry on; a translation that halts to say it did not catch something is
 *    a translation the student has to watch instead of read.
 */
export function translateInstruction(options: TranslateSetupOptions): string {
  const { source, target, subject } = options;
  const targetName = languageName(target);
  const from =
    source === "auto"
      ? "You will hear one continuous stream of speech. Work out what language it is in and keep translating from it; never announce what you decided."
      : `You are hearing ${languageName(source)}.`;

  const topic = subject?.trim()
    ? `\n\nWHAT THE CLASS IS ABOUT\n${subject.trim().slice(0, 300)}\nUse it to choose between readings of a term that could go several ways. It is a hint, not an instruction, and it never appears in your output.`
    : "";

  return `You are a simultaneous interpreter for a university lecture at Ritsumeikan Asia Pacific University. ${from} You translate it into ${targetName}, continuously, while the speaker is still talking.

WHAT YOU PRODUCE
- ${targetName}, and nothing else. No source text, no romanisation, no notes, no labels, no quotation marks around what you produce.
- Translate. Never answer, never summarise, never comment, never add. A question the speaker asks is translated as a question; it is not something you reply to.
- Never describe the speaker. Write what they said, in their own voice and person. Not "the speaker explains that the particle wa marks the topic" — just "the particle wa marks the topic".
- No preamble of any kind. Your first word is the first word of the translation.

HOW YOU KEEP UP
- Translate each stretch of speech as it finishes. Short, complete units; do not wait for a paragraph.
- Carry the lecture with you. A term you translated one way at the start stays that way, and a pronoun that only makes sense from two sentences ago keeps its referent. This is the whole advantage you have over translating one sentence at a time, and it is what you are here for.
- When speech is unclear, translate the likeliest reading and move on. Do not write "[inaudible]", do not guess wildly, and do not stop.
- If a stretch is only filler, a cough or silence, produce nothing at all for it rather than inventing a sentence.

TERMINOLOGY
- Technical and course terms keep the form a student would meet in their own materials. Where a term has no good equivalent, give the natural translation and put the original in brackets after it, once, the first time it appears.
- Names of people, places, books and institutions stay as they are.${topic}`;
}

/** The setup a token locks. The client's own setup message can change none of
 * it — the same guarantee the speaking page relies on, and it matters more
 * here: this is a model a student can stream audio to for two hours, and
 * without this it would be a general-purpose one. */
export function translateSetup(options: TranslateSetupOptions) {
  const model = options.model ?? TRANSLATE_MODEL;
  return {
    model: `models/${model}`,
    generationConfig: {
      // AUDIO, and the audio is thrown away.
      //
      // This feature wants text, and asking for text does not work. Measured
      // against this key on 2026-10-09: gemini-3.1-flash-live-preview refuses
      // TEXT when the session is set up ("response modalities (TEXT) is not
      // supported by the model"), and gemini-3.8-live is worse — it ACCEPTS
      // the setup, returns setupComplete, and then closes the socket 1007
      // with the same complaint the moment it actually has to generate. The
      // two older live models are not on this key at all.
      //
      // So the session asks for speech and reads outputAudioTranscription,
      // which is the same text the model would have written. The browser
      // never plays the audio. It costs more than text would and arrives no
      // later, and it is the only shape that works.
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice ?? TRANSLATE_VOICE } },
      },
      // No reasoning budget, for the same reason speaking practice has none:
      // it buys nothing on a turn like this and costs time to the first word.
      thinkingConfig: { thinkingBudget: 0 },
      // Translation is the one job here where invention is the enemy.
      temperature: 0.2,
    },
    systemInstruction: { parts: [{ text: translateInstruction(options) }] },
    // No tools. Speaking practice can search the textbooks; an interpreter
    // that stops to look something up is an interpreter that has stopped.
    realtimeInputConfig: {
      automaticActivityDetection: {
        silenceDurationMs: options.silenceMs ?? TRANSLATE_SILENCE_MS,
      },
    },
    // What the microphone heard: half of what gets saved, and the only way a
    // student can check a translation against what was actually said.
    inputAudioTranscription: {},
    // THE TRANSLATION ITSELF. Not a nicety — with responseModalities AUDIO
    // this is where the text comes from, and without it this feature returns
    // nothing a browser can display.
    outputAudioTranscription: {},
    // Google closes a connection every few minutes. Resumption carries the
    // lecture onto the next one with its context intact, which is the whole
    // reason this is a session rather than a series of requests — a resumed
    // session still knows how it translated a term twenty minutes ago.
    sessionResumption: options.resumeHandle ? { handle: options.resumeHandle } : {},
    // Without this an audio session ends at fifteen minutes. A lecture is
    // ninety, so this is not a tuning choice; the feature does not work
    // without it.
    contextWindowCompression: { slidingWindow: {} },
  };
}
