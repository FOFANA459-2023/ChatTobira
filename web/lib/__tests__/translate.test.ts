import { describe, expect, it } from "vitest";

import {
  isLanguage,
  LANGUAGES,
  languageName,
  TRANSLATE_SILENCE_MS,
  translateInstruction,
  translateSetup,
} from "../translate";

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

  it("asks for text, because the point is to read it while someone speaks", () => {
    expect(setup.generationConfig.responseModalities).toEqual(["TEXT"]);
  });

  it("transcribes the input, which is the half a student checks against", () => {
    expect(setup.inputAudioTranscription).toBeDefined();
  });

  it("compresses the context window, without which a lecture ends at 15 minutes", () => {
    // Not a tuning choice. An audio session without this is closed by Google
    // long before a class is over, so the feature does not work without it.
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
  });

  it("gives the interpreter no tools to stop and reach for", () => {
    expect((setup as { tools?: unknown }).tools).toBeUndefined();
  });

  it("waits longer than speaking practice before calling a segment finished", () => {
    // A lecturer pauses between sentences; a learner pauses inside one. Ending
    // a segment at every breath chops one sentence into four and translates
    // each of them without the others.
    expect(setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs).toBe(
      TRANSLATE_SILENCE_MS,
    );
    expect(TRANSLATE_SILENCE_MS).toBeGreaterThan(500);
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

  it("keeps the temperature low, because invention is the enemy here", () => {
    expect(setup.generationConfig.temperature).toBeLessThanOrEqual(0.3);
  });
});

describe("languageName", () => {
  it("answers in English, which is what the instruction is written in", () => {
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("zh-TW")).toBe("Chinese (Traditional)");
  });
});
