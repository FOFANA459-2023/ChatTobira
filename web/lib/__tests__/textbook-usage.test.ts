import { describe, expect, it } from "vitest";

import {
  attestedKanji,
  groundingScore,
  houseStyle,
  houseStyleBlock,
  offStyleForms,
  unattestedKanji,
  VARIANTS,
} from "@/lib/textbook-usage";

/** A page of the kind of Japanese the Foundation book is written in, with a
 * form repeated often enough to be a house style rather than an accident. */
function book(form: string, times: number, other = "", otherTimes = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < times; i++) lines.push(`これはペンです。あれは本${form}。`);
  for (let i = 0; i < otherTimes; i++) lines.push(`これはペンです。あれは本${other}。`);
  return lines.join("\n");
}

describe("house style", () => {
  it("finds the form the material uses and names the one it does not", () => {
    const style = houseStyle([book("じゃありません", 12, "ではありません", 1)]);
    const negative = style.find((entry) => entry.id === "negative-copula");
    expect(negative?.prefer).toContain("じゃありません");
    expect(negative?.avoid).toContain("ではありません");
  });

  it("says nothing when the material uses both", () => {
    // The Foundation 1 & 2 book writes じゃありません nine times and
    // じゃないです eight. Picking a winner between those would invent a rule the
    // course does not have, and a model told to follow it would produce
    // sentences the book contradicts on the next page.
    const style = houseStyle([book("じゃありません", 9, "じゃないです", 8)]);
    const negative = style.find((entry) => entry.id === "negative-copula");
    expect(negative?.prefer).toEqual(
      expect.arrayContaining(["じゃありません", "じゃないです"]),
    );
    expect(negative?.avoid ?? []).not.toContain("じゃないです");
  });

  it("says nothing at all from a thin sample", () => {
    // Three instances is not a house style. A rule asserted from three
    // instances is worse than no rule, because the prompt states it as a fact
    // about the student's book.
    expect(houseStyle([book("じゃありません", 3)])).toEqual([]);
  });

  it("does not call a form absent when the book merely prefers another", () => {
    // とても 33, たいへん 5 in the Foundation 3 book. たいへん is taught, is
    // used, and must not be forbidden — only a form beaten eight to one is
    // reported as one this course does not write.
    const corpus = [
      Array.from({ length: 33 }, () => "とてもおいしいです。").join(""),
      Array.from({ length: 5 }, () => "たいへんおいしいです。").join(""),
    ];
    const style = houseStyle(corpus);
    const very = style.find((entry) => entry.id === "very");
    expect(very?.avoid ?? []).not.toContain("たいへん");
  });

  it("counts a nested form once, for the longer of the two", () => {
    // じゃないです contains じゃない. Counting both reported a preference for
    // a form that never stood on its own.
    const style = houseStyle([book("じゃないです", 10, "ではありません", 1)]);
    const negative = style.find((entry) => entry.id === "negative-copula");
    expect(negative?.counts["じゃない"]).toBe(0);
    expect(negative?.counts["じゃないです"]).toBe(10);
  });

  it("prefers the excerpts and falls back to the book", () => {
    // Scope beats sample size. The Foundation 1 & 2 book spans Topics 1 to 10
    // and writes 友達 fifty-two times, nearly all in the kanji section for the
    // later topics, while a Topic 2 page writes ともだち — so a Topic 2 paper
    // told "this book writes 友達" is told something true about the book and
    // wrong about the topic.
    const excerpts = [Array.from({ length: 9 }, () => "ともだちと話します。").join("")];
    const whole = [Array.from({ length: 60 }, () => "友達と話します。").join("")];
    const scoped = houseStyle(excerpts, whole).find((entry) => entry.id === "friend");
    expect(scoped?.prefer).toContain("ともだち");
    expect(scoped?.from).toBe("excerpts");

    // With nothing in the excerpts to go on, the whole book answers instead.
    const unscoped = houseStyle(["これはペンです。"], whole).find((e) => e.id === "friend");
    expect(unscoped?.prefer).toContain("友達");
    expect(unscoped?.from).toBe("book");
  });

  it("ignores furigana, which is annotation and not text", () => {
    // 友達《ともだち》 is one instance of 友達, not one of each.
    const style = houseStyle([
      Array.from({ length: 10 }, () => "友達《ともだち》と話します。").join(""),
    ]);
    const friend = style.find((entry) => entry.id === "friend");
    expect(friend?.counts["ともだち"]).toBe(0);
    expect(friend?.counts["友達"]).toBe(10);
  });

  it("writes a prompt block a model can act on, or nothing", () => {
    expect(houseStyleBlock([])).toBe("");
    const block = houseStyleBlock(houseStyle([book("じゃありません", 12, "ではありません", 1)]));
    expect(block).toContain("じゃありません");
    expect(block).toContain("Never write ではありません");
  });

  it("finds an off-style form in a generated item", () => {
    const style = houseStyle([book("じゃありません", 12, "ではありません", 1)]);
    expect(offStyleForms("これは本ではありません。", style)).toContain("ではありません");
    expect(offStyleForms("これは本じゃありません。", style)).toEqual([]);
  });

  it("keeps every variant set free of a form listed twice", () => {
    // A form in two sets would be preferred by one rule and forbidden by
    // another, and which won would depend on array order.
    const seen = new Map<string, string>();
    for (const variant of VARIANTS) {
      for (const form of variant.forms) {
        expect(seen.has(form), `${form} in ${variant.id} and ${seen.get(form)}`).toBe(false);
        seen.set(form, variant.id);
      }
    }
  });
});

describe("attestation", () => {
  const material = ["今日は学校へ行きます。", "図書館で本を読みました。"];

  it("collects the characters the material actually prints", () => {
    const attested = attestedKanji(material);
    expect(attested.has("学")).toBe(true);
    expect(attested.has("図")).toBe(true);
    expect(attested.has("徒")).toBe(false);
  });

  it("names a character the book never prints", () => {
    // Seen live: a Foundation 2 paper drilling 徒歩, which is an ordinary word
    // and is not in the Foundation 1 & 2 book. A student cannot revise from
    // that item and cannot tell why — it just looks like something they failed
    // to learn.
    expect(unattestedKanji("徒歩で行きます。", attestedKanji(material))).toEqual(
      expect.arrayContaining(["徒", "歩"]),
    );
    expect(unattestedKanji("学校へ行きます。", attestedKanji(material))).toEqual([]);
  });

  it("does not count a reading as an unknown character", () => {
    // 図書館《としょかん》 — the reading is annotation the app adds, not text
    // the item asks about.
    expect(unattestedKanji("図書館《としょかん》で読みます。", attestedKanji(material))).toEqual([]);
  });

  it("scores how much of a paper the material accounts for", () => {
    const attested = attestedKanji(material);
    expect(groundingScore(["学校で本を読みます。"], attested)).toBe(1);
    expect(groundingScore(["徒歩"], attested)).toBe(0);
    expect(groundingScore([], attested)).toBe(1);
  });
});
