import { describe, expect, it } from "vitest";

import { contextBlock, systemPrompt } from "@/lib/prompt";
import type { RetrievedChunk } from "@/lib/retrieval";

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunk_id: 1,
    document_id: 1,
    doc_title: "Foundation 3 Past Papers",
    doc_type: "past_paper",
    is_citable: false,
    pdf_page: 1,
    book_page: null,
    content: "I. 動詞を選んで、正しい形にかえてください。",
    metadata: { exam_term: "24秋", paper_title: "文法クイズ", topic: "T8" },
    score: 1,
    similarity: 0.8,
    ...overrides,
  };
}

describe("past papers in the chat context block", () => {
  it("names a past paper as one, with the sitting and topic printed on it", () => {
    // "class handout: Found 2 Papers" was the old header, and it cost the
    // answer its best sentence: the model cannot say "this came up on the
    // Topic 8 quiz" if the context never told it that is what this is.
    const block = contextBlock([chunk()]);
    expect(block).toContain("past exam paper: 24秋 文法クイズ Topic 8");
    expect(block).not.toContain("class handout");
  });

  it("claims no sitting for a paper whose header did not transcribe", () => {
    const block = contextBlock([chunk({ metadata: {} })]);
    expect(block).toContain("--- past exam paper ---");
    expect(block).not.toContain("undefined");
    expect(block).not.toContain("null");
  });

  it("still labels an ordinary handout a handout", () => {
    const block = contextBlock([
      chunk({ doc_type: "grammar", doc_title: "T7 G1", metadata: {} }),
    ]);
    expect(block).toContain("class handout: T7 G1");
  });

  it("still leads a textbook excerpt with its printed page", () => {
    const block = contextBlock([
      chunk({ doc_type: "textbook", is_citable: true, doc_title: "Foundation 3", book_page: "55" }),
    ]);
    expect(block).toContain("Foundation 3, p. 55");
    expect(block).not.toContain("past exam paper");
  });
});

describe("the past-paper rules in the system prompt", () => {
  it("appear only when a past paper was actually retrieved", () => {
    // A model told how to talk about past papers with none in front of it
    // starts referring to them anyway — the same failure the upload rules
    // had, and the reason those are conditional too.
    expect(systemPrompt({}, { hasPastPapers: true })).toContain("past exam paper");
    expect(systemPrompt({}, {})).not.toContain("past exam paper");
  });

  it("keep the textbook authoritative over a paper", () => {
    const prompt = systemPrompt({}, { hasPastPapers: true });
    expect(prompt).toContain("the textbook is right");
  });

  it("forbid inventing exam facts and frequency claims", () => {
    const prompt = systemPrompt({}, { hasPastPapers: true });
    expect(prompt).toMatch(/never invent a mark scheme, a date, an exam name/);
    expect(prompt).toMatch(/commonly tested/);
  });
});
