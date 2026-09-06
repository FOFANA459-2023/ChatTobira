import { beforeEach, describe, expect, it } from "vitest";

import { noteProviderFailure, resetProviderHealth } from "@/lib/providers";
import { routeModels, routeReason } from "@/lib/router";

beforeEach(() => resetProviderHealth());

const providers = (task: Parameters<typeof routeModels>[0], options = {}) =>
  routeModels(task, options).map((tier) => tier.provider);

describe("who answers a spoken turn", () => {
  it("asks the fastest tier first, because someone is waiting in silence", () => {
    // Measured: groq 0.42s against deepseek 1.35s on the same short turn.
    expect(providers("voice_turn", { promptTokens: 1200 })).toEqual([
      "groq",
      "deepseek",
      "google",
    ]);
  });

  it("still falls past Groq when a spoken turn somehow gets large", () => {
    expect(providers("voice_turn", { promptTokens: 9000 })).toEqual(["deepseek", "google"]);
  });
});

describe("who answers a typed question", () => {
  it("puts DeepSeek first, because that is the job Groq cannot hold", () => {
    // A typed answer carries six passages of textbook. Groq's free tier is a
    // shared 7,000 input tokens a minute, so it refuses these at scale.
    expect(providers("chat_answer", { promptTokens: 5000 })).toEqual([
      "deepseek",
      "groq",
      "google",
    ]);
  });

  it("does not offer Groq a prompt it will refuse with a 413", () => {
    expect(providers("chat_answer", { promptTokens: 8300 })).toEqual(["deepseek", "google"]);
  });
});

describe("who builds a practice paper", () => {
  it("keeps the metered free tiers for work that needs them", () => {
    // Gemini's structured-output budget is 20 requests a day; one student
    // pressing "New Test" can spend it in an afternoon.
    expect(providers("structured", { promptTokens: 3000 })).toEqual([
      "deepseek",
      "groq",
      "google",
    ]);
  });
});

describe("health and configuration", () => {
  it("skips a provider that has proven dead this isolate", () => {
    noteProviderFailure("deepseek", { statusCode: 402 });
    expect(providers("chat_answer", { promptTokens: 3000 })).toEqual(["groq", "google"]);
  });

  it("skips DeepSeek entirely when the deployment has no key", () => {
    expect(providers("chat_answer", { promptTokens: 3000, hasDeepSeek: false })).toEqual([
      "groq",
      "google",
    ]);
  });

  it("never returns an empty chain, however bad things get", () => {
    noteProviderFailure("groq", { statusCode: 401 });
    noteProviderFailure("deepseek", { statusCode: 402 });
    const tiers = routeModels("chat_answer", { promptTokens: 9000, hasDeepSeek: false });
    // Google is the tier that has to answer when the others cannot, so it is
    // never health-checked out of the list.
    expect(tiers.map((t) => t.provider)).toEqual(["google"]);
  });

  it("lets a deploy move a tier to another model without a code change", () => {
    const tiers = routeModels("voice_turn", {
      promptTokens: 500,
      models: { groq: "qwen/qwen3.6-27b" },
    });
    expect(tiers[0]).toEqual({ provider: "groq", model: "qwen/qwen3.6-27b" });
    // Unnamed tiers keep their defaults.
    expect(tiers.find((t) => t.provider === "deepseek")?.model).toBe("deepseek-v4-flash");
  });

  it("says why the order came out that way, for the log", () => {
    const tiers = routeModels("chat_answer", { promptTokens: 8300 });
    expect(routeReason("chat_answer", tiers, 8300)).toBe(
      "route chat_answer ~8300tok → deepseek,google",
    );
  });
});
