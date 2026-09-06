import { beforeEach, describe, expect, it } from "vitest";

import { fallbackVoice, resetFallbackVoice } from "@/lib/use-voice";

/** The Web Speech API exposes a name and a language and nothing else — no
 * gender — so the only thing a browser gives us to work with is the list
 * below, as the operating system happens to order it. */
function withVoices(names: [string, string][]) {
  const voices = names.map(([name, lang]) => ({ name, lang })) as SpeechSynthesisVoice[];
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { getVoices: () => voices, cancel: () => {}, speak: () => {} },
  });
}

beforeEach(() => resetFallbackVoice());

/** The tutor is one person. The cloud voice is Gemini's Kore, who is female;
 * the browser fallback used to take whatever the OS listed first, which on
 * Windows is Microsoft David — so losing the network mid-conversation handed
 * the student a different speaker. */
describe("the fallback voice matches the cloud voice", () => {
  it("passes over the male voice the platform lists first", () => {
    withVoices([
      ["Microsoft David - English (United States)", "en-US"],
      ["Microsoft Zira - English (United States)", "en-US"],
    ]);
    expect(fallbackVoice("en")?.name).toMatch(/Zira/);
  });

  it("picks a female Japanese voice for a Japanese conversation", () => {
    withVoices([
      ["Microsoft Ichiro - Japanese", "ja-JP"],
      ["Microsoft Nanami - Japanese", "ja-JP"],
      ["Microsoft Zira - English (United States)", "en-US"],
    ]);
    expect(fallbackVoice("ja")?.name).toMatch(/Nanami/);
  });

  it("prefers a multilingual female voice, which is what Kore is", () => {
    withVoices([
      ["Microsoft Zira - English (United States)", "en-US"],
      ["Microsoft Aria Online (Natural) - English (United States)", "en-US"],
    ]);
    expect(fallbackVoice("en")?.name).toMatch(/Aria/);
  });

  it("holds the same voice once chosen, across languages", () => {
    // Only the spoken LANGUAGE changes when a student switches; the speaker
    // does not.
    withVoices([
      ["Samantha", "en-US"],
      ["Kyoko", "ja-JP"],
    ]);
    const first = fallbackVoice("en");
    expect(fallbackVoice("ja")).toBe(first);
  });

  it("takes an unknown voice over a known male one", () => {
    // The name list cannot be complete, so it fails towards "not obviously
    // the wrong person" rather than towards a male default.
    withVoices([
      ["Microsoft George - English (United Kingdom)", "en-GB"],
      ["Some Unlabelled Voice", "en-GB"],
    ]);
    expect(fallbackVoice("en")?.name).toBe("Some Unlabelled Voice");
  });

  it("would rather speak than be silent when every voice is male", () => {
    withVoices([["Microsoft David - English (United States)", "en-US"]]);
    expect(fallbackVoice("en")?.name).toMatch(/David/);
  });

  it("waits rather than pinning the wrong voice before the list has loaded", () => {
    // getVoices() returns [] on the first call in some browsers; pinning then
    // would freeze a null choice for the life of the page.
    withVoices([]);
    expect(fallbackVoice("en")).toBeNull();

    withVoices([["Samantha", "en-US"]]);
    expect(fallbackVoice("en")?.name).toBe("Samantha");
  });
});
