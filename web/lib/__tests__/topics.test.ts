import { describe, expect, it } from "vitest";

import { aspectOf, printedForms, topicRefs } from "@/lib/topics";
import {
  broadenQuery,
  isThinResult,
  rankTopicPages,
  resolveQuery,
  type RetrievedChunk,
} from "@/lib/retrieval";

describe("topicRefs", () => {
  it("reads a division however the student writes it", () => {
    for (const text of ["topic 14", "Topic14", "T14", "トピック 14", "トピック14", "unit 14"]) {
      expect(topicRefs(text)[0]).toMatchObject({ marker: "T14", number: 14 });
    }
  });

  it("reads a lesson, which is what the Intermediate books call a division", () => {
    expect(topicRefs("lesson 3")[0]).toMatchObject({ number: 3, kind: "lesson" });
    expect(topicRefs("第3課")[0]).toMatchObject({ number: 3, kind: "lesson" });
  });

  it("finds the division inside a whole sentence", () => {
    expect(topicRefs("list all the vocabularies for topic 14")[0].marker).toBe("T14");
  });

  it("does not invent one", () => {
    expect(topicRefs("what does 忘れ物 mean?")).toEqual([]);
    expect(topicRefs("I have 40 minutes to study")).toEqual([]);
  });
});

describe("printedForms", () => {
  // Measured against the corpus: the Foundation 3 book prints 「トピック 14」
  // with a space on pp. 53–57. Searching for the un-spaced form finds nothing.
  it("includes the spelling the books actually print", () => {
    expect(printedForms({ marker: "T14", number: 14, kind: "topic" })).toContain("トピック 14");
  });

  it("uses 第N課 for a lesson", () => {
    expect(printedForms({ marker: "T3", number: 3, kind: "lesson" })).toContain("第3課");
  });
});

describe("aspectOf", () => {
  it("knows which part of a topic was asked for", () => {
    expect(aspectOf("list all the vocabularies for topic 14")?.label).toBe("vocabulary");
    expect(aspectOf("語彙を教えて")?.label).toBe("vocabulary");
    expect(aspectOf("what kanji are in topic 14")?.label).toBe("kanji");
    expect(aspectOf("the grammar points of topic 14")?.label).toBe("grammar");
    expect(aspectOf("tell me about topic 14")).toBeNull();
  });
});

describe("resolveQuery — carrying a division across turns", () => {
  const conversation = [
    { role: "user", text: "list all the vocabularies for topic 14" },
    { role: "assistant", text: "I could not find that." },
    { role: "user", text: "i mean topic 14" },
    { role: "assistant", text: "I still cannot find it." },
    { role: "user", text: "yes i know it is in foundation 3" },
  ];

  it("keeps the division after the student stops repeating it", () => {
    // The final message names no topic at all. Losing it here is what made
    // the app answer "I still can't find it" three times running.
    expect(resolveQuery(conversation).topics[0]).toMatchObject({ marker: "T14" });
  });

  it("resolves against the real question, not the last nudge", () => {
    const query = resolveQuery(conversation);
    expect(query.isFollowUp).toBe(true);
    expect(query.text).toContain("list all the vocabularies for topic 14");
  });

  it("finds the division in the first message too", () => {
    expect(resolveQuery([conversation[0]]).topics[0]).toMatchObject({ marker: "T14" });
  });
});

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunk_id: 1,
    document_id: 1,
    doc_title: "Foundation 3",
    doc_type: "textbook",
    is_citable: true,
    pdf_page: 10,
    book_page: "55",
    content: "…",
    metadata: {},
    score: 0,
    similarity: 0.8,
    ...over,
  };
}

describe("isThinResult", () => {
  it("is thin when nothing came back", () => {
    expect(isThinResult([])).toBe(true);
  });

  it("is thin when the best candidate is only the best of a bad set", () => {
    expect(isThinResult([chunk({ similarity: 0.5 }), chunk({ similarity: 0.45 })])).toBe(true);
  });

  it("is not thin when something is genuinely close", () => {
    expect(isThinResult([chunk({ similarity: 0.75 })])).toBe(false);
  });

  it("is not thin when a page literally contains what was named", () => {
    expect(isThinResult([chunk({ similarity: 0, exact: true })])).toBe(false);
  });
});

describe("broadenQuery", () => {
  it("asks again in the words the corpus is written in", () => {
    const broadened = broadenQuery(
      "list all the vocabularies for topic 14",
      topicRefs("topic 14"),
      aspectOf("list all the vocabularies for topic 14"),
    );
    expect(broadened).toContain("トピック 14");
    expect(broadened).toContain("語彙");
    // The scaffolding of the sentence is gone.
    expect(broadened).not.toContain("list all");
  });
});

describe("rankTopicPages", () => {
  const ref = { marker: "T14", number: 14, kind: "topic" as const };
  const page = (content: string, is_citable = true) => ({ content, documents: { is_citable } });

  it("puts the page that belongs to the topic above one that mentions it", () => {
    const ranked = rankTopicPages(
      [
        page("see also トピック 14 for related vocabulary".padStart(200, "x")),
        page("トピック 14 新しい語彙 Nouns 形 shape 三角 triangle"),
      ],
      ref,
      aspectOf("vocabulary"),
    );
    expect(ranked[0].content).toContain("新しい語彙");
  });

  it("prefers the part of the topic the student asked for", () => {
    const ranked = rankTopicPages(
      [
        page("トピック 14 漢字 practice writing 短い"),
        page("トピック 14 新しい語彙 vocabulary list"),
      ],
      ref,
      aspectOf("what vocabulary is in topic 14"),
    );
    expect(ranked[0].content).toContain("語彙");
  });

  it("prefers the textbook over a handout when nothing else separates them", () => {
    const ranked = rankTopicPages(
      [page("トピック 14 notes", false), page("トピック 14 notes", true)],
      ref,
      null,
    );
    expect(ranked[0].documents.is_citable).toBe(true);
  });
});
