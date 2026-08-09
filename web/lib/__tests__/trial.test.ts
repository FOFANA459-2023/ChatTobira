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
  it("offers three chat questions and one practice test", () => {
    expect(TRIALS.chat.limit).toBe(3);
    expect(TRIALS.quiz.limit).toBe(1);
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
    const chatSpent = withCookies("tobira_trial=3");
    expect(trialExhausted(chatSpent, "chat")).toBe(true);
    expect(trialExhausted(chatSpent, "quiz")).toBe(false);

    const quizSpent = withCookies("tobira_quiz_trial=1");
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
    expect(trialExhausted(withCookies("tobira_trial=2"), "chat")).toBe(false);
    expect(trialExhausted(withCookies("tobira_trial=3"), "chat")).toBe(true);
    expect(trialExhausted(withCookies("tobira_trial=9"), "chat")).toBe(true);
  });

  it("issues a cookie the page cannot casually clear", () => {
    const cookie = trialCookie("quiz", 1);
    expect(cookie).toContain("tobira_quiz_trial=1");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
  });
});
