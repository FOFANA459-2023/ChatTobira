import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VoiceInput } from "@/components/voice-input";
import { VOICE_ERROR_TEXT, type SpeechToText, type VoiceError } from "@/lib/use-voice";

function voiceStub(overrides: Partial<SpeechToText> = {}): SpeechToText {
  return {
    state: "idle",
    error: null,
    level: 0,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    cancel: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  };
}

function setup(overrides: Partial<SpeechToText> = {}, props: Partial<Parameters<typeof VoiceInput>[0]> = {}) {
  const voice = voiceStub(overrides);
  const onStopSpeaking = vi.fn();
  render(
    <VoiceInput
      voice={voice}
      replying={false}
      speaking={false}
      onStopSpeaking={onStopSpeaking}
      {...props}
    />,
  );
  return { voice, onStopSpeaking };
}

describe("the microphone at rest", () => {
  it("invites the student to speak", () => {
    setup();
    expect(screen.getByRole("button", { name: "Speak Japanese" })).toBeEnabled();
  });

  it("starts recording when pressed", () => {
    const { voice } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Speak Japanese" }));
    expect(voice.start).toHaveBeenCalledTimes(1);
  });

  it("says nothing while there is nothing to say", () => {
    // An always-present empty live region competes with the "thinking"
    // indicator for the same announcement.
    setup();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("listening", () => {
  it("shows that it is listening, in the language being practised", () => {
    setup({ state: "listening" });
    expect(screen.getByRole("status")).toHaveTextContent("聞いています");
  });

  it("turns the button into a stop, which sends the turn", () => {
    const { voice } = setup({ state: "listening" });
    const button = screen.getByRole("button", { name: "Stop recording and send" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(voice.stop).toHaveBeenCalledTimes(1);
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("offers a cancel that throws the recording away", () => {
    // Stopping sends what you said; cancelling is how you take it back.
    const { voice } = setup({ state: "listening" });
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(voice.cancel).toHaveBeenCalledTimes(1);
    expect(voice.stop).not.toHaveBeenCalled();
  });

  it("has no cancel when there is nothing to cancel", () => {
    setup();
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
  });
});

describe("while the turn is being processed", () => {
  it("locks the button during transcription", () => {
    // The failure this prevents: a second recording starting on top of the
    // first, so two turns race into one conversation.
    const { voice } = setup({ state: "transcribing" });
    const button = screen.getByRole("button", { name: "Transcribing your speech" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(voice.start).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing");
  });

  it("locks it again while the tutor is thinking", () => {
    const { voice } = setup({}, { replying: true });
    const button = screen.getByRole("button", { name: "Waiting for the reply" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("stays locked however many times it is pressed", () => {
    // Requirement: rapid repeated clicks must not queue recordings.
    const { voice } = setup({ state: "transcribing" });
    const button = screen.getByRole("button");
    for (let i = 0; i < 6; i++) fireEvent.click(button);
    expect(voice.start).not.toHaveBeenCalled();
  });
});

describe("while the tutor is speaking", () => {
  it("becomes a way to stop the audio", () => {
    const { voice, onStopSpeaking } = setup({}, { speaking: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop the reply" }));
    expect(onStopSpeaking).toHaveBeenCalledTimes(1);
    // Stopping the reply must not also start recording: a student silencing
    // the app has not yet decided to say anything.
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("says so", () => {
    setup({}, { speaking: true });
    expect(screen.getByRole("status")).toHaveTextContent("話しています");
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

  it("lets the student retry, which clears the error first", () => {
    const { voice } = setup({ state: "error", error: "permission" });
    fireEvent.click(screen.getByRole("button", { name: "Speak Japanese" }));
    expect(voice.clearError).toHaveBeenCalledTimes(1);
    expect(voice.start).toHaveBeenCalledTimes(1);
  });
});

describe("when the composer is disabled", () => {
  it("goes with it", () => {
    setup({}, { disabled: true });
    expect(screen.getByRole("button", { name: "Speak Japanese" })).toBeDisabled();
  });
});
