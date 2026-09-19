import { describe, expect, it } from "vitest";

import {
  base64ToBytes,
  bytesToBase64,
  bytesToPcm16,
  downsample,
  floatToPcm16,
  freshDownsample,
  historyBlock,
  LIVE_MODEL,
  LOOKUP_TOOL,
  liveInstruction,
  liveSetup,
  pcm16ToFloat,
} from "../live-voice";

describe("liveSetup", () => {
  const setup = liveSetup({ level: "F2", language: "ja" });

  it("locks the measured model, one voice, and audio replies", () => {
    expect(setup.model).toBe(`models/${LIVE_MODEL}`);
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    expect(setup.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("ends a turn after half a second of silence, not the default", () => {
    expect(setup.realtimeInputConfig.automaticActivityDetection).toEqual({
      endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
      silenceDurationMs: 500,
    });
    expect(liveSetup({ level: null, language: "ja", silenceMs: 800 }).realtimeInputConfig
      .automaticActivityDetection.silenceDurationMs).toBe(800);
  });

  it("gives the tutor exactly one tool: the course material", () => {
    const [{ functionDeclarations }] = setup.tools;
    expect(functionDeclarations.map((d) => d.name)).toEqual([LOOKUP_TOOL]);
    expect(functionDeclarations[0].parameters.required).toEqual(["query"]);
  });

  it("transcribes both sides, and survives connection rotation and long calls", () => {
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    expect(setup.sessionResumption).toEqual({});
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(liveSetup({ level: null, language: "ja", resumeHandle: "h-1" }).sessionResumption)
      .toEqual({ handle: "h-1" });
  });
});

describe("liveInstruction", () => {
  it("is a short-turn conversation partner that looks things up instead of pasting sources", () => {
    const text = liveInstruction({ level: "F3", language: "ja", name: "Varlee" });
    expect(text).toContain("Varlee");
    expect(text).toContain("call search_course_material FIRST");
    expect(text).not.toContain("in the sources below");
    expect(text).toMatch(/interrupt/i);
    expect(text).toContain("Foundation 3");
    expect(text).toContain("held in Japanese");
  });

  it("holds an English conversation in English", () => {
    const text = liveInstruction({ level: null, language: "en" });
    expect(text).toContain("held in English");
    expect(text).toContain("Reply in English");
  });

  it("carries the earlier conversation in, so a call picks up where typing left off", () => {
    const text = liveInstruction({
      level: null,
      language: "ja",
      history: [
        { role: "user", text: "〜ておくの意味は？" },
        { role: "assistant", text: "準備のために前もってすることです。" },
      ],
    });
    expect(text).toContain("Student: 〜ておくの意味は？");
    expect(text).toContain("You: 準備のために前もってすることです。");
  });
});

describe("historyBlock", () => {
  it("is empty with no history", () => {
    expect(historyBlock([])).toBe("");
    expect(historyBlock([{ role: "user", text: "   " }])).toBe("");
  });

  it("keeps the newest turns when the budget runs out", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      text: `turn ${i} ${"x".repeat(500)}`,
    }));
    const block = historyBlock(history);
    expect(block).toContain("turn 29");
    expect(block).not.toContain("turn 0 ");
    expect(block.length).toBeLessThan(3200);
  });
});

describe("audio encoding", () => {
  it("round-trips PCM through base64", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const bytes = new Uint8Array(pcm.buffer);
    expect(Array.from(bytesToPcm16(base64ToBytes(bytesToBase64(bytes))))).toEqual(Array.from(pcm));
  });

  it("reads PCM from an odd byte offset without throwing", () => {
    const backing = new Uint8Array(9);
    backing.set([0x34, 0x12, 0xff, 0x7f], 1);
    expect(Array.from(bytesToPcm16(backing.subarray(1, 5)))).toEqual([0x1234, 0x7fff]);
  });

  it("clips floats and converts them to 16-bit and back", () => {
    const pcm = floatToPcm16(Float32Array.from([0, 0.5, -0.5, 2, -2]));
    expect(Array.from(pcm)).toEqual([0, 16383, -16384, 32767, -32768]);
    const back = pcm16ToFloat(pcm);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[4]).toBe(-1);
  });
});

describe("downsample", () => {
  it("takes 48 kHz to 16 kHz at exactly a third of the length", () => {
    const { samples } = downsample(new Float32Array(4800).fill(0.25), 48_000, 16_000);
    expect(samples.length).toBe(1600);
    expect(samples[10]).toBeCloseTo(0.25);
  });

  it("loses nothing across 128-sample blocks — streamed equals one-shot", () => {
    // A ramp, so any dropped or repeated sample shows up in the output.
    const input = Float32Array.from({ length: 128 * 75 }, (_, i) => i / 10_000);
    for (const rate of [48_000, 44_100]) {
      const whole = downsample(input, rate, 16_000).samples;
      let state = freshDownsample();
      const streamed: number[] = [];
      for (let i = 0; i < input.length; i += 128) {
        const out = downsample(input.subarray(i, i + 128), rate, 16_000, state);
        state = out.state;
        streamed.push(...out.samples);
      }
      expect(streamed.length).toBe(whole.length);
      // Within one input sample of the one-shot result: 44.1 kHz's ratio is
      // not exact in floating point, so a window edge can land one sample
      // over. What must never happen is a sample dropped or duplicated.
      streamed.forEach((value, i) => expect(Math.abs(value - whole[i])).toBeLessThan(1.01e-4));
      // And the output rate is right: no ~1.6% speed-up from dropped tails.
      expect(Math.abs(streamed.length - (input.length * 16_000) / rate)).toBeLessThanOrEqual(1);
    }
  });

  it("passes through audio already at the target rate", () => {
    const input = Float32Array.from([0.1, 0.2, 0.3]);
    expect(Array.from(downsample(input, 16_000, 16_000).samples)).toEqual(Array.from(input));
  });
});
