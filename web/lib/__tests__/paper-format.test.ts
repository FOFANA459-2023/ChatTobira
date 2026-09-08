import { describe, expect, it } from "vitest";

import {
  archetypes,
  blueprint,
  fitsTopic,
  planPaper,
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

  it("never plans more than two sections that write their own passage", () => {
    // Two texts is what a paper — and the model's output budget — can carry.
    // A section that says 「上の文について」 does not count: it repeats the
    // text above it, which is how the Foundation 3 papers print their ○×
    // block under the cloze it is about.
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        for (let variant = 0; variant < 6; variant++) {
          const owners = planPaper(level, kind, { variant }).filter(
            (a) => a.passage && !a.sharesPassage,
          );
          expect(owners.length, `${level}/${kind} v${variant}`).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it("never plans a 「上の文について」 section with no passage above it", () => {
    // Planned alone it asks about a text nobody printed, which is the exact
    // fault the route throws whole papers away for.
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        for (let variant = 0; variant < 6; variant++) {
          const plan = planPaper(level, kind, { variant });
          plan.forEach((section, index) => {
            if (!section.sharesPassage) return;
            const above = plan
              .slice(0, index)
              .some((earlier) => earlier.passage && !earlier.sharesPassage);
            expect(above, `${level}/${kind} v${variant}: ${section.id}`).toBe(true);
          });
        }
      }
    }
  });
});

describe("coverage of the real papers", () => {
  it("can reach every section type the corpus contains", () => {
    // The failure this guards against is silent and was live: the catalogue
    // held fifteen section archetypes and the fixed blueprint used four, so
    // eleven real question types — the question-word fill, the plain-form
    // conversion, the kanji-radical composition, the English→katakana
    // transcription — could not appear on any generated paper however many a
    // student sat. Rotation is only worth having if it reaches all of them.
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        const reachable = new Set<string>();
        for (let variant = 0; variant < 20; variant++) {
          for (const section of planPaper(level, kind, { variant })) reachable.add(section.id);
        }
        for (const archetype of archetypes(level, kind)) {
          expect(reachable.has(archetype.id), `${level}/${kind}: ${archetype.id}`).toBe(true);
        }
      }
    }
  });

  it("moves the paper on between sittings", () => {
    // Two students' second papers should not be their first papers. The spine
    // is shared by design — every Foundation 2 grammar paper opens with the
    // bracket section, because every sat one does — so what has to change is
    // the rotating slot.
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        const first = planPaper(level, kind, { variant: 0 }).map((a) => a.id);
        const second = planPaper(level, kind, { variant: 1 }).map((a) => a.id);
        expect(second, `${level}/${kind}`).not.toEqual(first);
      }
    }
  });

  it("is deterministic for a given variant", () => {
    // A paper has to be reproducible from the row in quiz_items, or a bad
    // section cannot be traced back to the plan that asked for it.
    expect(planPaper("F3", "kanji", { variant: 3 })).toEqual(
      planPaper("F3", "kanji", { variant: 3 }),
    );
  });

  it("never plans a section the topic has not reached", () => {
    // A Topic 3 paper cannot ask for the plain form: the course teaches it in
    // Topic 10. Getting this wrong does not produce a broken paper, it
    // produces a paper the student is entitled to get wrong.
    const early = planPaper("F2", "grammar", { topic: 3, variant: 0 }).map((a) => a.id);
    expect(early).not.toContain("f2g_plain_form");
    expect(early).not.toContain("f2g_form_table");
    expect(early).toContain("f2g_bracket");

    const late = planPaper("F2", "grammar", { topic: 10, variant: 3 });
    expect(late.every((a) => fitsTopic(a, 10))).toBe(true);
  });

  it("drops the question-word section once the course moves past it", () => {
    // Seen on Topics 1, 3, 4, 5 and 6 and on no paper after Topic 8.
    const early = planPaper("F2", "grammar", { topic: 4, variant: 0 }).map((a) => a.id);
    expect(early).toContain("f2g_question_word");
    for (let variant = 0; variant < 8; variant++) {
      const late = planPaper("F2", "grammar", { topic: 11, variant }).map((a) => a.id);
      expect(late, `v${variant}`).not.toContain("f2g_question_word");
    }
  });

  it("still plans a paper when the topic rules most of the catalogue out", () => {
    // Topic 1 predates the word bank, the reading passage and everything
    // else with a fromTopic. A paper of two sections is still a paper; no
    // paper at all is an error message.
    const plan = planPaper("F2", "grammar", { topic: 1, variant: 0 });
    expect(plan.length).toBeGreaterThanOrEqual(2);
    expect(plan.every((a) => fitsTopic(a, 1))).toBe(true);
  });

  it("gives every archetype a skill, a weight and distractor guidance", () => {
    // The three fields the prompt is built from. An archetype missing any of
    // them produces a section the model has to guess the shape of.
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        for (const a of archetypes(level, kind)) {
          expect(a.skill, a.id).toMatch(/^[a-z-]+$/);
          expect(a.weight, a.id).toBeGreaterThan(0);
          expect(a.guidance.length, a.id).toBeGreaterThan(40);
        }
      }
    }
  });

  it("keeps the sections a paper opens with at the front", () => {
    // The order is the papers': quick in-place items, then the word bank
    // carrying the marks, then the passage. A plan that closes with the
    // bracket section is a plan for a paper nobody sat.
    for (const level of LEVELS) {
      for (const kind of KINDS) {
        for (let variant = 0; variant < 6; variant++) {
          const plan = planPaper(level, kind, { variant });
          const orders = plan.map((a) => a.order);
          expect([...orders].sort((x, y) => x - y), `${level}/${kind} v${variant}`).toEqual(orders);
        }
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
