import { beforeEach, describe, expect, it } from "vitest";

import {
  isProviderDead,
  noteProviderFailure,
  resetProviderHealth,
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
