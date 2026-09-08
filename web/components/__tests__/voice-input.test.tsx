import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VoiceInput } from "@/components/voice-input";
import { VOICE_ERROR_TEXT, type SpeechToText, type VoiceError } from "@/lib/use-voice";

function voiceStub(overrides: Partial<SpeechToText> = {}): SpeechToText {
  return {
    state: "idle",
    error: null,
    level: 0,
    hearing: false,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    cancel: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  };
}

type Props = Parameters<typeof VoiceInput>[0];

function setup(voiceOverrides: Partial<SpeechToText> = {}, props: Partial<Props> = {}) {
  const voice = voiceStub(voiceOverrides);
  const onLiveChange = vi.fn();
  const onStopSpeaking = vi.fn();
  render(
    <VoiceInput
      voice={voice}
      live={false}
      onLiveChange={onLiveChange}
      replying={false}
      speaking={false}
      onStopSpeaking={onStopSpeaking}
      {...props}
    />,
  );
  return { voice, onLiveChange, onStopSpeaking };
}

describe("starting a conversation", () => {
  it("offers to start one", () => {
    setup();
    expect(screen.getByRole("button", { name: "Start a spoken conversation" })).toBeEnabled();
  });

  it("goes live and opens the microphone on one press", () => {
    const { voice, onLiveChange } = setup();
    fireEvent.click(screen.getByRole("button"));
    expect(onLiveChange).toHaveBeenCalledWith(true);
    expect(voice.start).toHaveBeenCalledTimes(1);
  });

  it("says nothing while there is nothing to say", () => {
    // An always-present empty live region competes with the "thinking"
    // indicator for the same announcement.
    setup();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("while the conversation is live", () => {
  it("waits without claiming to hear anything", () => {
    // The microphone is open and the student has not started. Saying
    // "listening" here would be a lie the meter immediately contradicts.
    setup({ state: "listening", hearing: false }, { live: true });
    expect(screen.getByRole("status")).toHaveTextContent("go ahead");
  });

  it("says it is listening once the student actually speaks", () => {
    setup({ state: "listening", hearing: true }, { live: true });
    expect(screen.getByRole("status")).toHaveTextContent("聞いています");
  });

  it("has no stop button for the utterance, because there is nothing to press", () => {
    // The whole point of the redesign: the end of a sentence is detected, not
    // declared. A student who has to press stop is not having a conversation.
    setup({ state: "listening", hearing: true }, { live: true });
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("ends the whole conversation on one press", () => {
    const { voice, onLiveChange, onStopSpeaking } = setup(
      { state: "listening", hearing: true },
      { live: true },
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onLiveChange).toHaveBeenCalledWith(false);
    expect(voice.cancel).toHaveBeenCalledTimes(1);
    expect(onStopSpeaking).toHaveBeenCalledTimes(1);
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("reports each stage of the turn", () => {
    for (const [voiceState, props, expected] of [
      [{ state: "transcribing" as const }, { live: true }, "Transcribing"],
      [{}, { live: true, replying: true }, "Thinking"],
      [{}, { live: true, speaking: true }, "話しています"],
    ] as const) {
      const { unmount } = render(
        <VoiceInput
          voice={voiceStub(voiceState)}
          onLiveChange={vi.fn()}
          replying={false}
          speaking={false}
          onStopSpeaking={vi.fn()}
          {...props}
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(expected);
      unmount();
    }
  });

  it("stays one button through every stage", () => {
    // Nothing appears or disappears mid-turn: a control that changes shape
    // while the student is mid-sentence is a control they stop trusting.
    for (const props of [
      { live: true, replying: true },
      { live: true, speaking: true },
    ]) {
      const { unmount } = render(
        <VoiceInput
          voice={voiceStub({ state: "idle" })}
          onLiveChange={vi.fn()}
          replying={false}
          speaking={false}
          onStopSpeaking={vi.fn()}
          {...props}
        />,
      );
      expect(screen.getAllByRole("button")).toHaveLength(1);
      unmount();
    }
  });
});

describe("errors", () => {
  it("explains every failure in words a student can act on", () => {
    const reasons: VoiceError[] = [
      "unsupported",
      "permission",
      "no_microphone",
      "recording_failed",
      "empty",
      "transcription_failed",
      "network",
    ];
    for (const reason of reasons) {
      const { unmount } = render(
        <VoiceInput
          voice={voiceStub({ state: "error", error: reason })}
          live
          onLiveChange={vi.fn()}
          replying={false}
          speaking={false}
          onStopSpeaking={vi.fn()}
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(VOICE_ERROR_TEXT[reason]);
      // No error code, no status number, nothing from the speech API.
      expect(screen.getByRole("status").textContent).not.toMatch(/\d{3}|api|error:/i);
      unmount();
    }
  });

  it("clears the error before trying again", () => {
    const { voice, onLiveChange } = setup({ state: "error", error: "permission" });
    fireEvent.click(screen.getByRole("button"));
    expect(voice.clearError).toHaveBeenCalledTimes(1);
    expect(onLiveChange).toHaveBeenCalledWith(true);
    expect(voice.start).toHaveBeenCalledTimes(1);
  });
});

describe("when the composer is disabled", () => {
  it("goes with it", () => {
    setup({}, { disabled: true });
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
