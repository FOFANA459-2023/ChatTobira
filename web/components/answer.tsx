import { parseAnswer, splitBold, splitHeading, type AnswerBlock } from "@/lib/answer";
import { splitRuby } from "@/lib/ruby";

/** Japanese text with furigana set above the kanji and **bold** honoured.
 *
 * Exported because every piece of generated text in the app runs through it —
 * a chat answer, a test question, an explanation, the study coach. They are
 * all written by the same models in the same dialect, and a reading printed
 * as 漢字（かんじ） in one place and as ruby in another looks like two
 * different apps. */
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
function langOf(text: string): "ja" | undefined {
  return /[぀-ヿ一-鿿]/.test(text) ? "ja" : undefined;
}

/** A numbered two-column word list, the way the book prints 語彙: the word
 * with its reading on the left, the meaning on the right, ruled between
 * entries. This is what a run of `word: meaning` bullets is actually for. */
function Terms({ items }: { items: { term: string; gloss: string }[] }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <tbody>
        {items.map((item, i) => (
          <tr key={i} className="border-b border-stone-100 align-baseline last:border-b-0">
            <td className="w-7 py-1.5 pr-2 text-right text-[0.7rem] leading-7 tabular-nums text-stone-400">
              {i + 1}
            </td>
            <td
              className="w-[45%] py-1.5 pr-3 font-medium leading-7 text-stone-900"
              lang={langOf(item.term)}
            >
              <RichText text={item.term} />
            </td>
            <td className="py-1.5 leading-7 text-stone-600" lang={langOf(item.gloss)}>
              <RichText text={item.gloss} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Block({ block }: { block: AnswerBlock }) {
  switch (block.kind) {
    case "heading": {
      const { label, gloss } = splitHeading(block.text);
      // Top-level sections get the book's filled band; a sub-heading inside
      // one gets a plain rule, so the hierarchy is visible at a glance
      // instead of every heading shouting equally.
      const banded = block.level <= 2;
      return (
        <h3
          className={
            banded
              ? "mt-5 flex items-baseline gap-2 rounded-r border-l-[3px] border-stone-700 bg-stone-100 px-2.5 py-1 first:mt-0"
              : "mt-4 flex items-baseline gap-2 border-b border-stone-200 pb-1 first:mt-0"
          }
        >
          <span
            className="font-semibold leading-7 text-stone-800"
            lang={langOf(label)}
          >
            <RichText text={label} />
          </span>
          {gloss && <span className="text-xs font-normal text-stone-500">{gloss}</span>}
        </h3>
      );
    }

    case "terms":
      return <Terms items={block.items} />;

    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List
          className={`space-y-1 pl-5 leading-7 marker:text-stone-400 ${
            block.ordered ? "list-decimal" : "list-disc"
          }`}
        >
          {block.items.map((item, i) => (
            <li key={i} lang={langOf(item)}>
              <RichText text={item} />
            </li>
          ))}
        </List>
      );
    }

    case "table":
      return (
        // Conjugation tables are wider than a phone. The table scrolls inside
        // its own box rather than stretching the message bubble off-screen.
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[0.82rem]">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th
                    key={i}
                    className="border border-stone-300 bg-stone-100 px-2 py-1 font-semibold leading-7 text-stone-700"
                    lang={langOf(cell)}
                  >
                    <RichText text={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="border border-stone-200 px-2 py-1 leading-7 text-stone-700"
                      lang={langOf(cell)}
                    >
                      <RichText text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "rule":
      return <hr className="border-stone-200" />;

    case "paragraph":
      return (
        <p className="whitespace-pre-line leading-7" lang={langOf(block.text)}>
          <RichText text={block.text} />
        </p>
      );
  }
}

/** One assistant answer, laid out like a page of the textbook.
 *
 * Called on every streamed frame, so it renders whatever is complete so far:
 * a half-written table is a table with the rows it has, and the Markdown that
 * has not closed yet reads as the text it currently is.
 */
export function Answer({ text }: { text: string }) {
  const blocks = parseAnswer(text);
  if (blocks.length === 0) return null;

  return (
    <div className="space-y-2.5">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
