import { describe, expect, it } from "vitest";

import { firstNameFrom } from "../name";

describe("firstNameFrom", () => {
  it("prefers the first name captured at sign-in", () => {
    expect(firstNameFrom({ first_name: "sameer" }, "x@y.com")).toBe("Sameer");
  });

  it("takes the first word of a full name", () => {
    expect(firstNameFrom({ full_name: "Sameer Motwani" }, null)).toBe("Sameer");
  });

  it("falls back to a name-like email local part", () => {
    expect(firstNameFrom(undefined, "sameer.motwani@gmail.com")).toBe("Sameer");
  });

  it("strips trailing digits from the email guess", () => {
    expect(firstNameFrom({}, "hana2004@ed.ritsumei.ac.jp")).toBe("Hana");
  });

  it("refuses ID-style university addresses rather than greet a serial number", () => {
    expect(firstNameFrom(undefined, "gr0123bx@ed.ritsumei.ac.jp")).toBeNull();
  });

  it("returns null with nothing to go on", () => {
    expect(firstNameFrom(undefined, undefined)).toBeNull();
  });
});
