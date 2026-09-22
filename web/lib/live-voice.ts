/** The live spoken conversation: one open connection that listens, thinks and
 * speaks at once.
 *
 * The spoken turn this replaces was four requests in a row, each waiting for
 * the one before it: wait 1.1s of silence, upload the recording to Whisper,
 * run the chat route, then synthesise the reply a clause at a time — and the
 * speech model alone took 2.6–6s per clause. Measured end to end that was five
 * to seven seconds from the student going quiet to the first syllable back,
 * and no amount of tuning inside the pipeline could shorten it much, because
 * every stage was already waiting on the one before.
 *
 * A native-audio live model does the whole turn in one place. The browser
 * streams microphone audio over a WebSocket as it is captured; the model
 * detects the end of the student's speech itself, and streams its reply back
 * as audio while it is still generating it. Measured on 2026-09-19 against
 * this key, a real 3.2-second Japanese sentence streamed in real time, clock
 * from the END of the speech to the first audio byte back:
 *
 *   model                                  default VAD   silence 500ms   + thinking 0
 *   gemini-3.8-live                        1.58-1.75s    1.01-1.09s      0.94-0.98s
 *   gemini-3.1-flash-live-preview          1.95-2.01s
 *   gemini-2.5-flash-native-audio-latest   2.56s
 *
 *   gemini-3.8-live, silence 300ms, thinking 0:  0.71-0.84s
 *
 * 3.8-live also transcribed the sentence exactly, where the other two
 * returned it tokenised with spaces between the morphemes.
 *
 * The end-of-speech window is the only real trade in that table. 300ms is the
 * fastest and cuts off a learner who pauses mid-sentence to find a word —
 * which is most learners, most sentences. 500ms is the default here, and it
 * is an environment variable because it is a judgement about students, not a
 * fact about the model.
 *
 * The browser never sees the Google key. The server mints a single-use token
 * that LOCKS the model, the voice, the tools and the system prompt; a client
 * holding it can hold one conversation and change none of those.
 */

import type { ConversationLanguage } from "./conversation";
import { levelGuidance, speakingPrompt, type SpeakingMode } from "./speech";
import type { CourseLevel } from "./uploads";

export const LIVE_MODEL = "gemini-3.8-live";
export const LIVE_VOICE = "Kore";
/** How long the student must be quiet before their turn is over. */
export const LIVE_SILENCE_MS = 500;

/** Microphone audio the model accepts, and what it sends back. */
export const INPUT_RATE = 16_000;
export const OUTPUT_RATE = 24_000;

/** The live endpoint a token opens. v1alpha, because that is where the
 * constrained (token-locked) method lives. */
export const LIVE_SOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

/** The one tool the tutor has: the same retrieval the typed chat uses. */
export const LOOKUP_TOOL = "search_course_material";

/** What the browser sends to make the tutor take the first turn.
 *
 * The live model answers turns; it does not volunteer one. So a page that
 * wants the tutor to greet the student has to hand it a turn to answer, and
 * this is that turn. It is text rather than audio, so it produces no input
 * transcription and never reaches the student's transcript. */
export const OPENING_CUE =
  "(The student has just opened speaking practice and is waiting for you to begin. Greet them now.)";

export interface LiveTurn {
  role: "user" | "assistant";
  text: string;
}

export interface LiveSetupOptions {
  model?: string;
  voice?: string;
  silenceMs?: number;
  level: CourseLevel | null;
  language: ConversationLanguage;
  /** What kind of practice this is. The chat's microphone opens a free
   * conversation; the speaking page lets the student choose. */
  mode?: SpeakingMode;
  /** What they chose to practise — a topic, a grammar point, a scene. Only
   * the modes that need one use it. */
  subject?: string;
  /** The tutor speaks first and greets the student by name, rather than
   * waiting to be spoken to. The speaking page opens this way: a student who
   * pressed a button and met silence does not know it is their turn. The
   * chat's microphone does not, because it is joining a conversation that is
   * already under way. */
  opening?: boolean;
  /** The student's name, so the tutor can use it. */
  name?: string | null;
  /** The conversation so far, typed or spoken, newest last. */
  history?: LiveTurn[];
  /** Resume a session the server closed, keeping its context. */
  resumeHandle?: string;
}

/** How much of the earlier conversation rides into a new session. Enough to
 * know what was being talked about; the session keeps its own memory from
 * then on. */
const HISTORY_TURNS = 10;
const HISTORY_CHARS = 2400;

/** The earlier conversation, as the tutor should read it. */
export function historyBlock(history: LiveTurn[] = []): string {
  const recent = history.filter((turn) => turn.text.trim()).slice(-HISTORY_TURNS);
  if (recent.length === 0) return "";
  const lines: string[] = [];
  let budget = HISTORY_CHARS;
  // Newest first while budgeting, so a long early answer is what gets cut.
  for (const turn of [...recent].reverse()) {
    const text = turn.text.replace(/\s+/g, " ").trim().slice(0, 600);
    if (budget - text.length < 0) break;
    budget -= text.length;
    lines.unshift(`${turn.role === "user" ? "Student" : "You"}: ${text}`);
  }
  return `\nTHE CONVERSATION SO FAR (typed or spoken before this call)\n${lines.join("\n")}\nCarry on from it naturally; do not greet the student as if meeting them for the first time.`;
}

/** The whole system instruction for a live session. */
export function liveInstruction(options: LiveSetupOptions): string {
  const { level, language, name, history, mode = "free", subject, opening } = options;
  const who = name ? ` The student's name is ${name}.` : "";

  // Two different language rules, because the two ways in are different. The
  // chat's microphone joins a conversation that already has a language and
  // must not change it underfoot. The speaking page starts from nothing, so
  // it opens in English (which every student here reads) and then follows
  // whichever language the student actually answers in, without ever making
  // them choose one.
  const languageRule = opening
    ? `- Open in English, whatever language the rest of the conversation turns out to be in.
- From your second turn on, speak whichever language the STUDENT is speaking. If they answer in Japanese, carry on in Japanese. If they answer in English, stay in English. Follow them every time it changes, and never ask them to pick a language or comment on which one they used.`
    : `- The conversation is being held in ${language === "ja" ? "Japanese" : "English"}. Stay in it.
- If the student asks to switch ("let's speak Japanese", 「英語で話しましょう」), switch at once and stay in the new language until they ask again.`;

  const openingRule = opening
    ? `

OPENING THE CONVERSATION
- Speak first. The student has pressed a button and is waiting; do not wait for them.
- Greet them ${name ? "by name" : ""}, say in one short sentence what you can practise together, and ask what they would like to work on. Two sentences, no more.
- Something like: "${name ? `Hi ${name}!` : "Hi!"} We can practise anything from your course, or just talk about whatever you like. What would you like to work on today?" Say it in your own words rather than copying that line.
- Do not list options, do not explain how this works, and do not mention textbooks by name.`
    : "";

  return `You are ChatTobira, a friendly Japanese conversation partner for a university student at Ritsumeikan Asia Pacific University (APU) who is learning Japanese with the Tobira / Foundation Japanese curriculum.${who} You are talking out loud, in real time.

${speakingPrompt(mode, level, subject, language, "lookup")}${openingRule}

LANGUAGE
${languageRule}

REAL-TIME CONVERSATION
- Keep every turn short: one to three sentences. The student can interrupt you at any moment, and a long turn is one they have to wait through.
- If you are interrupted, stop and respond to what the student just said. Do not finish the sentence you were on.
- Speak naturally and at a clear, unhurried pace for a learner. ${levelGuidance(level).split(".")[0]}.${historyBlock(history)}`;
}

/** The setup a token locks in. Everything the client cannot change. */
export function liveSetup(options: LiveSetupOptions) {
  const model = options.model ?? LIVE_MODEL;
  return {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice ?? LIVE_VOICE } },
      },
      // Measured: thinking costs ~60ms to the first audio on a conversational
      // turn and changed nothing a student would hear. The tool call is what
      // brings in knowledge, not reasoning.
      thinkingConfig: { thinkingBudget: 0 },
    },
    systemInstruction: { parts: [{ text: liveInstruction(options) }] },
    tools: [
      {
        functionDeclarations: [
          {
            name: LOOKUP_TOOL,
            description:
              "Search the student's own course textbooks and class materials. Use it for any question about grammar, vocabulary, kanji, readings or what their course teaches.",
            parameters: {
              type: "OBJECT",
              properties: {
                query: {
                  type: "STRING",
                  description:
                    "What the student means, written as the course writes it — the grammar pattern in its textbook form (「〜ておく」, not the word it sounded like), the word in kanji and kana, or a topic ('Topic 8 vocabulary').",
                },
              },
              required: ["query"],
            },
          },
        ],
      },
    ],
    realtimeInputConfig: {
      automaticActivityDetection: {
        // HIGH ends the turn sooner once the student stops; the silence
        // window is what keeps a mid-sentence pause from counting as the end.
        endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
        silenceDurationMs: options.silenceMs ?? LIVE_SILENCE_MS,
      },
    },
    // Both sides as text, for the caption, the saved transcript, and the
    // chat history the student gets back when the call ends.
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // A connection is closed by the server every few minutes; resumption
    // carries the conversation onto a new one without the student noticing.
    sessionResumption: options.resumeHandle ? { handle: options.resumeHandle } : {},
    // Without compression an audio session ends at fifteen minutes.
    contextWindowCompression: { slidingWindow: {} },
  };
}

/* ------------------------------------------------------------------------ */
/* Audio encoding, shared by the browser and the tests                       */
/* ------------------------------------------------------------------------ */

/** Float samples (-1..1) to 16-bit little-endian PCM. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** 16-bit PCM back to float samples, for playback. */
export function pcm16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Little-endian PCM bytes as samples. Copies when the bytes are not 2-byte
 * aligned, which a base64 decode is free to hand back. */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const even = bytes.byteLength - (bytes.byteLength % 2);
  if (bytes.byteOffset % 2 === 0) return new Int16Array(bytes.buffer, bytes.byteOffset, even / 2);
  return new Int16Array(bytes.slice(0, even).buffer);
}

/** Where a streaming downsample left off: the input it has not consumed yet,
 * and how far into the first of those samples the next window starts. */
export interface DownsampleState {
  tail: Float32Array;
  phase: number;
}

export const freshDownsample = (): DownsampleState => ({ tail: new Float32Array(0), phase: 0 });

/** Downsample by averaging each output sample's window of input — a box
 * filter, crude and enough to keep speech from aliasing at 16 kHz.
 *
 * Streaming: the microphone arrives in 128-sample blocks, and 128 is not a
 * multiple of 3 (48 kHz) or of 2.75625 (44.1 kHz). Whatever a block cannot
 * finish is carried into the next one rather than dropped — dropping it
 * shortens the audio by ~1.6% at 48 kHz, which the model hears as speech that
 * is slightly too fast. */
export function downsample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  state: DownsampleState = freshDownsample(),
): { samples: Float32Array; state: DownsampleState } {
  if (fromRate === toRate) return { samples: input.slice(), state: freshDownsample() };
  const ratio = fromRate / toRate;
  const all = new Float32Array(state.tail.length + input.length);
  all.set(state.tail, 0);
  all.set(input, state.tail.length);

  const out: number[] = [];
  let position = state.phase;
  while (position + ratio <= all.length) {
    const start = Math.floor(position);
    const end = Math.floor(position + ratio);
    let sum = 0;
    for (let i = start; i < end; i++) sum += all[i];
    out.push(sum / Math.max(1, end - start));
    position += ratio;
  }
  const kept = Math.floor(position);
  return {
    samples: Float32Array.from(out),
    state: { tail: all.slice(kept), phase: position - kept },
  };
}
