import { describe, expect, it } from "vitest";

import { fileSize, relativeTime, shortDate } from "@/lib/time";

const NOW = Date.parse("2026-09-04T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe("relativeTime", () => {
  it("says how long ago, in the largest unit that fits", () => {
    expect(relativeTime(ago(20), { now: NOW })).toBe("just now");
    expect(relativeTime(ago(5 * 60), { now: NOW })).toBe("5 minutes ago");
    expect(relativeTime(ago(2 * 3600), { now: NOW })).toBe("2 hours ago");
    expect(relativeTime(ago(3 * 86400), { now: NOW })).toBe("3 days ago");
    expect(relativeTime(ago(14 * 86400), { now: NOW })).toBe("2 weeks ago");
    expect(relativeTime(ago(70 * 86400), { now: NOW })).toBe("2 months ago");
    expect(relativeTime(ago(400 * 86400), { now: NOW })).toBe("1 year ago");
  });

  it("keeps the singular singular", () => {
    expect(relativeTime(ago(60), { now: NOW })).toBe("1 minute ago");
    expect(relativeTime(ago(86400), { now: NOW })).toBe("1 day ago");
  });

  it("says so plainly when there is no timestamp", () => {
    expect(relativeTime(null)).toBe("Never");
    expect(relativeTime(undefined)).toBe("Never");
    expect(relativeTime(null, { never: "Never logged in" })).toBe("Never logged in");
  });

  it("does not render clock skew as the future", () => {
    // The database clock running a few seconds ahead of the browser must not
    // produce "in 4 seconds" in a column headed "last activity".
    expect(relativeTime(new Date(NOW + 4000).toISOString(), { now: NOW })).toBe("just now");
  });

  it("treats an unparseable value as no value", () => {
    expect(relativeTime("not a date")).toBe("Never");
  });
});

describe("shortDate", () => {
  it("gives the calendar date, where a duration would be the wrong answer", () => {
    expect(shortDate("2026-08-10T03:57:36Z")).toBe("10 Aug 2026");
  });

  it("has an em dash for nothing", () => {
    expect(shortDate(null)).toBe("—");
    expect(shortDate("nonsense")).toBe("—");
  });
});

describe("fileSize", () => {
  it("scales to the unit a person would use", () => {
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(2048)).toBe("2 KB");
    expect(fileSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });

  it("distinguishes zero bytes from no answer", () => {
    expect(fileSize(0)).toBe("0 B");
    expect(fileSize(null)).toBe("—");
  });
});
