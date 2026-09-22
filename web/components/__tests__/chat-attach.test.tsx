import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Chat } from "../chat";
import type { AttachedFile } from "../upload-button";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));

/** The upload button, reduced to what the chat does with it: a file is
 * attached, then its status moves on as the server reads it. */
let attach: (file: AttachedFile) => void = () => {};
let update: (id: number, patch: Partial<AttachedFile>) => void = () => {};
vi.mock("@/components/upload-button", () => ({
  UploadButton: (props: {
    onAttached: (file: AttachedFile) => void;
    onUpdate: (id: number, patch: Partial<AttachedFile>) => void;
  }) => {
    attach = props.onAttached;
    update = props.onUpdate;
    return <button type="button" aria-label="Attach a photo or PDF" />;
  },
}));

/** useChat with a real transcript, and the request body the chat would send
 * built at the moment of sending — which is what the server sees. */
const sent: { text: string; body: { uploadIds?: number[] } }[] = [];
vi.mock("@ai-sdk/react", async () => {
  const { useState } = await import("react");
  return {
    useChat: (options: { messages?: unknown[]; transport: { body: () => object } }) => {
      const [messages, setMessages] = useState<unknown[]>(options.messages ?? []);
      return {
        messages,
        setMessages,
        sendMessage: ({ text }: { text: string }) => {
          sent.push({ text, body: options.transport.body() as { uploadIds?: number[] } });
          setMessages((all) => [
            ...all,
            { id: `u${all.length}`, role: "user", parts: [{ type: "text", text }] },
          ]);
          return Promise.resolve();
        },
        clearError: vi.fn(),
        status: "ready",
        error: undefined,
      };
    },
  };
});

const composer = () => screen.getByPlaceholderText(/ask in Japanese or English/);
const sendButton = () => screen.getByRole("button", { name: "Send" });

beforeEach(() => {
  sent.length = 0;
  window.scrollTo = vi.fn();
});

describe("attaching a file", () => {
  it("holds the file in the composer until the question goes out", () => {
    render(<Chat authenticated firstName="Rin" />);
    act(() => attach({ id: 7, filename: "homework-p3.jpg", status: "uploading" }));

    const staged = within(screen.getByRole("list", { name: "Attached files" }));
    expect(staged.getByText("homework-p3.jpg")).toBeInTheDocument();
    expect(staged.getByText("uploading…")).toBeInTheDocument();
    // Not in the transcript yet: nothing has been sent.
    expect(screen.queryByRole("link", { name: "homework-p3.jpg" })).not.toBeInTheDocument();
  });

  it("will not send until the file has been read, so the question never goes without it", () => {
    render(<Chat authenticated firstName="Rin" />);
    act(() => attach({ id: 7, filename: "homework-p3.jpg", status: "uploading" }));
    fireEvent.change(composer(), { target: { value: "Can you check question 2?" } });

    act(() => update(7, { status: "reading" }));
    expect(sendButton()).toBeDisabled();
    fireEvent.submit(composer().closest("form")!);
    expect(sent).toHaveLength(0);

    act(() => update(7, { status: "ready" }));
    expect(sendButton()).toBeEnabled();
  });

  it("sends the file with the question, then keeps it in the chat for the next one", () => {
    render(<Chat authenticated firstName="Rin" />);
    act(() => attach({ id: 7, filename: "homework-p3.jpg", status: "uploading" }));
    act(() => update(7, { status: "ready" }));
    fireEvent.change(composer(), { target: { value: "Can you check question 2?" } });
    fireEvent.click(sendButton());

    expect(sent[0]).toEqual({ text: "Can you check question 2?", body: expect.objectContaining({ uploadIds: [7] }) });
    // Out of the composer, into the transcript above the question.
    expect(screen.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();
    const card = screen.getByRole("link", { name: "homework-p3.jpg" });
    const question = screen.getByText("Can you check question 2?");
    expect(card.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // A follow-up about the same page still carries it.
    fireEvent.change(composer(), { target: { value: "And question 3?" } });
    fireEvent.click(sendButton());
    expect(sent[1].body.uploadIds).toEqual([7]);
  });

  it("sends a file on its own as just its name, flagged as carrying no instruction", () => {
    render(<Chat authenticated firstName="Rin" />);
    act(() => attach({ id: 9, filename: "worksheet.pdf", status: "uploading" }));
    act(() => update(9, { status: "ready" }));
    expect(sendButton()).toBeEnabled();
    fireEvent.click(sendButton());
    // No request is invented for the student: the tutor is told there is none.
    expect(sent[0].text).toBe("worksheet.pdf");
    expect(sent[0].body).toMatchObject({ uploadIds: [9], attachmentOnly: true });

    // Their next, written message is an instruction like any other.
    fireEvent.change(composer(), { target: { value: "Just give me the answers" } });
    fireEvent.click(sendButton());
    expect((sent[1].body as { attachmentOnly?: boolean }).attachmentOnly).toBeUndefined();
    expect(sent[1].body.uploadIds).toEqual([9]);
  });

  it("does not flag a file sent with a question", () => {
    render(<Chat authenticated firstName="Rin" />);
    act(() => attach({ id: 9, filename: "worksheet.pdf", status: "uploading" }));
    act(() => update(9, { status: "ready" }));
    fireEvent.change(composer(), { target: { value: "Explain question 4" } });
    fireEvent.click(sendButton());
    expect((sent[0].body as { attachmentOnly?: boolean }).attachmentOnly).toBeUndefined();
  });

  it("drops a file from the composer without sending it", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}"))));
    render(<Chat authenticated firstName="Rin" />);
    act(() => attach({ id: 7, filename: "wrong-page.jpg", status: "uploading" }));
    act(() => update(7, { status: "ready" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove wrong-page.jpg" }));
    expect(screen.queryByText("wrong-page.jpg")).not.toBeInTheDocument();

    fireEvent.change(composer(), { target: { value: "Hello" } });
    fireEvent.click(sendButton());
    expect(sent[0].body.uploadIds ?? []).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("does not send a file that could not be read", () => {
    render(<Chat authenticated firstName="Rin" />);
    act(() => attach({ id: 7, filename: "blurry.jpg", status: "uploading" }));
    act(() => update(7, { status: "failed", detail: "Too blurry to read." }));
    expect(screen.getByText("Too blurry to read.")).toBeInTheDocument();
    fireEvent.change(composer(), { target: { value: "What does it say?" } });
    fireEvent.click(sendButton());
    expect(sent[0].body.uploadIds ?? []).toEqual([]);
  });
});
