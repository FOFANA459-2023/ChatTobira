import { describe, expect, it } from "vitest";

import { placeUploads, toUIMessages, turnRows } from "../history";

describe("turnRows", () => {
  it("gives the question and the answer the same columns, so one bulk insert cannot null a NOT NULL one", () => {
    // PostgREST fills a column one row of a bulk insert leaves out with NULL,
    // not its default. The question row used to leave out `citations`, which
    // is NOT NULL, and every typed chat turn failed to save from 2026-09-04.
    const [question, answer] = turnRows({
      conversationId: 73,
      question: "What is the te-form of 行く?",
      askedAt: "2026-09-22T08:00:00Z",
      answer: "行って",
      answeredAt: "2026-09-22T08:00:03Z",
      citations: [{ document_id: 1, title: "Foundation 1 & 2", book_page: "112", quote: "行って" }],
      model: "gemini",
    });
    expect(Object.keys(question).sort()).toEqual(Object.keys(answer).sort());
    expect(question).toMatchObject({ role: "user", citations: [], model: null });
    expect(answer).toMatchObject({ role: "assistant", model: "gemini", conversation_id: 73 });
    expect(answer.citations).toHaveLength(1);
  });
});

const message = (id: number, role: "user" | "assistant", at: string) => ({
  id,
  role,
  content: `${role} ${id}`,
  citations: null,
  model: role === "assistant" ? "gemini" : null,
  created_at: at,
});

const upload = (id: number, status: string, at: string, error: string | null = null) => ({
  id,
  filename: `page-${id}.jpg`,
  status,
  error,
  created_at: at,
});

describe("toUIMessages", () => {
  it("gives saved turns ids that cannot collide with new ones, and keeps the chat id on answers", () => {
    const ui = toUIMessages(
      [message(7, "user", "2026-09-22T01:00:00Z"), message(8, "assistant", "2026-09-22T01:00:05Z")],
      42,
    );
    expect(ui.map((m) => m.id)).toEqual(["saved-7", "saved-8"]);
    expect(ui[0].parts).toEqual([{ type: "text", text: "user 7" }]);
    expect(ui[0].metadata).toBeUndefined();
    expect(ui[1].metadata).toMatchObject({ conversationId: 42, model: "gemini", citations: [] });
  });
});

describe("placeUploads", () => {
  const messages = [
    message(1, "user", "2026-09-22T01:00:00Z"),
    message(2, "assistant", "2026-09-22T01:00:05Z"),
    message(3, "user", "2026-09-22T01:05:00Z"),
    message(4, "assistant", "2026-09-22T01:05:05Z"),
  ];

  it("puts each file after the turns written before it", () => {
    const placed = placeUploads(
      [
        // Added to a new chat before its first question.
        upload(10, "ready", "2026-09-22T00:59:00Z"),
        // Added between the first answer and the second question.
        upload(11, "ready", "2026-09-22T01:03:00Z"),
      ],
      messages,
    );
    expect(placed.map((u) => [u.id, u.after])).toEqual([
      [10, 0],
      [11, 2],
    ]);
  });

  it("shows a failed file as failed, any other finished one as ready, and drops one that never finished", () => {
    const placed = placeUploads(
      [
        upload(20, "failed", "2026-09-22T01:01:00Z", "Too blurry to read."),
        upload(21, "submitted", "2026-09-22T01:01:00Z"),
        upload(22, "pending", "2026-09-22T01:01:00Z"),
      ],
      messages,
    );
    expect(placed).toEqual([
      expect.objectContaining({ id: 20, status: "failed", detail: "Too blurry to read." }),
      expect.objectContaining({ id: 21, status: "ready", detail: undefined }),
    ]);
  });
});
