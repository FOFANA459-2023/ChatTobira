import { describe, expect, it } from "vitest";

import {
  isLanguage,
  LANGUAGES,
  languageName,
  TRANSLATE_SILENCE_MS,
  translateInstruction,
  translateSetup,
} from "../translate";
import { shouldClose } from "../use-live-translate";

describe("the languages a lecture can be turned into", () => {
  it("knows the ones it lists and nothing else", () => {
    expect(isLanguage("ja")).toBe(true);
    expect(isLanguage("vi")).toBe(true);
    // The codes go into the system instruction, so an unknown one must not be
    // treated as a language the model is asked to produce.
    expect(isLanguage("klingon")).toBe(false);
    expect(isLanguage("")).toBe(false);
  });

  it("has no duplicate codes, which a <select> would render twice", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives every language a name in English and in itself", () => {
    // The English label is what goes into the instruction; the native name is
    // what a student scanning the list recognises.
    for (const language of LANGUAGES) {
      expect(language.label.trim()).not.toBe("");
      expect(language.native.trim()).not.toBe("");
    }
  });
});

describe("the interpreter's instruction", () => {
  const base = { source: "ja", target: "en" } as const;

  it("names the language it is translating into", () => {
    expect(translateInstruction(base)).toContain("English");
    expect(translateInstruction({ source: "ja", target: "vi" })).toContain("Vietnamese");
  });

  it("names the source when it is known, and asks for detection when it is not", () => {
    expect(translateInstruction(base)).toContain("You are hearing Japanese.");
    const auto = translateInstruction({ source: "auto", target: "en" });
    expect(auto).toContain("Work out what language it is in");
    // Announcing the detected language would be the first line of the
    // transcript and is not a translation of anything.
    expect(auto).toContain("never announce what you decided");
  });

  it("forbids the three things a chat model does instead of translating", () => {
    const text = translateInstruction(base);
    // Answering the speaker, narrating them, and prefacing the output are
    // each a failure that makes the transcript unusable rather than imperfect.
    expect(text).toContain("Never answer");
    expect(text).toContain("Never describe the speaker");
    expect(text).toContain("No preamble");
  });

  it("tells it to keep going when the audio is unclear", () => {
    // A translation that stops to report a problem is one the student has to
    // watch rather than read.
    expect(translateInstruction(base)).toContain("do not stop");
  });

  it("carries the subject in only when there is one", () => {
    expect(translateInstruction(base)).not.toContain("WHAT THE CLASS IS ABOUT");
    const withSubject = translateInstruction({ ...base, subject: "Heian period literature" });
    expect(withSubject).toContain("WHAT THE CLASS IS ABOUT");
    expect(withSubject).toContain("Heian period literature");
  });

  it("does not let the subject run away with the instruction", () => {
    // It is the one part a student writes, so its length is theirs to set and
    // ours to bound.
    const long = translateInstruction({ ...base, subject: "x".repeat(5_000) });
    expect(long).not.toContain("x".repeat(400));
  });
});

describe("the setup a token locks", () => {
  const setup = translateSetup({ source: "ja", target: "en" });

  it("asks for TEXT, which the translate model will actually produce", () => {
    // The conversation model this replaced would not: it accepted the setup,
    // sent setupComplete, and closed the socket 1007 the moment it had to
    // generate. Measured on this key, 2026-10-09.
    expect(setup.generationConfig.responseModalities).toEqual(["TEXT"]);
  });

  it("asks to hear the source, and nothing about the output", () => {
    // The translation arrives on outputTranscription without being requested
    // — measured, not documented — so the client reads it defensively rather
    // than the setup demanding it.
    expect(setup.inputAudioTranscription).toBeDefined();
    expect("outputAudioTranscription" in setup).toBe(false);
  });

  it("uses the model built for this, not the one speaking practice uses", () => {
    // gemini-3.8-live answers only in speech, and generating speech costs
    // about as long as the speech itself — a lecture fell further behind with
    // every sentence. This one translates while the speaker is still talking.
    expect(setup.model).toBe("models/gemini-3.5-live-translate-preview");
    expect(setup.model).not.toContain("3.8-live");
  });

  it("sends no field the API does not have", () => {
    // `audio: { sampleRateHertz }` was invented and 400d every token mint:
    // "Unknown name \"audio\" ... Cannot find field". Every key here is one
    // the live endpoint accepted in a real mint.
    const allowed = new Set([
      "model",
      "generationConfig",
      "systemInstruction",
      "realtimeInputConfig",
      "inputAudioTranscription",
      "sessionResumption",
      "contextWindowCompression",
    ]);
    for (const key of Object.keys(setup)) expect(allowed.has(key)).toBe(true);
  });

  it("compresses the context window, without which a lecture ends at 15 minutes", () => {
    // Not a tuning choice. An audio session without this is closed by Google
    // long before a class is over, so the feature does not work without it.
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
  });

  it("gives the interpreter no tools to stop and reach for", () => {
    expect((setup as { tools?: unknown }).tools).toBeUndefined();
  });

  it("uses the measured silence window", () => {
    expect(setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs).toBe(
      TRANSLATE_SILENCE_MS,
    );
    // Measured, three runs each: 900ms reached the first word of translation
    // in ~1350ms and 400ms in ~950ms, both completing every time.
    expect(TRANSLATE_SILENCE_MS).toBe(400);
  });

  it("does NOT raise the end-of-speech sensitivity, which truncates the speaker", () => {
    // liveSetup sets END_SENSITIVITY_HIGH to end a student's turn sooner. On a
    // lecture it cut the speaker off in four runs out of six, closing the turn
    // after "Next, let's look" while the sentence ran on. Losing what was said
    // is a worse failure than being a few hundred milliseconds late.
    // Cast because the type does not carry the field at all, which is itself
    // half the guarantee; this pins the other half at runtime.
    const detection = setup.realtimeInputConfig.automaticActivityDetection as Record<
      string,
      unknown
    >;
    expect(detection.endOfSpeechSensitivity).toBeUndefined();
  });

  it("resumes a session only when it was given a handle to resume", () => {
    expect(setup.sessionResumption).toEqual({});
    const resumed = translateSetup({ source: "ja", target: "en", resumeHandle: "abc" });
    expect(resumed.sessionResumption).toEqual({ handle: "abc" });
  });

  it("locks the model, so a token cannot open a general-purpose one", () => {
    expect(setup.model).toContain("models/");
    expect(translateSetup({ source: "ja", target: "en", model: "x" }).model).toBe("models/x");
  });

  it("keeps the generation config to what this model takes", () => {
    // Every extra key here is a chance to 400 the mint, and this model needs
    // none of them: no voice, no thinking budget, no temperature.
    expect(Object.keys(setup.generationConfig)).toEqual(["responseModalities"]);
  });
});

describe("languageName", () => {
  it("answers in English, which is what the instruction is written in", () => {
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("zh-TW")).toBe("Chinese (Traditional)");
  });
});

describe("where a segment ends, now that nothing tells us", () => {
  it("closes on a finished sentence", () => {
    expect(shouldClose("Please submit your report by Friday.")).toBe(true);
    expect(shouldClose("Is that clear to everyone?")).toBe(true);
    expect(shouldClose("今日は助詞について説明します。")).toBe(true);
  });

  it("does not close mid-sentence", () => {
    expect(shouldClose("Now, let's look")).toBe(false);
    expect(shouldClose("Respectful language is")).toBe(false);
    expect(shouldClose("")).toBe(false);
  });

  it("is not fooled by a full stop that ends no sentence", () => {
    // The model writes these, and closing on them chops a sentence in half.
    expect(shouldClose("Dr.")).toBe(false);
    expect(shouldClose("e.g.")).toBe(false);
  });

  it("closes a runaway line even with no full stop", () => {
    // A lecturer who does not pause produces one unbroken clause. A line that
    // never settles is a line that never gets saved, so length ends it.
    expect(shouldClose("and then we move on to the next point ".repeat(12))).toBe(true);
  });

  it("tolerates a closing quote or bracket after the stop", () => {
    expect(shouldClose('He said "that is correct."')).toBe(true);
  });
});
