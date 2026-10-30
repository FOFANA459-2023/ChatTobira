import { describe, expect, it } from "vitest";

import { isPermanentRefusal, PROVIDER_REFUSED_TEXT } from "../provider-refusal";

/* Every string below is one this app has actually been given, not an invented
 * shape. The two in the first block were observed on 2026-10-30, from a key
 * whose credits had run out: the first came back from the embedding call the
 * chat route makes before it can search the corpus, the second in the close
 * frame of a live session. */
describe("isPermanentRefusal", () => {
  it("knows an exhausted account from the embedding call's own words", () => {
    expect(
      isPermanentRefusal(
        "embed failed: 402 RESOURCE_EXHAUSTED Your prepayment credits are depleted. " +
          "Please go to AI Studio at https://ai.studio/projects to manage your project and billing.",
      ),
    ).toBe(true);
  });

  it("knows it from a live session's close frame", () => {
    expect(
      isPermanentRefusal("Your prepayment credits are depleted. Please go to AI Studio"),
    ).toBe(true);
  });

  it("knows a revoked or mistyped key", () => {
    expect(isPermanentRefusal("API key not valid. Please pass a valid API key.")).toBe(true);
    expect(isPermanentRefusal("PERMISSION_DENIED")).toBe(true);
  });

  it("leaves a transient failure alone, so recovery still happens", () => {
    // 1011 is "internal error" and is also what a momentary server hiccup
    // sends. Calling those final would end a lecture that a reconnection
    // would have carried through the blip.
    expect(isPermanentRefusal("internal error")).toBe(false);
    expect(isPermanentRefusal("socket hang up")).toBe(false);
    expect(isPermanentRefusal("The operation was aborted")).toBe(false);
    expect(isPermanentRefusal("tier_timeout")).toBe(false);
  });

  it("treats a missing reason as transient rather than final", () => {
    expect(isPermanentRefusal(undefined)).toBe(false);
    expect(isPermanentRefusal(null)).toBe(false);
    expect(isPermanentRefusal("")).toBe(false);
  });
});

describe("PROVIDER_REFUSED_TEXT", () => {
  it("does not read as the student's own allowance running out", () => {
    // The student has an allowance of their own, and it resets. This failure
    // is neither, so the sentence must not borrow its vocabulary.
    expect(PROVIDER_REFUSED_TEXT).not.toMatch(/credit|allowance left|minutes|resets/i);
    expect(PROVIDER_REFUSED_TEXT).toMatch(/not your allowance/);
  });

  it("names someone who can fix it, since the student cannot", () => {
    expect(PROVIDER_REFUSED_TEXT).toMatch(/@/);
  });

  it("does not invite a retry that is certain to fail", () => {
    expect(PROVIDER_REFUSED_TEXT).not.toMatch(/try again/i);
  });
});
