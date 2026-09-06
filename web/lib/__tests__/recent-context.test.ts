import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  conversationKey,
  recallContext,
  rememberContext,
  resetRecentContext,
} from "@/lib/recent-context";
import type { RetrievedChunk } from "@/lib/retrieval";

beforeEach(() => {
  resetRecentContext();
  vi.useRealTimers();
});

function chunk(id: number, content = "〜ておくは準備の意味です。"): RetrievedChunk {
  return {
    chunk_id: id,
    document_id: 1,
    doc_title: "Foundation 3 Textbook",
    doc_type: "textbook",
    is_citable: true,
    pdf_page: id,
    book_page: String(100 + id),
    content,
    metadata: {},
    score: 0.5,
    similarity: 0.7,
  } as RetrievedChunk;
}

describe("keying a conversation", () => {
  it("uses the conversation row when there is one", () => {
    expect(conversationKey(42, "anything")).toBe("c42");
  });

  it("falls back to the opening question, so trial visitors are covered too", () => {
    // A trial visitor has no conversation row at all, and their follow-up
    // deserves the same grounding as anyone else's.
    expect(conversationKey(undefined, "  What does 〜ておく mean?  ")).toBe(
      "qWhat does 〜ておく mean?",
    );
  });

  it("has no key for a conversation with nothing in it", () => {
    expect(conversationKey(undefined, "   ")).toBeNull();
  });
});

describe("keeping the last turn's grounding", () => {
  it("hands back what the previous answer was built from", () => {
    rememberContext("c1", [chunk(1), chunk(2)]);
    expect(recallContext("c1").map((c) => c.chunk_id)).toEqual([1, 2]);
  });

  it("knows nothing about a conversation it has not seen", () => {
    expect(recallContext("c9")).toEqual([]);
    expect(recallContext(null)).toEqual([]);
  });

  it("never stores an empty context, which would look like a miss anyway", () => {
    rememberContext("c1", [chunk(1)]);
    rememberContext("c1", []);
    expect(recallContext("c1")).toHaveLength(1);
  });

  it("replaces the grounding when the conversation moves on", () => {
    rememberContext("c1", [chunk(1)]);
    rememberContext("c1", [chunk(7)]);
    expect(recallContext("c1").map((c) => c.chunk_id)).toEqual([7]);
  });

  it("forgets a conversation that has gone cold", () => {
    vi.useFakeTimers();
    rememberContext("c1", [chunk(1)]);
    vi.advanceTimersByTime(11 * 60 * 1000);
    // "why?" typed after lunch gets a fresh search, not the morning's pages.
    expect(recallContext("c1")).toEqual([]);
  });

  it("evicts the conversation nobody has touched for longest", () => {
    for (let i = 0; i < 24; i++) rememberContext(`c${i}`, [chunk(i)]);
    // Touching c0 again makes it the most recent, so c1 is now the coldest.
    rememberContext("c0", [chunk(100)]);
    rememberContext("new", [chunk(999)]);

    expect(recallContext("c0")).toHaveLength(1);
    expect(recallContext("c1")).toEqual([]);
    expect(recallContext("new")).toHaveLength(1);
  });
});
