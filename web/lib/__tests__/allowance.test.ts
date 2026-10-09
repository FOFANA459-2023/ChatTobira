import { describe, expect, it, vi } from "vitest";

import { exhaustedMessage, refundAllowance, resetTime, spendAllowance } from "../allowance";
import { formatLeft } from "@/components/voice-session";

describe("resetTime", () => {
  it("says when the window renews in Japan time, whatever the server's clock", () => {
    // 06:40 UTC is 15:40 in Tokyo.
    expect(resetTime("2026-09-20T06:40:00Z")).toBe("3:40 PM");
    expect(resetTime("2026-09-20T15:05:00Z")).toBe("12:05 AM");
  });

  it("gives nothing for a missing or broken time", () => {
    expect(resetTime(null)).toBeNull();
    expect(resetTime("not a date")).toBeNull();
  });
});

describe("exhaustedMessage", () => {
  it("names the allowance and the time it comes back", () => {
    expect(exhaustedMessage("chat", "2026-09-20T06:40:00Z")).toBe(
      "You have used your 20 questions and practice tests for now. More are available at 3:40 PM (Japan time).",
    );
    expect(exhaustedMessage("voice", "2026-09-20T06:40:00Z")).toBe(
      "You have used your 10 minutes of conversation for now. More are available at 3:40 PM (Japan time).",
    );
  });

  it("falls back to the window length without a time", () => {
    expect(exhaustedMessage("chat", null)).toMatch(/within 5 hours/);
  });
});

describe("spendAllowance", () => {
  const client = (result: { data?: unknown; error?: unknown }) =>
    ({ rpc: vi.fn().mockResolvedValue(result) }) as unknown as Parameters<typeof spendAllowance>[0];

  it("spends and reports what is left", async () => {
    const supabase = client({ data: [{ allowed: true, remaining: 19, resets_at: "t" }] });
    expect(await spendAllowance(supabase, "chat", 1)).toEqual({ ok: true, remaining: 19, resetsAt: "t" });
    expect((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "consume_allowance",
      { p_kind: "chat", p_amount: 1 },
    );
  });

  it("tells an empty allowance apart from a broken database", async () => {
    expect(await spendAllowance(client({ data: [{ allowed: false, remaining: 0, resets_at: "t" }] }), "voice", 60))
      .toEqual({ ok: false, exhausted: true, resetsAt: "t" });
    expect(await spendAllowance(client({ error: { message: "down" } }), "chat", 1)).toEqual({
      ok: false,
      exhausted: false,
    });
  });
});

describe("formatLeft", () => {
  it("shows minutes and seconds", () => {
    expect(formatLeft(600)).toBe("10:00");
    expect(formatLeft(485)).toBe("8:05");
    expect(formatLeft(0)).toBe("0:00");
    expect(formatLeft(-3)).toBe("0:00");
  });
});

describe("refundAllowance", () => {
  /** A service client over one usage_windows row. */
  function service(used: number | null) {
    const updates: { used: number }[] = [];
    const filters: [string, unknown][] = [];
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      },
      maybeSingle: async () => ({ data: used === null ? null : { used } }),
      update: (values: { used: number }) => {
        updates.push(values);
        return chain;
      },
    };
    return { client: { from: () => chain } as never, updates, filters };
  }

  it("gives back the minute a failed token cost, for that student and kind only", async () => {
    const { client, updates, filters } = service(240);
    await refundAllowance(client, "user-1", "voice", 60);
    expect(updates).toEqual([{ used: 180 }]);
    expect(filters).toContainEqual(["user_id", "user-1"]);
    expect(filters).toContainEqual(["kind", "voice"]);
  });

  it("never takes the count below zero, and does nothing without a window", async () => {
    const low = service(30);
    await refundAllowance(low.client, "user-1", "voice", 60);
    expect(low.updates).toEqual([{ used: 0 }]);

    const none = service(null);
    await refundAllowance(none.client, "user-1", "voice", 60);
    expect(none.updates).toEqual([]);
  });
});
