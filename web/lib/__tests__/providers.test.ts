import { beforeEach, describe, expect, it } from "vitest";

import {
  ACCEPT_BUDGET_MS,
  isProviderDead,
  noteProviderFailure,
  resetProviderHealth,
  withDeadline,
} from "@/lib/providers";

/** An AI SDK APICallError carries the upstream status on `statusCode`. */
function apiError(statusCode: number) {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

describe("provider health", () => {
  beforeEach(resetProviderHealth);

  it("starts with every provider available", () => {
    expect(isProviderDead("deepseek")).toBe(false);
  });

  it("retires a provider with an unfunded balance", () => {
    // DeepSeek is prepaid: 402 stands until someone tops the account up, so
    // re-asking every request only spends latency in front of the next tier.
    expect(noteProviderFailure("deepseek", apiError(402))).toBe(true);
    expect(isProviderDead("deepseek")).toBe(true);
  });

  it("retires a provider whose key was revoked or forbidden", () => {
    noteProviderFailure("deepseek", apiError(401));
    expect(isProviderDead("deepseek")).toBe(true);

    resetProviderHealth();
    noteProviderFailure("groq", apiError(403));
    expect(isProviderDead("groq")).toBe(true);
  });

  it("keeps a rate-limited provider available", () => {
    // 429 is the normal free-tier ceiling and clears on its own; retiring the
    // tier would forfeit tomorrow's free quota over today's exhaustion.
    expect(noteProviderFailure("groq", apiError(429))).toBe(false);
    expect(isProviderDead("groq")).toBe(false);
  });

  it("keeps a provider available through an outage", () => {
    noteProviderFailure("google", apiError(500));
    noteProviderFailure("google", apiError(503));
    expect(isProviderDead("google")).toBe(false);
  });

  it("ignores failures that carry no status", () => {
    noteProviderFailure("deepseek", new Error("socket hang up"));
    noteProviderFailure("deepseek", null);
    expect(isProviderDead("deepseek")).toBe(false);
  });

  it("retires each provider independently", () => {
    noteProviderFailure("deepseek", apiError(402));
    expect(isProviderDead("deepseek")).toBe(true);
    expect(isProviderDead("groq")).toBe(false);
    expect(isProviderDead("google")).toBe(false);
  });
});

/** A provider that neither accepts nor refuses. Measured on the live app: an
 * ordinary typed question sat on deepseek-v4-flash for 97 seconds, on a model
 * that answered the same prompt in 1.3s a minute either side of it. The route
 * gets 60, so the student got nothing at all. */
describe("a tier that never answers", () => {
  it("gives up so the next tier can be tried", async () => {
    const stalled = new Promise(() => {});
    await expect(withDeadline(stalled, 20, "tier_timeout")).rejects.toThrow("tier_timeout");
  });

  it("lets a tier that answers in time through untouched", async () => {
    await expect(withDeadline(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("passes a real refusal through as itself, not as a timeout", async () => {
    // The distinction matters: a 402 marks the provider dead for the isolate,
    // a timeout is one slow request.
    const refused = Promise.reject(Object.assign(new Error("unfunded"), { statusCode: 402 }));
    await expect(withDeadline(refused, 1000)).rejects.toThrow("unfunded");
  });

  it("budgets a spoken turn more tightly than a typed one", () => {
    // Someone is standing there waiting in silence for a spoken reply.
    expect(ACCEPT_BUDGET_MS.spoken).toBeLessThan(ACCEPT_BUDGET_MS.typed);
    expect(ACCEPT_BUDGET_MS.typed).toBeLessThan(ACCEPT_BUDGET_MS.structured);
  });
});
