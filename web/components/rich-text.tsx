import { splitBold } from "@/lib/answer";
import { splitRuby } from "@/lib/ruby";

/** Japanese text with furigana set above the kanji and **bold** honoured.
 *
 * Exported because every piece of generated text in the app runs through it —
 * a chat answer, a test question, an explanation, the study coach. They are
 * all written by the same models in the same dialect, and a reading printed
 * as 漢字（かんじ） in one place and as ruby in another looks like two
 * different apps.
 *
 * It lives in its own file rather than beside the answer renderer because the
 * interactive practice questions need it too, and a client component reaching
 * back into the renderer that draws it is a cycle.
 */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {splitBold(text).map((segment, i) => {
        const body = splitRuby(segment.text).map((part, j) =>
          part.reading ? (
            <ruby key={j}>
              {part.base}
              <rt className="select-none text-[0.6em] font-normal text-stone-500">
                {part.reading}
              </rt>
            </ruby>
          ) : (
            <span key={j}>{part.base}</span>
          ),
        );
        return segment.bold ? (
          <strong key={i} className="font-semibold text-stone-900">
            {body}
          </strong>
        ) : (
          <span key={i}>{body}</span>
        );
      })}
    </>
  );
}

/** Japanese content gets lang="ja" so the browser picks the Japanese face and
 * a screen reader reads it as Japanese; an English gloss in the next column
 * must not inherit that. */
export function langOf(text: string): "ja" | undefined {
  return /[぀-ヿ一-鿿]/.test(text) ? "ja" : undefined;
}
