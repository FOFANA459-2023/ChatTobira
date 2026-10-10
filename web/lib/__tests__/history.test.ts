import { describe, expect, it } from "vitest";

import {
  CONVERSATION_MESSAGES,
  loadConversation,
  translationUIMessages,
  placeUploads,
  toUIMessages,
  turnRows,
} from "../history";
import { recentTurns } from "../prompt";

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

describe("recentTurns — bounded by size as well as by count", () => {
  const turn = (id: number, chars: number) => ({ id, text: "x".repeat(chars) });

  it("keeps ordinary turns by count", () => {
    const messages = Array.from({ length: 30 }, (_, i) => turn(i, 200));
    const kept = recentTurns(messages);
    expect(kept.length).toBe(15);
    expect(kept.at(-1)?.id).toBe(29);
  });

  it("drops older turns when one answer is enormous", () => {
    // A sixty-row verb table is a legitimate answer and a large one. Sixteen
    // of them is a prompt made of the app re-reading itself, which crowds out
    // the course material that makes the next answer right.
    const messages = Array.from({ length: 16 }, (_, i) => turn(i, 20_000));
    const kept = recentTurns(messages);
    expect(kept.length).toBeLessThan(16);
    expect(kept.at(-1)?.id).toBe(15);
  });

  it("never drops the turn the follow-up is about", () => {
    // Even when every turn on its own blows the budget.
    const messages = Array.from({ length: 10 }, (_, i) => turn(i, 500_000));
    const kept = recentTurns(messages);
    expect(kept.length).toBe(4);
    expect(kept.at(-1)?.id).toBe(9);
  });

  it("returns a short conversation untouched", () => {
    const messages = [turn(1, 50), turn(2, 50)];
    expect(recentTurns(messages)).toEqual(messages);
  });
});

describe("loadConversation — a thread has no natural end, so it is capped", () => {
  const row = (id: number) => ({
    id,
    role: "user" as const,
    content: "message " + id,
    citations: null,
    model: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString(),
  });

  /** Enough of PostgREST's builder to record what the query asked for. Each
   * method returns the builder; awaiting it resolves like a PostgREST reply. */
  function fakeClient(messageRows: ReturnType<typeof row>[]) {
    const asked: { order?: { ascending?: boolean }; limit?: number } = {};
    const build = (data: unknown, record: boolean) => {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        order: (_c: string, opts?: { ascending?: boolean }) => {
          if (record) asked.order = opts;
          return b;
        },
        limit: (n: number) => {
          if (record) asked.limit = n;
          return b;
        },
        maybeSingle: () => Promise.resolve({ data }),
        then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
          Promise.resolve({ data, error: null }).then(ok, no),
      });
      return b;
    };
    const client = {
      from: (table: string) =>
        table === "conversations"
          ? build({ id: 7, deleted_at: null }, false)
          : table === "messages"
            ? build(messageRows, true)
            : build([], false),
    };
    return { client, asked };
  }

  it("asks for only the newest CONVERSATION_MESSAGES, not the whole thread", async () => {
    // Uncapped, reopening a chat read every message it had ever held and the
    // browser posted all of them back on the next question. Both halves of
    // that grew with the conversation and neither had a ceiling.
    const { client, asked } = fakeClient([row(1)]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loadConversation(client as any, 7);
    expect(asked.limit).toBe(CONVERSATION_MESSAGES);
    // Newest first is what makes the limit keep the END of the thread. Asking
    // ascending with a limit would hand the student the opening of a long
    // conversation and hide what they just said.
    expect(asked.order?.ascending).toBe(false);
  });

  it("hands them back in the order they were said", async () => {
    // The query is newest-first; everything downstream — placeUploads,
    // toUIMessages, the page — reads a conversation forwards.
    const newestFirst = [row(3), row(2), row(1)];
    const { client } = fakeClient(newestFirst);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loaded = await loadConversation(client as any, 7);
    expect(loaded?.messages.map((m) => m.id)).toEqual(["saved-1", "saved-2", "saved-3"]);
  });
});

describe("a saved lecture, read back", () => {
  const seg = (seq: number, source: string, translated: string) => ({
    seq,
    source_text: source,
    translated_text: translated,
    target_lang: "en",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(),
  });

  it("turns each segment into the pair the chat already draws", () => {
    // What the room heard becomes the student's turn, what it meant becomes
    // the reply — so the existing renderer shows a transcript with no new UI.
    const out = translationUIMessages([seg(0, "こんにちは", "Hello")], 7);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out[0].parts).toEqual([{ type: "text", text: "こんにちは" }]);
    expect(out[1].parts).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("keeps the lecture in order", () => {
    const out = translationUIMessages([seg(0, "A", "one"), seg(1, "B", "two")], 7);
    expect(out.map((m) => m.id)).toEqual([
      "translated-7-0-src",
      "translated-7-0",
      "translated-7-1-src",
      "translated-7-1",
    ]);
  });

  it("writes no blank rows for a cough or a pause", () => {
    // The model produces nothing for filler, and a pause produces no speech.
    // Either way a blank line in the transcript helps nobody.
    expect(translationUIMessages([seg(0, "   ", "")], 7)).toEqual([]);
    expect(translationUIMessages([seg(0, "ええと", "")], 7)).toHaveLength(1);
  });

  it("gives ids that survive a reload, not generated ones", () => {
    const first = translationUIMessages([seg(3, "A", "one")], 7);
    const again = translationUIMessages([seg(3, "A", "one")], 7);
    expect(first.map((m) => m.id)).toEqual(again.map((m) => m.id));
  });
});
