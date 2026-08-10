/** Email input normalisation.
 *
 * School addresses get typed or pasted with a Japanese IME active, which
 * produces full-width characters — ＠ for @, ｅｄ for ed, a trailing 全角
 * space — and Outlook copies arrive as 「山田 太郎 <yt01@ed.ritsumei.ac.jp>」.
 * Every one of those failed the native type="email" validation and the API's
 * schema, which read as ".ac.jp addresses are blocked" to the admin. Nothing
 * was ever wrong with the domain: the characters just were not ASCII.
 */

const ANGLE_BRACKETS = /[<＜]([^>＞]*)[>＞]/;
// Zero-width and formatting characters that ride along with copy-paste,
// written as escapes because the characters themselves are invisible.
const INVISIBLES = new RegExp("[\\u200B-\\u200D\\u2060\\uFEFF]", "g");

/** A pragmatic shape check, applied AFTER normalisation: one @, something on
 * both sides, a dot in the domain. Deliverability is decided by the mail
 * server, not a regex — this only catches obvious non-addresses. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Normalise raw user input into a plain ASCII-ish address:
 * NFKC folds full-width characters (＠ → @, ｅｄ → ed, ６ → 6), invisible
 * characters are stripped, an <angle-bracketed> address is extracted from a
 * pasted display-name form, and the result is trimmed and lowercased. */
export function normalizeEmail(raw: string): string {
  let text = raw.normalize("NFKC").replace(INVISIBLES, "");
  const bracketed = text.match(ANGLE_BRACKETS);
  if (bracketed) text = bracketed[1];
  return text.trim().toLowerCase();
}
