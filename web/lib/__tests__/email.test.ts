import { describe, expect, it } from "vitest";

import { EMAIL_SHAPE, normalizeEmail } from "../email";

describe("normalizeEmail", () => {
  it("passes a plain address through, lowercased and trimmed", () => {
    expect(normalizeEmail("  GR0123ab@ed.ritsumei.ac.jp ")).toBe("gr0123ab@ed.ritsumei.ac.jp");
  });

  it("folds full-width IME characters to ASCII", () => {
    // The exact shape that read as ".ac.jp is blocked": typed with the
    // Japanese IME still on.
    expect(normalizeEmail("ｇｒ０１２３ａｂ＠ｅｄ．ｒｉｔｓｕｍｅｉ．ａｃ．ｊｐ")).toBe(
      "gr0123ab@ed.ritsumei.ac.jp",
    );
    expect(normalizeEmail("gr0123ab＠ed.ritsumei.ac.jp")).toBe("gr0123ab@ed.ritsumei.ac.jp");
  });

  it("trims full-width trailing spaces", () => {
    expect(normalizeEmail("gr0123ab@ed.ritsumei.ac.jp　")).toBe("gr0123ab@ed.ritsumei.ac.jp");
  });

  it("extracts the address from an Outlook-style paste", () => {
    expect(normalizeEmail("山田 太郎 <YT0123@ed.ritsumei.ac.jp>")).toBe(
      "yt0123@ed.ritsumei.ac.jp",
    );
    expect(normalizeEmail("山田 太郎 ＜yt0123@ed.ritsumei.ac.jp＞")).toBe(
      "yt0123@ed.ritsumei.ac.jp",
    );
  });

  it("strips invisible characters that ride along with copy-paste", () => {
    expect(normalizeEmail("gr0123ab@​ed.ritsumei.ac.jp﻿")).toBe(
      "gr0123ab@ed.ritsumei.ac.jp",
    );
  });
});

describe("EMAIL_SHAPE", () => {
  it("accepts normalised school and gmail addresses", () => {
    expect(EMAIL_SHAPE.test("gr0123ab@ed.ritsumei.ac.jp")).toBe(true);
    expect(EMAIL_SHAPE.test("someone@gmail.com")).toBe(true);
  });

  it("rejects obvious non-addresses", () => {
    expect(EMAIL_SHAPE.test("not-an-email")).toBe(false);
    expect(EMAIL_SHAPE.test("two@@ats.ac.jp")).toBe(false);
    expect(EMAIL_SHAPE.test("spaces in@it.ac.jp")).toBe(false);
    expect(EMAIL_SHAPE.test("")).toBe(false);
  });
});
