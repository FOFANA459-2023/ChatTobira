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
  it("asks the tier that is reliably fast first", () => {
    // Groq measured 0.55s to first token. deepseek-v4-flash measured 1.3-2.3s
    // when healthy, and on this app also produced a 97s stall and a 12s
    // timeout on ordinary turns. Reliability decides the order, not ceiling.
    expect(providers("chat_answer", { promptTokens: 5000 })).toEqual([
      "groq",
      "deepseek",
      "google",
    ]);
  });

  it("still leads with DeepSeek for a prompt Groq would refuse", () => {
    // No special case needed: the size filter drops Groq, and DeepSeek is
    // next. This is the job DeepSeek is genuinely needed for.
    expect(providers("chat_answer", { promptTokens: 8300 })).toEqual(["deepseek", "google"]);
  });


});

describe("who builds a practice paper", () => {
  it("never offers a paper to a reasoning model", () => {
    // Measured on the real QuizSchema: groq gpt-oss-120b 6.2s, deepseek-v4-flash
    // 134.2s — 15,490 of its 17,493 output tokens were reasoning. The route's
    // own ceiling is 60s, so DeepSeek cannot finish a paper inside a request
    // at all, and a live kanji paper took 61.4s before this was fixed.
    expect(providers("structured", { promptTokens: 3000 })).not.toContain("deepseek");
  });

  it("asks the model that actually produces a usable paper first", () => {
    // Measured on the real prompt: gemini-3.5-flash-lite returned 17 items
    // with a 198-character passage in 7.5s; groq gpt-oss-120b returned 17
    // items with a 113-character passage, which the validator rejects. Groq
    // also meters prompt plus reserved output against 8,000 tokens a minute,
    // so a paper only fits there when nothing else is happening.
    const tiers = routeModels("structured", { promptTokens: 3000 });
    expect(tiers.map((t) => t.provider)).toEqual(["google", "groq", "groq"]);
    expect(tiers.map((t) => t.model)).toEqual([
      "gemini-3.6-flash",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ]);
  });

  it("moves the two Groq quiz models independently of the chat model", () => {
    // They share a provider and nothing else: the chat model is picked for
    // first-token latency, the quiz models for schema support.
    const tiers = routeModels("structured", {
      promptTokens: 3000,
      models: { chat: "qwen/qwen3.6-27b", quiz: "openai/gpt-oss-20b" },
    });
    expect(tiers.find((t) => t.provider === "groq")?.model).toBe("openai/gpt-oss-20b");
    expect(tiers.map((t) => t.model)).not.toContain("qwen/qwen3.6-27b");
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
      models: { chat: "qwen/qwen3.6-27b" },
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
