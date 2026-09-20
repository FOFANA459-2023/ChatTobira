import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SpeakingPractice } from "@/components/speaking-practice";

vi.mock("next/navigation", () => ({ usePathname: () => "/speaking" }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));

/** The live conversation, stubbed at the hook. The page's job is to decide
 * WHAT is practised and hand that to the same audio the chat uses; the audio
 * itself has its own tests in use-live-voice.test.tsx. */
interface StartOptions {
  language: string;
  history: unknown[];
  mode?: string;
  subject?: string;
  opening?: boolean;
}
// Typed through the generic rather than a named parameter, so the assertions
// below can read start.mock.calls without eslint flagging an unused arg.
const start = vi.fn<(options: StartOptions) => Promise<"live">>(async () => "live");
const stop = vi.fn();
const interrupt = vi.fn();
let active = false;

vi.mock("@/lib/use-live-voice", () => ({
  useLiveConversation: () => ({
    active,
    phase: "idle" as const,
    level: 0,
    heard: null,
    error: null,
    notice: null,
    secondsLeft: null,
    start,
    stop,
    interrupt,
  }),
}));

const BOOKS = [
  { id: 5, title: "Foundation 1 & 2" },
  { id: 30, title: "Foundation 3 Textbook" },
  { id: 3, title: "Tobira Intermediate Japanese" },
];

beforeEach(() => {
  vi.clearAllMocks();
  active = false;
});

describe("speaking practice", () => {
  it("names every textbook from Foundation 1 to Intermediate, in writing", () => {
    render(<SpeakingPractice firstName="Varlee" books={BOOKS} />);
    for (const book of BOOKS) {
      expect(screen.getByText(book.title)).toBeInTheDocument();
    }
  });

  it("tells the student what they can ask for, rather than asking them to pick it", () => {
    render(<SpeakingPractice firstName={null} books={BOOKS} />);
    expect(screen.getByText(/Anything from your textbooks/)).toBeInTheDocument();
    expect(screen.getByText(/Anything else you want to get better at saying/)).toBeInTheDocument();
    // Role play is the tutor's job when a student asks for it, not a thing
    // the student has to be told the app can do.
    expect(screen.queryByText(/situation to act out/)).not.toBeInTheDocument();
    expect(screen.queryByText(/role.?play/i)).not.toBeInTheDocument();
    // Nothing to fill in: the asking happens out loud.
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("starts the conversation from one round button", async () => {
    render(<SpeakingPractice firstName={null} books={BOOKS} />);
    const button = screen.getByRole("button", { name: "Start speaking" });
    expect(button.className).toMatch(/rounded-full/);
    fireEvent.click(button);
    await waitFor(() => expect(start).toHaveBeenCalled());
  });

  it("has the tutor open in English and greet first", async () => {
    render(<SpeakingPractice firstName="Varlee" books={BOOKS} />);
    fireEvent.click(screen.getByRole("button", { name: "Start speaking" }));
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(start.mock.calls[0][0]).toMatchObject({ language: "en", opening: true });
  });

  it("says nothing about which language the conversation is in", () => {
    // The tutor opens in English and then follows whatever the student
    // answers in, so there is no setting and nothing for them to be told.
    render(<SpeakingPractice firstName={null} books={BOOKS} />);
    expect(screen.queryByText(/starts in Japanese/)).not.toBeInTheDocument();
    expect(screen.queryByText(/英語で話しましょう/)).not.toBeInTheDocument();
  });

  it("still reads as a page when the textbook list could not be loaded", () => {
    render(<SpeakingPractice firstName={null} books={[]} />);
    expect(screen.getByText(/Anything from your textbooks/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start speaking" })).toBeEnabled();
  });

  it("shows the voice screen once the conversation is running", () => {
    active = true;
    render(<SpeakingPractice firstName={null} books={BOOKS} />);
    expect(screen.queryByRole("button", { name: "Start speaking" })).not.toBeInTheDocument();
  });
});
