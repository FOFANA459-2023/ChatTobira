import { describe, expect, it } from "vitest";

import { voicePhase, type VoicePhaseInput } from "@/lib/use-voice";

/** The loop, as a table. Every row is a moment that actually happens in a
 * spoken turn, and the point of the function under test is that all of them
 * have exactly one name — the button, the status line and the voice screen
 * used to derive this separately and disagree at the edges. */
const base: VoicePhaseInput = {
  live: true,
  listenState: "idle",
  hearing: false,
  replying: false,
  answerStarted: false,
  speaking: false,
  loadingAudio: false,
};

const at = (patch: Partial<VoicePhaseInput>) => voicePhase({ ...base, ...patch });

describe("one turn, start to finish", () => {
  it("is idle until the student starts a conversation", () => {
    expect(at({ live: false, listenState: "listening" })).toBe("idle");
  });

  it("walks listening → hearing → transcribing → thinking → speaking", () => {
    expect(at({ listenState: "listening" })).toBe("listening");
    expect(at({ listenState: "listening", hearing: true })).toBe("hearing");
    expect(at({ listenState: "transcribing" })).toBe("transcribing");
    expect(at({ replying: true })).toBe("thinking");
    expect(at({ replying: true, answerStarted: true })).toBe("responding");
    expect(at({ speaking: true })).toBe("speaking");
  });

  it("returns to listening on its own, with nothing pressed", () => {
    // The whole difference between a conversation and a walkie-talkie: after
    // the tutor stops speaking the microphone is open again.
    expect(at({ listenState: "listening" })).toBe("listening");
  });
});

describe("the states that overlap", () => {
  it("counts fetching the first clause as speaking, not thinking", () => {
    // The answer is written and the audio is on its way. Showing "thinking"
    // here made the tutor look stuck for the second before it spoke.
    expect(at({ loadingAudio: true })).toBe("speaking");
  });

  it("stays speaking while the tail of the request is still finishing", () => {
    // The last clause is fetched while the first is playing, so `replying`
    // and `speaking` are both true for a moment.
    expect(at({ replying: true, answerStarted: true, speaking: true })).toBe("speaking");
  });

  it("shows barge-in as hearing, not as speaking", () => {
    // The student talks over the tutor: the TTS hook has already been
    // stopped, so speaking is false and the mic is live again.
    expect(at({ listenState: "listening", hearing: true, speaking: false })).toBe("hearing");
  });
});
