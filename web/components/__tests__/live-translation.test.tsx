import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LiveTranslation } from "@/components/live-translation";

vi.mock("next/navigation", () => ({ usePathname: () => "/translate" }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));

/** The live connection, stubbed at the hook: what is tested here is where the
 * translation sits on a phone, not how it arrives. */
let live: Record<string, unknown>;
vi.mock("@/lib/use-live-translate", () => ({ useLiveTranslation: () => live }));

const SEGMENTS = [
  { seq: 0, source: "では、始めましょう。", translated: "Let's begin." },
  { seq: 1, source: "教科書を開いてください。", translated: "Please open your textbook." },
];

function session(phase: string) {
  live = {
    phase,
    segments: phase === "idle" ? [] : SEGMENTS,
    pending: null,
    error: null,
    remainingSeconds: 2700,
    conversationId: null,
    saving: false,
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    end: vi.fn(),
  };
  return render(<LiveTranslation user={null} conversations={[]} />);
}

const pickers = () => screen.getByRole("combobox", { name: /From/ }).closest("label")!.parentElement!;
const transcript = () => screen.getByText("Let's begin.").closest("div.overflow-y-auto")!;

beforeEach(() => {
  localStorage.clear();
});

/* On a phone the page is one screen tall and the transcript gets whatever the
 * setup above it leaves. Stacked for a narrow screen, the setup left it one
 * line on an iPhone SE once the browser bar took its share, and nothing at
 * all on a smaller Android: the translation, the thing the page is for, was
 * off the bottom of the screen. */
describe("live translation on a phone", () => {
  it("folds the setup away while a session runs, keeping it on wider screens", () => {
    session("listening");
    // Hidden below the sm breakpoint, back on a laptop where there is room.
    expect(pickers().className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(pickers().className).toContain("sm:flex");
    expect(screen.getByText(/Point your microphone/).className).toContain("hidden sm:block");
  });

  it("says which languages are running, since the pickers are out of sight", () => {
    session("listening");
    const pair = screen.getByText("Detected language → English");
    // Phone only: on a laptop the pickers themselves are still on screen.
    expect(pair.className).toContain("sm:hidden");
  });

  it("never lets the transcript shrink below a readable height on a phone", () => {
    session("listening");
    expect(transcript().className).toContain("min-h-64");
    // A laptop keeps the old behaviour: the transcript takes what is left.
    expect(transcript().className).toContain("sm:min-h-0");
  });

  it("shows the setup before a session starts, with the two pickers side by side", () => {
    session("idle");
    expect(pickers().className).toMatch(/(^|\s)grid(\s|$)/);
    expect(pickers().className).toContain("grid-cols-2");
    expect(screen.getByText(/Point your microphone/).className).not.toContain("hidden");
  });

  it("brings the setup back once the session has ended", () => {
    session("ended");
    expect(pickers().className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });
});
