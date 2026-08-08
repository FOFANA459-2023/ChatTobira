import type { Citation } from "@/lib/retrieval";

/** Text-only textbook citations rendered under an assistant message.
 *
 * Grouped by book: several pages from one textbook read as one entry with a
 * page list, not the same title repeated per page. */
export function Citations({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;

  const books = new Map<string, Citation[]>();
  for (const citation of citations) {
    const group = books.get(citation.title);
    if (group) group.push(citation);
    else books.set(citation.title, [citation]);
  }

  return (
    <div className="mt-3 space-y-2 border-t border-stone-200 pt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
        Sources
      </p>
      {[...books.entries()].map(([title, group]) => (
        <div key={title} className="rounded-lg bg-stone-100 px-3 py-2 text-sm">
          <p className="font-medium text-stone-700">
            {title}
            {group.length > 1 && (
              <span className="font-normal text-stone-500">
                {" — pp. "}
                {group.map((c) => c.book_page).filter(Boolean).join(", ")}
              </span>
            )}
            {group.length === 1 && group[0].book_page && (
              <span className="font-normal text-stone-500"> — p. {group[0].book_page}</span>
            )}
          </p>
          {group.some((c) => c.quote) && (
          <div className="mt-1 space-y-1.5">
            {group.map(
              (citation, index) =>
                citation.quote && (
                  <p key={citation.book_page ?? index} className="flex gap-2">
                    {group.length > 1 && (
                      <span className="mt-0.5 shrink-0 rounded bg-stone-200 px-1.5 py-px text-xs text-stone-600">
                        p. {citation.book_page ?? "–"}
                      </span>
                    )}
                    <span lang="ja" className="text-stone-600">
                      {citation.quote}
                    </span>
                  </p>
                ),
            )}
          </div>
          )}
        </div>
      ))}
    </div>
  );
}
