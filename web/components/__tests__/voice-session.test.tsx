import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VoiceSession } from "@/components/voice-session";
import type { VoicePhase } from "@/lib/use-voice";

function show(phase: VoicePhase, props: Partial<Parameters<typeof VoiceSession>[0]> = {}) {
  return render(
    <VoiceSession
      phase={phase}
      level={0}
      language="en"
      onEnd={props.onEnd ?? (() => {})}
      onInterrupt={props.onInterrupt ?? (() => {})}
      {...props}
    />,
  );
}

describe("the voice screen says what is happening", () => {
  it("names each state in the conversation's own language", () => {
    show("listening");
    // Twice: the visible label and the screen-reader announcement, which now
    // say the same thing because "listening" and "hearing you" are the app's
    // business rather than a cue for the student.
    expect(screen.getAllByText("Listening")).toHaveLength(2);

    show("speaking", { language: "ja" });
    expect(screen.getByText("話しています")).toBeInTheDocument();
  });

  it("announces the state once, in English, for a screen reader", () => {
    // The visible label follows the conversation's language; the announcement
    // does not, because a screen reader is configured for one language.
    show("thinking", { language: "ja" });
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
  });

  it("tells the student how to change language, which is now a real setting", () => {
    show("listening", { language: "en" });
    expect(screen.getByText(/let.s speak Japanese/i)).toBeInTheDocument();
  });
});

describe("it is not a transcript", () => {
  it("shows the last thing it heard, so a mishearing is catchable", () => {
    show("thinking", { heard: "I went to Kyoto yesterday." });
    expect(screen.getByText(/I went to Kyoto yesterday/)).toBeInTheDocument();
  });

  it("never tells the student whose turn it is", () => {
    // A conversation does not hand over. Labelling the gap — "Go ahead",
    // 「どうぞ」 — made every turn a cue to wait for rather than a moment to
    // speak into.
    show("listening");
    expect(screen.queryByText(/go ahead/i)).toBeNull();
    expect(screen.queryByText(/どうぞ/)).toBeNull();
    expect(screen.queryByText(/reopens/i)).toBeNull();
  });

  it("promises the transcript back rather than showing it", () => {
    show("listening");
    expect(screen.getByText(/full transcript is saved/i)).toBeInTheDocument();
  });
});

describe("the controls", () => {
  it("ends the conversation", () => {
    const onEnd = vi.fn();
    show("listening", { onEnd });
    fireEvent.click(screen.getByRole("button", { name: /end conversation/i }));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("offers Skip only while the tutor is actually talking", () => {
    const onInterrupt = vi.fn();
    show("listening", { onInterrupt });
    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();

    show("speaking", { onInterrupt });
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(onInterrupt).toHaveBeenCalledOnce();
  });

  it("shows a microphone problem in words a student can act on", () => {
    show("listening", { error: "permission" });
    // Once on screen and once announced — and the visible copy is
    // aria-hidden, so a screen reader hears it a single time.
    expect(screen.getAllByText(/Microphone access was blocked/)).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent(/Microphone access was blocked/);
    // And the heading says so too, rather than claiming a phase of a
    // conversation that is not happening.
    expect(screen.getByText("Can't hear you")).toBeInTheDocument();
    expect(screen.queryByText("Go ahead")).toBeNull();
  });
});
