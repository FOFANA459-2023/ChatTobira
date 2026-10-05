import { describe, expect, it } from "vitest";

import {
  TRIALS,
  trialCookie,
  trialExhausted,
  trialUsed,
} from "@/lib/trial";

function withCookies(cookie: string): Request {
  return new Request("https://example.test/api/quiz", { headers: { cookie } });
}

describe("trial metering", () => {
  it("offers the relaxed pitch allowances", () => {
    // TEMPORARY, 2026-10-05: raised for the school pitch. Normally 3, 1 and 2
    // — see the block above TRIALS in lib/trial.ts. The tests below are
    // written against the constants rather than the numbers, so they keep
    // testing the metering itself when these are restored.
    expect(TRIALS.chat.limit).toBe(100);
    expect(TRIALS.quiz.limit).toBe(25);
    expect(TRIALS.feedback.limit).toBe(50);
  });

  it("counts a visitor with no cookie as having spent nothing", () => {
    const request = new Request("https://example.test/api/chat");
    expect(trialUsed(request, "chat")).toBe(0);
    expect(trialExhausted(request, "chat")).toBe(false);
  });

  it("reads each trial from its own cookie", () => {
    const request = withCookies("tobira_trial=2; tobira_quiz_trial=1");
    expect(trialUsed(request, "chat")).toBe(2);
    expect(trialUsed(request, "quiz")).toBe(1);
  });

  it("keeps the two trials independent", () => {
    // Sampling the chat must not consume the free practice test, and vice
    // versa: they are different tastes of the product.
    const chatSpent = withCookies(`tobira_trial=${TRIALS.chat.limit}`);
    expect(trialExhausted(chatSpent, "chat")).toBe(true);
    expect(trialExhausted(chatSpent, "quiz")).toBe(false);

    const quizSpent = withCookies(`tobira_quiz_trial=${TRIALS.quiz.limit}`);
    expect(trialExhausted(quizSpent, "quiz")).toBe(true);
    expect(trialExhausted(quizSpent, "chat")).toBe(false);
  });

  it("does not let one cookie name match another as a prefix", () => {
    // "tobira_trial" is a prefix of nothing here, but "tobira_quiz_trial"
    // contains "trial" — a loose pattern would read the wrong counter.
    const request = withCookies("tobira_quiz_trial=1");
    expect(trialUsed(request, "chat")).toBe(0);
  });

  it("treats a malformed counter as unspent rather than crashing", () => {
    expect(trialUsed(withCookies("tobira_trial=abc"), "chat")).toBe(0);
    expect(trialUsed(withCookies("tobira_trial="), "chat")).toBe(0);
    expect(trialUsed(withCookies("unrelated=7"), "chat")).toBe(0);
  });

  it("counts a trial as exhausted only once the limit is reached", () => {
    const limit = TRIALS.chat.limit;
    expect(trialExhausted(withCookies(`tobira_trial=${limit - 1}`), "chat")).toBe(false);
    expect(trialExhausted(withCookies(`tobira_trial=${limit}`), "chat")).toBe(true);
    expect(trialExhausted(withCookies(`tobira_trial=${limit + 6}`), "chat")).toBe(true);
  });

  it("issues a cookie the page cannot casually clear", () => {
    const cookie = trialCookie("quiz", 1);
    expect(cookie).toContain("tobira_quiz_trial=1");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
  });
});
