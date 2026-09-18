import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  ACCEPT_BUDGET_MS,
  isProviderDead,
  noteProviderFailure,
  noteProviderSuccess,
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

/** The counter is documented as failures IN A ROW "with no success between",
 * and only noteProviderSuccess puts the "between" there. Nothing used to test
 * that, and two routes shipped without ever calling it — so their tiers could
 * only ever lose health, never regain it, and a tier that works was retired on
 * three failures spread across an isolate's entire life. */
describe("a tier that fails and then works", () => {
  beforeEach(resetProviderHealth);

  it("retires a tier only when the failures are consecutive", () => {
    noteProviderFailure("google-fast", new Error("paper too short"));
    noteProviderFailure("google-fast", new Error("paper too short"));
    expect(isProviderDead("google-fast")).toBe(false);

    // A paper arrives. Whatever was wrong with the tier is over, and the two
    // short papers before it are no longer evidence of anything.
    noteProviderSuccess("google-fast");

    noteProviderFailure("google-fast", new Error("paper too short"));
    noteProviderFailure("google-fast", new Error("paper too short"));
    expect(isProviderDead("google-fast")).toBe(false);
  });

  it("still retires a tier that fails three times with nothing in between", () => {
    // The guard above must not cost the behaviour the counter exists for.
    noteProviderFailure("google-fast", new Error("no output generated"));
    noteProviderFailure("google-fast", new Error("no output generated"));
    expect(noteProviderFailure("google-fast", new Error("no output generated"))).toBe(true);
    expect(isProviderDead("google-fast")).toBe(true);
  });

  it("brings back a tier that answers after being retired", () => {
    // Isolates are long-lived and a 402 is only permanent until someone tops
    // the account up; an answer is proof it is spendable again.
    noteProviderFailure("deepseek", apiError(402));
    expect(isProviderDead("deepseek")).toBe(true);
    noteProviderSuccess("deepseek");
    expect(isProviderDead("deepseek")).toBe(false);
  });
});

/** Health is keyed on the TIER, not the provider, so that one job's model
 * cannot retire another job's. See Tier.key in lib/router.ts. */
describe("one job's failures and another job's models", () => {
  beforeEach(resetProviderHealth);

  it("keeps post-test coaching from retiring the chat model", () => {
    // Both reach Google, on different models, for unrelated jobs. Coaching is
    // optional; gemini-3.5-flash-lite answering typed questions is not, and it
    // used to be taken down by three failures of the optional one.
    noteProviderFailure("feedback-google", apiError(403));
    expect(isProviderDead("feedback-google")).toBe(true);
    expect(isProviderDead("google")).toBe(false);
  });

  it("keeps a slow paper tier from retiring the fast one behind it", () => {
    noteProviderFailure("google-pro", new Error("tier_timeout"));
    noteProviderFailure("google-pro", new Error("tier_timeout"));
    noteProviderFailure("google-pro", new Error("tier_timeout"));
    expect(isProviderDead("google-pro")).toBe(true);
    expect(isProviderDead("google-fast")).toBe(false);
  });
});

/** The tests above pin what providers.ts does, and providers.ts was never the
 * thing that was broken. Both bugs this suite grew out of were a ROUTE calling
 * half of the pair — failures recorded, successes never — and no unit test of
 * this module can see that, because from in here the module behaves perfectly.
 *
 * So this reads the routes. It is the same bargain `ingest verify` makes about
 * the corpus: the invariant is real, it holds across files rather than inside
 * one, and a comment asking people to remember it is not a control. */
describe("every route that tracks provider health tracks both halves", () => {
  const APP = resolve(__dirname, "..", "..", "app");
  const routes = readdirSync(APP, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith("route.ts"))
    .map((file) => ({ file, source: readFileSync(resolve(APP, file), "utf8") }))
    .filter(({ source }) => source.includes("noteProviderFailure("));

  it("finds the routes that cascade over providers", () => {
    // If this ever reads zero, the check below is passing vacuously.
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes.map(({ file }) => file))(
    "%s records a success, so its failure count can fall as well as rise",
    (file) => {
      const { source } = routes.find((r) => r.file === file)!;
      expect(source).toContain("noteProviderSuccess(");
    },
  );
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
