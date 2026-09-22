import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Chat } from "../chat";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: vi.fn(), getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    storage: { from: () => ({ uploadToSignedUrl: vi.fn() }) },
  }),
}));

/** A useChat whose transcript is real state, so setMessages is observable. */
const setMessagesSpy = vi.fn();
vi.mock("@ai-sdk/react", async () => {
  const { useState } = await import("react");
  return {
    useChat: (options: { messages?: unknown[] }) => {
      const [messages, setMessages] = useState(options.messages ?? []);
      return {
        messages,
        setMessages: (next: unknown[]) => {
          setMessagesSpy(next);
          setMessages(next);
        },
        sendMessage: vi.fn(),
        clearError: vi.fn(),
        status: "ready",
        error: undefined,
      };
    },
  };
});

const CONVERSATIONS = [
  { id: 12, title: "て-form of 行く", createdAt: "2026-09-21T03:00:00Z" },
  { id: 9, title: "Topic 8 kanji", createdAt: "2026-09-18T03:00:00Z" },
];

const saved = (id: number, role: "user" | "assistant", text: string) => ({
  id: `saved-${id}`,
  role,
  parts: [{ type: "text" as const, text }],
});

function savedChat(id: number, messages: ReturnType<typeof saved>[]) {
  return new Response(JSON.stringify({ id, messages, uploads: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

/** The desktop column. The phone drawer holds the same panel. */
const sidebar = () => within(screen.getByRole("navigation", { name: "Saved chats" }));

beforeEach(() => {
  setMessagesSpy.mockClear();
  window.history.replaceState(null, "", "/");
  window.scrollTo = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat sidebar", () => {
  it("lists a signed-in student's saved chats", () => {
    render(<Chat authenticated firstName="Rin" conversations={CONVERSATIONS} />);
    expect(sidebar().getByText("て-form of 行く")).toBeInTheDocument();
    expect(sidebar().getByText("Topic 8 kanji")).toBeInTheDocument();
  });

  it("gives a trial visitor the practice pages and a way to sign up, but no saved chats", () => {
    render(<Chat authenticated={false} />);
    expect(screen.queryByRole("navigation", { name: "Saved chats" })).not.toBeInTheDocument();
    const practice = within(screen.getByRole("navigation", { name: "Practice" }));
    expect(practice.getByRole("link", { name: /Speaking/ })).toHaveAttribute("href", "/speaking");
    expect(screen.getAllByRole("link", { name: "Sign up" })[0]).toHaveAttribute("href", "/signup");
  });

  it("opens a saved chat in place, and puts it in the address", async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      void url;
      return Promise.resolve(
        savedChat(9, [
          saved(1, "user", "Topic 8 kanji please"),
          saved(2, "assistant", "Here they are."),
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Chat authenticated firstName="Rin" conversations={CONVERSATIONS} />);

    fireEvent.click(sidebar().getByRole("button", { name: "Topic 8 kanji" }));

    expect(await screen.findByText("Topic 8 kanji please")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations?id=9");
    expect(window.location.search).toBe("?c=9");
  });

  it("starts loading a chat on hover, so the click itself sends nothing", async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      void url;
      return Promise.resolve(savedChat(9, [saved(1, "user", "Topic 8 kanji please")]));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Chat authenticated firstName="Rin" conversations={CONVERSATIONS} />);

    const row = sidebar().getByRole("button", { name: "Topic 8 kanji" });
    fireEvent.pointerEnter(row);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(row);

    expect(await screen.findByText("Topic 8 kanji please")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("goes back to a chat it has left without asking the server again", async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      void url;
      return Promise.resolve(savedChat(9, [saved(1, "user", "Topic 8 kanji please")]));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <Chat
        authenticated
        firstName="Rin"
        conversations={CONVERSATIONS}
        initial={{ id: 12, messages: [saved(5, "user", "行く のて-form は？")], uploads: [] }}
      />,
    );

    fireEvent.click(sidebar().getByRole("button", { name: "Topic 8 kanji" }));
    await screen.findByText("Topic 8 kanji please");
    fireEvent.click(sidebar().getByRole("button", { name: "て-form of 行く" }));

    expect(await screen.findByText("行く のて-form は？")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("starts a new chat without losing the saved one", async () => {
    render(
      <Chat
        authenticated
        firstName="Rin"
        conversations={CONVERSATIONS}
        initial={{ id: 12, messages: [saved(1, "user", "行く のて-form は？")], uploads: [] }}
      />,
    );
    expect(screen.getByText("行く のて-form は？")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /New chat/ })[0]);

    await waitFor(() =>
      expect(screen.queryByText("行く のて-form は？")).not.toBeInTheDocument(),
    );
    expect(setMessagesSpy).toHaveBeenCalledWith([]);
    expect(window.location.search).toBe("");
    expect(sidebar().getByRole("button", { name: "て-form of 行く" })).toBeInTheDocument();
  });

  it("renames a chat in place and saves the new name", () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      void url;
      void init;
      return Promise.resolve(ok());
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Chat authenticated firstName="Rin" conversations={CONVERSATIONS} />);

    fireEvent.click(sidebar().getByRole("button", { name: "Rename Topic 8 kanji" }));
    const input = sidebar().getByRole("textbox", { name: "Chat name" });
    fireEvent.change(input, { target: { value: "Kanji for the Topic 8 test" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      sidebar().getByRole("button", { name: "Kanji for the Topic 8 test" }),
    ).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ id: 9, title: "Kanji for the Topic 8 test" });
  });

  it("puts the old name back when the rename is not saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 500 }))),
    );
    render(<Chat authenticated firstName="Rin" conversations={CONVERSATIONS} />);

    fireEvent.click(sidebar().getByRole("button", { name: "Rename Topic 8 kanji" }));
    const input = sidebar().getByRole("textbox", { name: "Chat name" });
    fireEvent.change(input, { target: { value: "Something else" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await sidebar().findByRole("button", { name: "Topic 8 kanji" })).toBeInTheDocument();
  });

  it("deletes a chat after asking, and leaves it if the student says no", () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      void url;
      void init;
      return Promise.resolve(ok());
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.spyOn(window, "confirm");
    render(<Chat authenticated firstName="Rin" conversations={CONVERSATIONS} />);

    confirm.mockReturnValueOnce(false);
    fireEvent.click(sidebar().getByRole("button", { name: "Delete Topic 8 kanji" }));
    expect(sidebar().getByRole("button", { name: "Topic 8 kanji" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    fireEvent.click(sidebar().getByRole("button", { name: "Delete Topic 8 kanji" }));
    expect(sidebar().queryByRole("button", { name: "Topic 8 kanji" })).not.toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toEqual({ id: 9 });
  });

  it("clears the screen when the open chat is the one deleted", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok())));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <Chat
        authenticated
        firstName="Rin"
        conversations={CONVERSATIONS}
        initial={{ id: 12, messages: [saved(1, "user", "行く のて-form は？")], uploads: [] }}
      />,
    );

    fireEvent.click(sidebar().getByRole("button", { name: "Delete て-form of 行く" }));

    await waitFor(() =>
      expect(screen.queryByText("行く のて-form は？")).not.toBeInTheDocument(),
    );
    expect(window.location.search).toBe("");
  });
});

describe("files in the chat", () => {
  it("shows an added file in the transcript where it was added, not above the composer", () => {
    render(
      <Chat
        authenticated
        firstName="Rin"
        initial={{
          id: 12,
          messages: [
            saved(1, "user", "Can you check my homework?"),
            saved(2, "assistant", "Of course."),
          ],
          uploads: [{ id: 5, filename: "homework-p3.jpg", status: "ready", after: 1 }],
        }}
      />,
    );
    const card = screen.getByText("homework-p3.jpg");
    const question = screen.getByText("Can you check my homework?");
    const answer = screen.getByText("Of course.");
    // Between the question it came with and the answer to it.
    expect(question.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing parked in the composer.
    expect(screen.getByRole("button", { name: "Send" }).closest("form")).not.toContainElement(card);
  });

  it("opens a ready file in the browser from its name, and keeps it when removed from the chat", () => {
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      void url;
      void init;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <Chat
        authenticated
        firstName="Rin"
        initial={{
          id: 12,
          messages: [saved(1, "user", "Can you check my homework?")],
          uploads: [
            { id: 5, filename: "homework-p3.jpg", status: "ready", after: 1 },
            { id: 6, filename: "still-going.jpg", status: "reading", after: 1 },
          ],
        }}
      />,
    );

    const link = screen.getByRole("link", { name: "homework-p3.jpg" });
    expect(link).toHaveAttribute("href", "/api/upload/view?id=5");
    expect(link).toHaveAttribute("target", "_blank");
    // Nothing to open until it has finished uploading.
    expect(screen.queryByRole("link", { name: "still-going.jpg" })).not.toBeInTheDocument();
    // Students no longer offer files to the knowledge base themselves.
    expect(screen.queryByRole("button", { name: /share/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove homework-p3.jpg from this chat" }));
    expect(screen.queryByText("homework-p3.jpg")).not.toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/upload");
    expect(init?.method).toBe("DELETE");
  });

  it("counts a file as the start of a chat, so the welcome gives way to it", () => {
    render(
      <Chat
        authenticated
        firstName="Rin"
        initial={{
          id: 12,
          messages: [],
          uploads: [{ id: 5, filename: "worksheet.pdf", status: "ready", after: 0 }],
        }}
      />,
    );
    expect(screen.getByText("worksheet.pdf")).toBeInTheDocument();
    expect(screen.queryByText(/Welcome to ChatTobira/)).not.toBeInTheDocument();
  });
});
