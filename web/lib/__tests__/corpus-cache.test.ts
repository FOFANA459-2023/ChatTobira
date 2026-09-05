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

  it("holds four entries and evicts the least recently used", () => {
    for (const n of [1, 2, 3, 4, 5]) rememberPool(n, String(n));
    expect(cachedPool(1)).toBeNull();
    expect(cachedPool(2)).toBe("2");
    expect(cachedPool(5)).toBe("5");
  });

  it("counts a read as use, so the book being studied is not the one evicted", () => {
    for (const n of [1, 2, 3, 4]) rememberPool(n, String(n));
    expect(cachedPool(1)).toBe("1"); // 1 is now the most recent
    rememberPool(5, "5");
    expect(cachedPool(1)).toBe("1");
    expect(cachedPool(2)).toBeNull();
  });

  it("keys past-paper pools by level alongside the books", () => {
    // The exemplar pool is fetched per level, not per document, and it is
    // read on every generation for that level — so it needs a key of its own
    // and a slot the book pools do not evict on the next test.
    rememberPool(7, "book");
    rememberPool("papers:F3", ["exemplar"]);
    expect(cachedPool<string[]>("papers:F3")).toEqual(["exemplar"]);
    expect(cachedPool("papers:F2")).toBeNull();
    expect(cachedPool(7)).toBe("book");
  });

  it("remembers that a level has no papers, rather than re-asking", () => {
    // An empty result is a real answer: without storing it, every test at a
    // level with no past papers would pay the query again.
    rememberPool("papers:INT", []);
    expect(cachedPool<string[]>("papers:INT")).toEqual([]);
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
