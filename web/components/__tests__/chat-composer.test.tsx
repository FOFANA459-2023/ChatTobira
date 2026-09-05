import { render, screen } from "@testing-library/react";
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
      // The mic is a conversation switch now: one press starts a spoken
      // exchange, one press ends it, and nothing is pressed in between.
      "Start a spoken conversation",
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

/** Voice, from the composer's side.
 *
 * The mode selector is gone. It asked the student to declare, before saying
 * anything, whether this was free conversation, topic practice, role play or
 * grammar practice — which is a question no conversation partner asks, and
 * one the tutor can answer for itself from what is actually said.
 */
describe("voice", () => {
  it("offers a spoken conversation to a signed-in student", () => {
    render(<Chat authenticated firstName="Rin" />);
    expect(
      screen.getByRole("button", { name: "Start a spoken conversation" }),
    ).toBeInTheDocument();
  });

  it("keeps it behind sign-in, like every other stored feature", () => {
    // /api/transcribe and /api/speak both refuse an anonymous caller, so a
    // button that could never work should not be on the screen.
    render(<Chat authenticated={false} />);
    expect(
      screen.queryByRole("button", { name: "Start a spoken conversation" }),
    ).not.toBeInTheDocument();
  });

  it("asks the student to choose no mode at all", () => {
    render(<Chat authenticated firstName="Rin" />);
    expect(screen.queryByRole("combobox", { name: "Practice mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Speaking practice/ })).not.toBeInTheDocument();
    for (const gone of [/Role play/i, /Free conversation/i, /Topic practice/i, /Grammar practice/i]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("keeps the text box available so a student can switch by typing", () => {
    // Modality follows what the student is doing. Typing is the switch back
    // to text, so the box never goes away.
    render(<Chat authenticated firstName="Rin" />);
    expect(screen.getByPlaceholderText(/質問をどうぞ/)).toBeEnabled();
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
