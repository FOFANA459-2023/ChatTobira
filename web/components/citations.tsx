import type { Citation } from "@/lib/retrieval";

/** Text-only textbook citations rendered under an assistant message. */
export function Citations({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;

  return (
    <div className="mt-3 space-y-2 border-t border-stone-200 pt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
        Sources
      </p>
      {citations.map((citation, index) => (
        <blockquote
          key={`${citation.document_id}-${citation.book_page ?? index}`}
          className="rounded-lg bg-stone-100 px-3 py-2 text-sm"
        >
          <p className="font-medium text-stone-700">
            {citation.title}
            {citation.book_page && (
              <span className="text-stone-500"> — p. {citation.book_page}</span>
            )}
          </p>
          {citation.quote && (
            <p lang="ja" className="mt-1 text-stone-600">
              {citation.quote}
            </p>
          )}
        </blockquote>
      ))}
    </div>
  );
}
