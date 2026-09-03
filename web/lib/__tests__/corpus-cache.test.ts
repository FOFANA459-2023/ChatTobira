import { beforeEach, describe, expect, it } from "vitest";

import { cachedPool, clearPoolCache, rememberPool } from "@/lib/corpus-cache";

const MINUTE = 60 * 1000;

describe("corpus pool cache", () => {
  beforeEach(clearPoolCache);

  it("has nothing for a document it has not seen", () => {
    expect(cachedPool(1)).toBeNull();
  });

  it("returns what was stored for that document", () => {
    rememberPool(1, { chunks: ["a"] });
    expect(cachedPool<{ chunks: string[] }>(1)).toEqual({ chunks: ["a"] });
    expect(cachedPool(2)).toBeNull();
  });

  it("goes stale, so a re-ingested book is picked up", () => {
    rememberPool(1, "old", 0);
    expect(cachedPool(1, 9 * MINUTE)).toBe("old");
    expect(cachedPool(1, 11 * MINUTE)).toBeNull();
    // The stale entry is dropped rather than left to occupy a slot.
    expect(cachedPool(1, 11 * MINUTE)).toBeNull();
  });

  it("holds two books and evicts the least recently used", () => {
    rememberPool(1, "one");
    rememberPool(2, "two");
    rememberPool(3, "three");
    expect(cachedPool(1)).toBeNull();
    expect(cachedPool(2)).toBe("two");
    expect(cachedPool(3)).toBe("three");
  });

  it("counts a read as use, so the book being studied is not the one evicted", () => {
    rememberPool(1, "one");
    rememberPool(2, "two");
    expect(cachedPool(1)).toBe("one"); // 1 is now the most recent
    rememberPool(3, "three");
    expect(cachedPool(1)).toBe("one");
    expect(cachedPool(2)).toBeNull();
  });

  it("replaces an entry rather than storing it twice", () => {
    rememberPool(1, "first");
    rememberPool(1, "second");
    rememberPool(2, "two");
    // If the first write still held a slot, this read would have been evicted.
    expect(cachedPool(1)).toBe("second");
    expect(cachedPool(2)).toBe("two");
  });
});
