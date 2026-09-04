/** Which language an answer should come back in.
 *
 * Decided here rather than left to the model, because "reply in the language
 * the student writes in" is an instruction a model applies to the message in
 * front of it: a student who asked for Japanese three turns ago gets English
 * again the moment they type a word of it. A preference the student stated
 * out loud is a fact about the conversation, so it is read off the
 * conversation and stated to the model as a fact every turn.
 */

export type LanguageMode = "ja" | "en" | "mixed";

export interface Turn {
  role: string;
  text: string;
}

/** "Answer in Japanese" is a preference. "How do you say this in Japanese?"
 * is a question about vocabulary, and answering it entirely in Japanese would
 * be the opposite of helpful — so the verb matters, not just the language
 * name. */
const WANTS_JAPANESE =
  /((answer|reply|respond|explain|write|speak|talk|say it|put it)\b[^.?!]{0,20}\b(in|into)\s+japanese)|(japanese\s+only)|(only\s+in\s+japanese)|(all\s+in\s+japanese)|(日本語(だけ|のみ)で?)|((全部|すべて|ぜんぶ)日本語)|(日本語で(答え|こたえ|説明|せつめい|お願い|おねがい))/i;

const WANTS_ENGLISH =
  /((answer|reply|respond|explain|write|speak|talk|say it|put it)\b[^.?!]{0,20}\b(in|into)\s+english)|(english\s+only)|(only\s+in\s+english)|(all\s+in\s+english)|(英語(だけ|のみ)で?)|(英語で(答え|こたえ|説明|せつめい|お願い|おねがい))/i;

const CJK_RE = /[぀-ヿ一-鿿]/g;
const LATIN_WORD_RE = /[A-Za-z]{2,}/g;

/** Is this message written in Japanese, rather than merely containing some?
 *
 * A student asking 「〜ておくの使い方は？」 should not be answered in English,
 * but a student asking "what does 食べておく mean?" should — the Japanese
 * there is the subject, not the language of the question. */
export function isWrittenInJapanese(text: string): boolean {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  if (cjk === 0) return false;
  const latinWords = text.match(LATIN_WORD_RE)?.length ?? 0;
  // Two or three Latin words can be a quoted term inside a Japanese sentence;
  // a sentence's worth of them means the question is in English.
  return cjk >= 4 && latinWords <= 3;
}

/** Strip a request about the ANSWER's language out of a question.
 *
 * "日本語で説明してください。〜ておくの使い方は？" is one question about
 * 〜ておく and one instruction about how to reply. Embedded whole, the
 * instruction is half the sentence and drags the search toward pages that
 * talk about explaining and about Japanese — measured live, it pulled the
 * 〜ておく pages out of the results entirely. The preference is read
 * separately by detectLanguageMode; the search only wants the question.
 */
export function withoutLanguageRequest(text: string): string {
  const stripped = text
    .replace(WANTS_JAPANESE, " ")
    .replace(WANTS_ENGLISH, " ")
    .replace(/(で|で)?(説明|せつめい|答え|こたえ|回答)して(ください|下さい|ほしい)/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s、。.,]+/, "")
    .trim();
  // Never hand back nothing: a question that was ONLY a language request
  // still has to be searched with something.
  return stripped.length >= 2 ? stripped : text;
}

/** The mode for the turn being answered.
 *
 * An explicit request is sticky — it holds until the student asks for
 * something else, which is what "preserve the preference" has to mean if it
 * is to survive the next one-word follow-up. Absent a request, a question
 * written in Japanese is answered in Japanese, and everything else gets the
 * default: English carrying the Japanese terms the course actually uses.
 */
export function detectLanguageMode(turns: Turn[]): LanguageMode {
  const asked = turns.filter((t) => t.role === "user");

  for (const turn of [...asked].reverse()) {
    if (WANTS_JAPANESE.test(turn.text)) return "ja";
    if (WANTS_ENGLISH.test(turn.text)) return "en";
  }

  const current = asked.at(-1)?.text ?? "";
  return isWrittenInJapanese(current) ? "ja" : "mixed";
}

/** The language section of the system prompt. */
export function languageRule(mode: LanguageMode): string {
  if (mode === "ja") {
    return `LANGUAGE
- Answer entirely in Japanese. The student asked for Japanese, or wrote to you in it.
- Match their level: short sentences and common vocabulary for Foundation students.
- Furigana on kanji beyond the student's level, attached to the whole word once, written 漢字（かんじ）.`;
  }

  if (mode === "en") {
    return `LANGUAGE
- Answer in English. The student asked for English.
- Japanese words, patterns and example sentences still appear in Japanese script — never romaji — because that is what they have to read on the paper. Gloss each one in English.
- Furigana on kanji, attached to the whole word once, written 漢字（かんじ）.`;
  }

  return `LANGUAGE
- Explain in English, and keep the Japanese the course itself uses: grammar points, vocabulary, textbook terms, example sentences (〜ておく, 形容詞, 辞書形). A student who only ever reads "the te-form" cannot find 「て形」 in their book.
- Japanese stays in Japanese script, never romaji, and every Japanese word or sentence you introduce gets a short English gloss the first time.
- Do NOT translate your whole answer into Japanese, and do not write each sentence twice in two languages.
- Furigana on kanji, attached to the whole word once, written 漢字（かんじ）.`;
}
