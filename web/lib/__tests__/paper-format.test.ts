import { describe, expect, it } from "vitest";

import {
  archetypes,
  blueprint,
  instructionLanguage,
  markLine,
  type Level,
} from "@/lib/paper-format";
import type { QuizKind } from "@/lib/quiz";

const LEVELS: Level[] = ["F2", "F3"];
const KINDS: QuizKind[] = ["grammar", "kanji"];

describe("the assessment-format catalogue", () => {
  it("never asks for four lettered options, which the course never prints", () => {
    // The single most important finding of the survey. The old hand-written
    // template demanded exactly four choices on every choice question; across
    // the 40 sat papers in the corpus the course prints two or three inside a
    // bracket, or three under a〜c, or four under a〜d for kanji vocabulary —
    // and never A) B) C) D).
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        for (const archetype of archetypes(level, kind)) {
          if (archetype.choices !== undefined) {
            expect(archetype.choices, `${archetype.id}`).toBeGreaterThanOrEqual(2);
            expect(archetype.choices, `${archetype.id}`).toBeLessThanOrEqual(5);
          }
        }
      }
    }
  });

  it("gives every archetype the evidence it was derived from", () => {
    // A format claim with no paper behind it is a guess, and a guess in here
    // is indistinguishable from a measurement.
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        for (const archetype of archetypes(level, kind)) {
          expect(archetype.seenOn, archetype.id).toMatch(/T\d/);
          expect(archetype.instructionJa.length, archetype.id).toBeGreaterThan(5);
          expect(archetype.objective.length, archetype.id).toBeGreaterThan(10);
        }
      }
    }
  });

  it("only lists option counts on forms that have options", () => {
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        for (const a of archetypes(level, kind)) {
          const listed = a.form === "bracket" || a.form === "lettered";
          expect(Boolean(a.choices), a.id).toBe(listed);
        }
      }
    }
  });

  it("keeps item ranges the papers could actually hold", () => {
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        for (const a of archetypes(level, kind)) {
          const [min, max] = a.items;
          expect(min, a.id).toBeGreaterThanOrEqual(2);
          expect(max, a.id).toBeLessThanOrEqual(8); // the schema's per-section cap
          expect(max, a.id).toBeGreaterThanOrEqual(min);
        }
      }
    }
  });
});

describe("blueprints", () => {
  it("plans a paper for every level and kind", () => {
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        const plan = blueprint(level, kind);
        expect(plan.length, `${level}/${kind}`).toBeGreaterThanOrEqual(3);
        // The schema caps a paper at five sections.
        expect(plan.length, `${level}/${kind}`).toBeLessThanOrEqual(5);
      }
    }
  });

  it("draws only on the catalogue for that level and kind", () => {
    // A Foundation 2 paper built from a Foundation 3 section would drill the
    // right book at the wrong difficulty — the mismatch the past papers were
    // ingested to fix.
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        const allowed = new Set(archetypes(level, kind).map((a) => a.id));
        for (const section of blueprint(level, kind)) {
          expect(allowed.has(section.id), `${level}/${kind}: ${section.id}`).toBe(true);
        }
      }
    }
  });

  it("gives Foundation 3 grammar its dialogue-and-word-bank section", () => {
    // 2点×5 through 2×10=20 across T12, T13, T14, T15 and T17: the dominant
    // Foundation 3 grammar item, and the paper is not that paper without it.
    const plan = blueprint("F3", "grammar").map((a) => a.id);
    expect(plan).toContain("f3g_dialogue_bank");
  });

  it("opens Foundation 2 grammar with the in-place bracket section", () => {
    // The commonest question in the corpus, and the first section of the
    // papers that use it.
    expect(blueprint("F2", "grammar")[0].id).toBe("f2g_bracket");
  });

  it("never plans two sections that both own a passage it cannot show twice", () => {
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        const withPassage = blueprint(level, kind).filter((a) => a.passage);
        expect(withPassage.length, `${level}/${kind}`).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe("instruction language", () => {
  it("follows the papers: English early in Foundation 2, then Japanese", () => {
    // Measured, not chosen. Foundation 2 papers up to Topic 6 print their
    // instructions in English only; from Topic 7 they print Japanese with an
    // English line beneath.
    expect(instructionLanguage("F2", 3)).toBe("en");
    expect(instructionLanguage("F2", 6)).toBe("en");
    expect(instructionLanguage("F2", 7)).toBe("ja+en");
    expect(instructionLanguage("F2", 11)).toBe("ja+en");
  });

  it("is Japanese throughout Foundation 3", () => {
    expect(instructionLanguage("F3", 12)).toBe("ja");
    expect(instructionLanguage("F3", null)).toBe("ja");
  });

  it("treats an unscoped Foundation 2 paper as a later one", () => {
    // A whole-book paper is not an early-topic paper, and heading it in
    // English would look wrong to a student who sat Topic 11.
    expect(instructionLanguage("F2", null)).toBe("ja+en");
  });
});

describe("mark lines", () => {
  it("prints them the way the papers do", () => {
    expect(markLine(1, 5)).toBe("(1×5)");
    expect(markLine(2, 5)).toBe("(2点×5)");
    expect(markLine(3, 3)).toBe("(3点×3)");
  });
});
