import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Chat } from "../chat";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: vi.fn(), getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    storage: { from: () => ({ uploadToSignedUrl: vi.fn() }) },
  }),
}));

/** Drives useChat for the tests below; reset per test by assignment. */
let chatState: {
  messages: unknown[];
  status: string;
  error?: Error;
} = { messages: [], status: "ready" };

function userMessage(text: string) {
  return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
}
function assistantMessage(text: string) {
  return { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text }] };
}

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: chatState.messages,
    sendMessage: vi.fn(),
    status: chatState.status,
    error: chatState.error,
  }),
}));

beforeEach(() => {
  chatState = { messages: [], status: "ready" };
});

/** The composer's controls, which is what a student actually looks for.
 *
 * These exist because the attach button was reported missing: it renders
 * only for a signed-in student, so a signed-out session shows the input and
 * Send alone and looks broken to anyone expecting otherwise.
 */
describe("chat composer", () => {
  it("offers the attach button to a signed-in student", () => {
    render(<Chat authenticated firstName="Rin" />);
    expect(screen.getByLabelText("Attach a photo or PDF")).toBeInTheDocument();
  });

  it("puts it beside Send, where a chat app keeps it", () => {
    render(<Chat authenticated firstName="Rin" />);
    const attach = screen.getByLabelText("Attach a photo or PDF");
    const send = screen.getByRole("button", { name: "Send" });
    // Same row: an attach control docked anywhere else is not findable.
    expect(attach.closest("div")).toBe(send.closest("div"));
  });

  it("hides it from signed-out visitors, who have no account to store against", () => {
    render(<Chat authenticated={false} />);
    expect(screen.queryByLabelText("Attach a photo or PDF")).not.toBeInTheDocument();
    // The trial still works, so the composer itself must remain usable.
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("keeps the composer laid out as one row, in reading order", () => {
    render(<Chat authenticated firstName="Rin" />);
    const row = screen.getByRole("button", { name: "Send" }).parentElement!;
    expect(row.className).toContain("flex");

    // The hidden file input is a sibling too, so look at what a student can
    // actually see: question box, attach, mic, send.
    const visible = [...row.querySelectorAll("input, button")].filter(
      (el) => el.getAttribute("type") !== "file",
    );
    expect(
      visible.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? el.tagName),
    ).toEqual([
      "",
      "Attach a photo or PDF",
      // The mic no longer drops a transcript into the box for proof-reading;
      // it speaks a turn into the conversation. The label says so.
      "Speak Japanese",
      "Send",
    ]);
  });
});

/** The gap between pressing Send and the first word of the answer. Retrieval
 * searches every book before a model writes anything, so that gap is real —
 * and it used to render as nothing at all. */
describe("chat pending state", () => {
  it("shows a thinking indicator as soon as the question is sent", async () => {
    chatState = { messages: [userMessage("what is the て form?")], status: "submitted" };
    render(<Chat authenticated firstName="Rin" />);
    expect(await screen.findByRole("status")).toHaveTextContent(/looking through your course/i);
  });

  it("keeps it up while the request is in flight with nothing back yet", () => {
    chatState = {
      messages: [userMessage("q"), assistantMessage("")],
      status: "streaming",
    };
    render(<Chat authenticated />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("drops it the moment the answer starts arriving", () => {
    chatState = {
      messages: [userMessage("q"), assistantMessage("The て form")],
      status: "streaming",
    };
    render(<Chat authenticated />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText(/The て form/)).toBeInTheDocument();
  });

  it("shows exactly one, however many messages are on screen", () => {
    chatState = {
      messages: [userMessage("one"), assistantMessage("done"), userMessage("two")],
      status: "submitted",
    };
    render(<Chat authenticated />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("gives way to the error state when the request fails", () => {
    chatState = {
      messages: [userMessage("q")],
      status: "error",
      error: new Error("boom"),
    };
    render(<Chat authenticated />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
  });

  it("does not show one before the student has asked anything", () => {
    chatState = { messages: [], status: "ready" };
    render(<Chat authenticated />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

/** Speaking practice, from the composer's side.
 *
 * The mode switch is the one control that changes what a spoken turn gets
 * back — a conversation partner rather than a written explanation — so it has
 * to be findable, off by default, and honest about what it does.
 */
describe("speaking practice", () => {
  it("offers the microphone to a signed-in student", () => {
    render(<Chat authenticated firstName="Rin" />);
    expect(screen.getByRole("button", { name: "Speak Japanese" })).toBeInTheDocument();
  });

  it("keeps voice behind sign-in, like every other stored feature", () => {
    // /api/transcribe and /api/speak both refuse an anonymous caller, so a
    // button that could never work should not be on the screen.
    render(<Chat authenticated={false} />);
    expect(screen.queryByRole("button", { name: "Speak Japanese" })).not.toBeInTheDocument();
  });

  it("is off until the student asks for it", () => {
    // A student who came to look something up should not have a conjugation
    // table read aloud at them.
    render(<Chat authenticated firstName="Rin" />);
    const toggle = screen.getByRole("checkbox", { name: /Speaking practice/ });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: "Practice mode" })).not.toBeInTheDocument();
  });

  it("reveals the practice modes once it is on", () => {
    render(<Chat authenticated firstName="Rin" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Speaking practice/ }));
    const modes = screen.getByRole("combobox", { name: "Practice mode" });
    expect(modes).toBeInTheDocument();
    // All four exist in the architecture and all four are offered.
    expect(
      [...modes.querySelectorAll("option")].map((option) => option.getAttribute("value")),
    ).toEqual(["free", "topic", "roleplay", "grammar"]);
  });

  it("changes the prompt in the box, so the mode is visible without reading a label", () => {
    render(<Chat authenticated firstName="Rin" />);
    expect(screen.getByPlaceholderText(/質問をどうぞ/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Speaking practice/ }));
    expect(screen.getByPlaceholderText(/話しかけてください/)).toBeInTheDocument();
  });

  it("can still be typed into while practising", () => {
    // Requirement: a student alternates voice and typing without losing the
    // thread, so the text box never goes away.
    render(<Chat authenticated firstName="Rin" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Speaking practice/ }));
    expect(screen.getByPlaceholderText(/話しかけてください/)).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("offers to read any answer aloud, spoken turn or not", () => {
    // Listening practice is most of what a student wants from a written
    // explanation full of Japanese; they should not have to re-ask by voice.
    chatState = {
      messages: [userMessage("〜ておくは何ですか"), assistantMessage("〜ておく means…")],
      status: "ready",
    };
    render(<Chat authenticated firstName="Rin" />);
    expect(screen.getByRole("button", { name: "Read this answer aloud" })).toBeInTheDocument();
  });
});
