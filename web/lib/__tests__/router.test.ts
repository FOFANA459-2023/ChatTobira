import { beforeEach, describe, expect, it } from "vitest";

import { noteProviderFailure, resetProviderHealth } from "@/lib/providers";
import { routeModels, routeReason } from "@/lib/router";

beforeEach(() => resetProviderHealth());

/** Tier KEYS, not provider names. The structured cascade asks Google twice,
 * and a list reading ["google", "google", "groq"] cannot say which two Gemini
 * models that is. */
const keys = (task: Parameters<typeof routeModels>[0], options = {}) =>
  routeModels(task, options).map((tier) => tier.key);

describe("who answers a spoken turn", () => {
  it("asks the fastest tier first, because someone is waiting in silence", () => {
    // Measured: groq 0.62s, flash-lite 0.77s, deepseek 1.33s on the same
    // short turn.
    expect(keys("voice_turn", { promptTokens: 1200 })).toEqual(["groq", "google", "deepseek"]);
  });

  it("puts Gemini ahead of DeepSeek for second place, which is a real place", () => {
    // Groq's ceiling is metered per MINUTE across the whole deployment, so
    // two classmates speaking at once is enough to push the second one down a
    // tier. That student now waits 0.77s instead of 1.33s.
    const [, second] = keys("voice_turn", { promptTokens: 1200 });
    expect(second).toBe("google");
  });

  it("still falls past Groq when a spoken turn somehow gets large", () => {
    expect(keys("voice_turn", { promptTokens: 9000 })).toEqual(["google", "deepseek"]);
  });
});

describe("who answers a typed question", () => {
  it("puts Gemini first, because it is both the fastest and the one that fits", () => {
    // The change the app is judged on. On the same ~4,600-token prompt:
    // flash-lite 0.94s against deepseek-v4-flash 5.22s. DeepSeek led this
    // list only while the Google key was rationed to twenty requests a day.
    expect(keys("chat_answer", { promptTokens: 5000 })).toEqual([
      "google",
      "groq",
      "deepseek",
    ]);
  });

  it("does not offer Groq a prompt it will refuse with a 413", () => {
    expect(keys("chat_answer", { promptTokens: 8300 })).toEqual(["google", "deepseek"]);
  });

  it("keeps DeepSeek as the tier that absorbs what nothing else will take", () => {
    // Demoted from primary, not dropped. It is uncapped and cheap, and on a
    // day when the paid key is rate-limited it is the only tier left that can
    // hold six passages of textbook.
    expect(keys("chat_answer", { promptTokens: 8300 })).toContain("deepseek");
  });
});

describe("who builds a practice paper", () => {
  it("asks the fast flash tier first, Pro behind it, then the free backstop", () => {
    // Speed leads because Pro, measured on six-section papers, took 22-48s
    // and once 56 — past the route's own 55-second deadline, which is the
    // "Could not generate a test" students saw. 3.8-flash at +128 wrote the
    // same papers in 8-12s and did not fail once in eight runs.
    expect(keys("structured", { promptTokens: 3000 })).toEqual([
      "google-fast",
      "google-fast-retry",
      "google-pro",
      "groq",
    ]);
  });

  it("retries the fast tier with the fast tier's own configuration", () => {
    // A retry is the same request again, so a deploy that moves the fast
    // model moves both attempts — but it fails and recovers on its own key.
    const tiers = routeModels("structured", {
      promptTokens: 3000,
      models: { "google-fast": "gemini-3.9-flash" },
    });
    const retry = tiers.find((t) => t.key === "google-fast-retry")!;
    expect(retry.model).toBe("gemini-3.9-flash");
    expect(retry.config).toBe("google-fast");
  });

  it("caps reasoning on both Gemini paper tiers", () => {
    // Pro refuses 0 ("only works in thinking mode"). 3.8-flash accepts 0 but
    // failed schema at 0 and at 512; 128 was the one budget that never did.
    const [fast, pro] = routeModels("structured", { promptTokens: 3000 });
    expect(fast.thinkingBudget).toBe(128);
    expect(pro.thinkingBudget).toBe(128);
  });

  it("leaves the chat tiers on their own default, which is measured too", () => {
    // Not an oversight. On this app's chat prompts flash-lite spends 0-97
    // tokens reasoning, so a budget would be a number nobody had measured.
    expect(routeModels("chat_answer", {})[0].thinkingBudget).toBeUndefined();
  });

  it("still gives DeepSeek the jobs it is good at", () => {
    expect(keys("chat_answer", { promptTokens: 3000 })).toContain("deepseek");
    expect(keys("voice_turn", { promptTokens: 500 })).toContain("deepseek");
    // And not the one it cannot do: 138 seconds on a 60-second route.
    expect(keys("structured", { promptTokens: 3000 })).not.toContain("deepseek");
  });
});

describe("health and configuration", () => {
  it("skips a tier that has proven dead this isolate", () => {
    noteProviderFailure("deepseek", { statusCode: 402 });
    expect(keys("chat_answer", { promptTokens: 3000 })).toEqual(["google", "groq"]);
  });

  it("drops a dead Gemini tier without taking the one behind it", () => {
    // The reason health is keyed on the tier and not the provider. Both of
    // these are the Google client; a Pro that keeps timing out must not take
    // the flash tier down with it, because the flash tier is the fallback.
    noteProviderFailure("google-pro", { statusCode: 403 });
    expect(keys("structured", { promptTokens: 3000 })).toEqual([
      "google-fast",
      "google-fast-retry",
      "groq",
    ]);
  });

  it("skips DeepSeek entirely when the deployment has no key", () => {
    expect(keys("chat_answer", { promptTokens: 3000, hasDeepSeek: false })).toEqual([
      "google",
      "groq",
    ]);
  });

  it("never returns an empty chain, however bad things get", () => {
    // Gemini used to be exempt from health checks so the list could not empty.
    // That exemption stopped being safe when Gemini moved to the FRONT: a rule
    // that refuses to skip a dead first tier is a guaranteed wasted round trip,
    // not a safety net. The guard is about emptiness now, and it falls back to
    // the BOTTOM of the cascade — the tier chosen to be the one that still
    // answers on a bad day.
    noteProviderFailure("google", { statusCode: 401 });
    noteProviderFailure("deepseek", { statusCode: 402 });
    const tiers = routeModels("chat_answer", { promptTokens: 3000 });
    expect(tiers.map((t) => t.key)).toEqual(["groq"]);
  });

  it("will not fall back onto a tier the prompt cannot fit", () => {
    // Even at the bottom of a bad day, handing Groq a prompt it has already
    // said it cannot take is not a last-ditch attempt, it is a 413.
    noteProviderFailure("google", { statusCode: 401 });
    noteProviderFailure("deepseek", { statusCode: 402 });
    const tiers = routeModels("chat_answer", { promptTokens: 9000 });
    expect(tiers.map((t) => t.key)).toEqual(["deepseek"]);
  });

  it("lets a deploy move a tier to another model without a code change", () => {
    const tiers = routeModels("voice_turn", {
      promptTokens: 500,
      models: { groq: "qwen/qwen3.6-27b" },
    });
    expect(tiers[0]).toEqual({
      provider: "groq",
      key: "groq",
      model: "qwen/qwen3.6-27b",
      thinkingBudget: undefined,
      config: "groq",
    });
    // Unnamed tiers keep their defaults.
    expect(tiers.find((t) => t.key === "deepseek")?.model).toBe("deepseek-v4-flash");
  });

  it("names the two Gemini tiers separately, so a deploy can move one", () => {
    // They shared FALLBACK_MODEL while there was one Google slot, which is
    // what kept papers on the chat model after the key could afford Pro.
    const tiers = routeModels("structured", {
      promptTokens: 3000,
      models: { "google-pro": "gemini-3.1-pro-preview" },
    });
    expect(tiers[0].model).toBe("gemini-3.8-flash");
    expect(tiers.find((t) => t.key === "google-pro")!.model).toBe("gemini-3.1-pro-preview");
  });

  it("says why the order came out that way, for the log", () => {
    const tiers = routeModels("chat_answer", { promptTokens: 8300 });
    expect(routeReason("chat_answer", tiers, 8300)).toBe(
      "route chat_answer ~8300tok → google,deepseek",
    );
  });
});
