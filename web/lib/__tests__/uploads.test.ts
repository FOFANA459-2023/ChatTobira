import { describe, expect, it } from "vitest";

import { contextBlock } from "../prompt";
import type { RetrievedChunk } from "../retrieval";
import {
  corpusPath,
  isAcceptedType,
  safeFilename,
  storageKey,
  TOPICS_BY_LEVEL,
} from "../uploads";

describe("accepted types", () => {
  it("takes photos and PDFs", () => {
    for (const type of ["image/jpeg", "image/png", "image/heic", "application/pdf"]) {
      expect(isAcceptedType(type)).toBe(true);
    }
  });

  it("refuses Office formats, which cannot be read in the Worker at all", () => {
    for (const type of [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/msword",
      "application/vnd.ms-excel",
    ]) {
      expect(isAcceptedType(type)).toBe(false);
    }
  });

  it("refuses executables and archives outright", () => {
    expect(isAcceptedType("application/zip")).toBe(false);
    expect(isAcceptedType("text/html")).toBe(false);
  });
});

describe("safeFilename", () => {
  it("keeps Japanese filenames intact — most handouts here have them", () => {
    expect(safeFilename("文法復習シート_T12(答え).pdf")).toBe("文法復習シート_T12(答え).pdf");
  });

  it("strips path separators so a name cannot escape its folder", () => {
    expect(safeFilename("../../etc/passwd")).toBe("..-..-etc-passwd");
    expect(safeFilename("a\\b:c*d?e.pdf")).toBe("a-b-c-d-e.pdf");
  });

  it("replaces a name that is only punctuation, not merely an empty one", () => {
    // ".." survives separator-stripping intact and would still mean "the
    // parent directory" once joined into a corpus path.
    expect(safeFilename("..")).toBe("upload");
    expect(safeFilename(".")).toBe("upload");
    expect(safeFilename("///")).toBe("upload");
    expect(safeFilename("   ")).toBe("upload");
  });
});

describe("corpus path traversal", () => {
  it("cannot produce a path segment that escapes the uploads folder", () => {
    const path = corpusPath("F3", "T13", "../../../.env");
    expect(path.split("/").filter((s) => s === ".." || s === "")).toHaveLength(0);
    expect(path.startsWith("Foundation 3/")).toBe(true);
  });
});

describe("storageKey", () => {
  it("scopes every object under the uploader's id", () => {
    const key = storageKey("abc-123", 7, "application/pdf");
    expect(key).toBe("abc-123/7.pdf");
  });

  it("does not depend on the filename, which may be non-ASCII", () => {
    // backup.py hit a real InvalidKey on a combining dakuten; keys are built
    // from ids for exactly that reason.
    expect(storageKey("u", 9, "image/png")).toBe("u/9.png");
  });
});

describe("corpusPath", () => {
  it("files an upload where discover() will read its level and topic back", () => {
    expect(corpusPath("F3", "T13", "worksheet.pdf")).toBe(
      "Foundation 3/T13 Student uploads/worksheet.pdf",
    );
  });

  it("keeps contributed material visibly separate from class handouts", () => {
    expect(corpusPath("F2", null, "notes.png")).toContain("Student uploads");
  });

  it("maps each level to its real folder in the materials tree", () => {
    expect(corpusPath("F2", "T6", "a.pdf")).toBe("Foundation 2/T6 Student uploads/a.pdf");
    expect(corpusPath("INT", "T1", "a.pdf")).toBe("Intermediate/T1 Student uploads/a.pdf");
  });
});

describe("topics offered per level", () => {
  it("starts Foundation 3 at Topic 11, where its textbook actually begins", () => {
    expect(TOPICS_BY_LEVEL.F3[0]).toBe("T11");
    expect(TOPICS_BY_LEVEL.F3).not.toContain("T10");
  });

  it("covers Topics 11-20, the range the ingested book actually carries", () => {
    // The course handouts stop at T17, but the textbook runs to T20 and it
    // is the book a student photographs a page out of.
    expect(TOPICS_BY_LEVEL.F3).toContain("T20");
    expect(TOPICS_BY_LEVEL.F3).toHaveLength(10);
  });

  it("covers Topics 1-10 for the Foundation 1 & 2 book", () => {
    expect(TOPICS_BY_LEVEL.F2).toContain("T1");
    expect(TOPICS_BY_LEVEL.F2).toContain("T10");
  });
});

function chunk(content: string, citable = true): RetrievedChunk {
  return {
    chunk_id: 1,
    document_id: 1,
    doc_title: "Foundation 3 Textbook",
    doc_type: "textbook",
    is_citable: citable,
    pdf_page: 1,
    book_page: "104",
    content,
    metadata: {},
    score: 1,
    similarity: 0.8,
  };
}

describe("contextBlock with an attached upload", () => {
  it("labels an upload distinctly from the textbook", () => {
    const block = contextBlock(
      [chunk("textbook content")],
      [{ filename: "my-worksheet.pdf", extracted: "student worksheet content" }],
    );
    expect(block).toContain("[your upload] my-worksheet.pdf");
    expect(block).toContain("[citable] Foundation 3 Textbook");
    // The upload leads: it is what the student asked about.
    expect(block.indexOf("[your upload]")).toBeLessThan(block.indexOf("[citable]"));
  });

  it("caps an upload so a long scan cannot crowd out the textbook", () => {
    const block = contextBlock(
      [chunk("TEXTBOOK_MARKER")],
      [{ filename: "huge.pdf", extracted: "x".repeat(50_000) }],
    );
    expect(block.length).toBeLessThan(12_000);
    expect(block).toContain("TEXTBOOK_MARKER");
  });

  it("still answers from an upload when retrieval found nothing", () => {
    const block = contextBlock([], [{ filename: "a.png", extracted: "けいご" }]);
    expect(block).toContain("けいご");
    expect(block).not.toContain("No source material matched");
  });

  it("reports no material only when there is genuinely none", () => {
    expect(contextBlock([], [])).toContain("No source material matched");
  });
});
