import TinySegmenter from "tiny-segmenter";
import type { SupabaseClient } from "@supabase/supabase-js";

/** One retrieved chunk from match_chunks. */
export interface RetrievedChunk {
  chunk_id: number;
  document_id: number;
  doc_title: string;
  doc_type: string;
  is_citable: boolean;
  pdf_page: number;
  book_page: string | null;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  /** True cosine similarity to the query, independent of RRF rank. */
  similarity: number;
  /** Set when the chunk was found because it literally contains a pattern
   * the student named, rather than by ranking. It carries no similarity
   * score, and it does not need one: the student asked about 〜てある and
   * this page prints 〜てある. */
  exact?: boolean;
}

export interface Citation {
  document_id: number;
  title: string;
  book_page: string | null;
  quote: string;
}

export interface StudyScope {
  level?: "F2" | "F3" | "INT";
  topic?: string;
}

const segmenter = new TinySegmenter();

const GREETING_RE =
  /^(hi|hello|hey|yo|thanks?|thank you|ok(ay)?|cool|nice|good (morning|evening|night)|bye|see you|こんにちは|こんばんは|おはよう(ございます)?|ありがとう(ございます)?|はい|うん|じゃあね|さようなら|よろしく(おねがいします)?|お疲れ様(です)?|おつかれ)[\s!?！？。～~]*$/i;

/** Acknowledgements that carry no question. Spelled out rather than caught by
 * a length rule: "why?", "how?", "て form?" and "T6?" are all shorter than
 * "thanks" and every one of them is a real question. A blanket length cut
 * sent those straight to the model with no course material at all, which is
 * exactly how a student ends up asking the same thing three times. */
const ACKNOWLEDGEMENT_RE =
  /^(lol|haha|k|kk|yes|no|yep|nope|sure|great|perfect|awesome|got it|i see|makes sense|understood|なるほど|わかりました|わかった|了解)[\s!?！？。～~]*$/i;

/** Small talk needs no retrieval: answering "hello" through an embedding
 * call, a cache probe, and a vector search wastes ~1s and then decorates the
 * greeting with textbook citations. */
export function isSmallTalk(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return GREETING_RE.test(trimmed) || ACKNOWLEDGEMENT_RE.test(trimmed);
}

/** One turn of the conversation, as much of it as retrieval cares about. */
export interface Turn {
  role: string;
  text: string;
}

export interface ResolvedQuery {
  /** What to embed and search the corpus with. */
  text: string;
  /** The student's message on its own, for the cache and for logging. */
  asked: string;
  /** True when the message could not stand on its own and the conversation
   * was folded in to make it searchable. */
  isFollowUp: boolean;
}

/** Words and shapes that mean "about the thing we were just discussing". */
const ANAPHORA_RE =
  /\b(this|that|these|those|it|its|it's|they|them|the (same|other|previous|last|first|second|third|next) \w+|the (example|answer|sentence|word|form|rule|pattern|table))\b|それ|これ|あれ|その|この|あの|さっき|前の|同じ/i;

/** Openers that continue a previous question rather than starting a new one. */
const CONTINUATION_RE =
  /^(and|but|so|also|then|what about|how about|why|why not|how come|what if|ok(ay)?[,\s]|another|more|again|one more|can you|could you|show me|give me|例文|もっと|他|なぜ|どうして|じゃあ|では)\b/i;

/** Extract the terms worth carrying forward from an assistant answer.
 *
 * A follow-up is usually about the pattern the last answer was ABOUT, and the
 * student rarely names it again. Grammar points are taken first because they
 * are what these conversations turn on, then kanji compounds; readings in
 * brackets are dropped, since the reading of a word the answer already named
 * adds nothing to a search for it.
 */
export function salientTerms(answer: string, limit = 4): string[] {
  const withoutReadings = answer.replace(/[（《][ぁ-ゖァ-ヶー]+[）》]/g, "");
  const patterns = [...withoutReadings.matchAll(/[～〜][ぁ-ゖァ-ヶー一-鿿]{1,8}/g)].map((m) => m[0]);
  const compounds = [...withoutReadings.matchAll(/[一-鿿]{2,6}/g)].map((m) => m[0]);
  return [...new Set([...patterns, ...compounds])].slice(0, limit);
}

/** Turn the conversation into the query the corpus should actually be
 * searched with.
 *
 * The model has always been handed the whole conversation, but retrieval was
 * handed only the last message — so "what about the past tense?" searched the
 * textbooks for those five words and grounded the answer in whatever they
 * happened to match. The student then asked again with more words, which is
 * the "ask it three times" loop this exists to close.
 *
 * The rewrite is deliberately mechanical rather than a model call: it runs on
 * every message, and a round trip to a model to find out what "it" means
 * would cost more latency than the retrieval it feeds.
 */
export function resolveQuery(turns: Turn[]): ResolvedQuery {
  const lastUserAt = turns.map((t) => t.role).lastIndexOf("user");
  const asked = lastUserAt < 0 ? "" : turns[lastUserAt].text.trim();
  const earlier = lastUserAt < 0 ? [] : turns.slice(0, lastUserAt);

  const previousQuestion =
    [...earlier].reverse().find((t) => t.role === "user")?.text.trim() ?? "";
  const previousAnswer =
    [...earlier].reverse().find((t) => t.role === "assistant")?.text.trim() ?? "";

  // Nothing to resolve against, or the question already stands on its own.
  const dependent =
    Boolean(previousQuestion || previousAnswer) &&
    (ANAPHORA_RE.test(asked) || CONTINUATION_RE.test(asked) || asked.length <= 24);

  if (!asked || !dependent) {
    return { text: asked, asked, isFollowUp: false };
  }

  const carried = [previousQuestion.slice(0, 160), ...salientTerms(previousAnswer)].filter(
    Boolean,
  );
  return {
    text: [...carried, asked].join(" "),
    asked,
    isFollowUp: true,
  };
}

/** Query-side tokens for the lexical arm of hybrid search.
 *
 * The index was built with fugashi (surface + dictionary forms), which cannot
 * run in a Worker. TinySegmenter boundaries differ on conjugations, but
 * content words — nouns, kanji compounds, grammar-pattern kana — line up with
 * the indexed surface forms, and the vector arm covers the rest. The raw query
 * is appended verbatim because short grammar-point labels (たいです, ～ておく)
 * were indexed verbatim too, so exact-pattern questions get an exact hit.
 */
/** English words that carry no signal against a Japanese corpus.
 *
 * The lexical arm is an OR query, so every term it is given can pull a chunk
 * into the fusion on its own. Left in, "how do I use the て form?" searched
 * for `how | do | i | use | the | form` — and the corpus is full of English
 * glosses, so "use" and "form" matched pages about nothing in particular and
 * ranked them alongside the real hit. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "did", "do",
  "does", "for", "from", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me",
  "mean", "means", "my", "no", "not", "of", "on", "or", "please", "say", "should", "so",
  "tell", "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "to", "use", "used", "using", "was", "we", "what", "when", "where", "which",
  "who", "why", "will", "with", "would", "you", "your",
]);

/** Course shorthand — T6, G3, N5 — is meaningful despite being short. */
const COURSE_MARKER_RE = /^[a-z]\d{1,2}$/i;

function isSearchable(token: string): boolean {
  if (/[぀-ヿ一-鿿]/.test(token)) return true;
  const word = token.toLowerCase();
  if (COURSE_MARKER_RE.test(word)) return true;
  return word.length >= 3 && !STOPWORDS.has(word);
}

export function tokensForQuery(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const tokens = segmenter
    .segment(trimmed)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !/^[\s\p{P}]+$/u.test(t) && isSearchable(t));

  // Course shorthand, rescued from the segmenter: it splits "T6" into "T" and
  // "6", and both halves are then noise that the filter above drops. The
  // marker is worth keeping whole — the chunker prefixes every handout chunk
  // with its topic, so "T6" is a real token in the index. The lookbehind
  // keeps "Topic 6" from matching on its own last letter.
  for (const marker of trimmed.match(/(?<![A-Za-z0-9])[A-Za-z]\s?\d{1,2}(?![0-9])/g) ?? []) {
    tokens.push(marker.replace(/\s+/g, ""));
  }

  // Short Japanese labels were indexed verbatim, so an exact-pattern question
  // ("〜ておく") gets an exact hit. Only Japanese: appending an English
  // phrase as a single token matches nothing and costs a tsquery term.
  if (trimmed.length <= 16 && /[぀-ヿ一-鿿]/.test(trimmed)) {
    tokens.push(trimmed);
    const bare = trimmed.replace(/^[～〜~]+/, "").trim();
    if (bare && bare !== trimmed) tokens.push(bare);
  }

  return [...new Set(tokens)];
}

/** Embed a query with the same model/dimensions/normalisation as the corpus.
 * Task type RETRIEVAL_QUERY must pair with the corpus's RETRIEVAL_DOCUMENT. */
export async function embedQuery(text: string): Promise<number[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${
      process.env.EMBED_MODEL ?? "gemini-embedding-001"
    }:embedContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GOOGLE_API_KEY!,
      },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: 768,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`embed failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { embedding: { values: number[] } };
  const values = json.embedding.values;
  // MRL-truncated vectors are not unit length; the corpus was normalised at
  // ingest, so the query must be too or similarities skew.
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}

export async function retrieve(
  supabase: SupabaseClient,
  embedding: number[],
  tokens: string[],
  scope: StudyScope,
  count = 12,
): Promise<RetrievedChunk[]> {
  const { data, error } = await supabase.rpc("match_chunks", {
    query_embedding: `[${embedding.join(",")}]`,
    query_tokens: tokens,
    filter: scope,
    match_count: count,
  });
  if (error) throw new Error(`match_chunks: ${error.message}`);
  return (data ?? []) as RetrievedChunk[];
}

/** Below this cosine similarity a chunk is not about the question. It is a
 * looser bar than a citation's, because a passage can be worth showing the
 * model without being worth pointing a student at. */
export const CONTEXT_MIN_SIMILARITY = Number(process.env.CONTEXT_MIN_SIMILARITY ?? 0.55);

/** Which retrieved chunks actually go in the prompt.
 *
 * Retrieval returns its candidates in fused-rank order, which balances the
 * vector and lexical arms but says nothing about whether a chunk is on topic:
 * the best of a bad set still ranks first. Everything returned used to be
 * poured into the context until an 8,000-character budget ran out, so a
 * lexical match on a stray word could take the space the answer needed and
 * push the passage that actually answered the question out of the prompt.
 *
 * So: drop what is not about the question, never let one book crowd out the
 * rest, never show the same page twice, and lead with the closest passage —
 * models weight what comes first, and the reader of this block is a model.
 *
 * The floor never starves the prompt. If nothing clears it, the best two
 * candidates go in anyway and the model is told the material is thin, which
 * produces "the course material does not cover this" instead of silence.
 */
export function selectContext(
  chunks: RetrievedChunk[],
  { limit = 6, perDocument = 3, minSimilarity = CONTEXT_MIN_SIMILARITY } = {},
): RetrievedChunk[] {
  const onTopic = chunks.filter((c) => c.exact || (c.similarity ?? 0) >= minSimilarity);
  const pool = onTopic.length > 0 ? onTopic : chunks.slice(0, 2);

  const seenPages = new Set<string>();
  const perDocumentCount = new Map<number, number>();
  const picked: RetrievedChunk[] = [];

  for (const chunk of pool) {
    const page = `${chunk.document_id}:${chunk.book_page ?? chunk.pdf_page}`;
    if (seenPages.has(page)) continue;
    const used = perDocumentCount.get(chunk.document_id) ?? 0;
    if (used >= perDocument) continue;
    seenPages.add(page);
    perDocumentCount.set(chunk.document_id, used + 1);
    picked.push(chunk);
    if (picked.length >= limit) break;
  }

  // Pages that print the pattern the student named lead, then the closest
  // ranked passages. A model weights what it reads first.
  return picked.sort((a, b) => {
    if (Boolean(a.exact) !== Boolean(b.exact)) return a.exact ? -1 : 1;
    return (b.similarity ?? 0) - (a.similarity ?? 0);
  });
}

/** Grammar patterns named in a question: 〜ておく, 「てある」, ～たら.
 *
 * These are what a grammar question is usually ABOUT, and they are exactly
 * what neither arm of hybrid search can find reliably. The segmenter splits
 * 〜てある into て and ある — two of the most common morphemes in Japanese —
 * so the lexical arm ranks them by frequency and the pattern's own pages
 * never surface. Measured on the live corpus: "Compare 〜ておく and 〜てある"
 * retrieved ておく pages only, and the answer told the student their
 * textbooks do not cover てある. They cover it on five pages.
 */
/** Where the pattern stops and the sentence around it starts.
 *
 * Japanese does not space its words, so a run of kana after 〜 swallows
 * whatever follows: 「〜ておくの使い方は？」 captures ておくの使い方は, and a
 * literal search for that finds nothing at all. Cutting at a particle that
 * glues onto a pattern recovers ておく. Only at index 2 or later — 〜のに and
 * 〜はずです open with the very characters being cut on — and に, で, と are
 * left alone because patterns are built from them (〜ことにする, 〜として).
 * A pattern trimmed too short still finds the right pages: this is a
 * substring search, and 〜ては is inside 〜てはいけません.
 */
function trimPattern(raw: string): string {
  const glue = raw.slice(2).search(/[のはをがへ]/);
  const cut = glue < 0 ? raw : raw.slice(0, glue + 2);
  return cut.slice(0, 8);
}

export function grammarPatterns(text: string, limit = 2): string[] {
  const marked = [...text.matchAll(/[～〜]\s?([ぁ-ゖァ-ヶー一-鿿]{2,12})/g)].map((m) =>
    trimPattern(m[1]),
  );
  const quoted = [...text.matchAll(/[「『]([ぁ-ゖァ-ヶー一-鿿]{2,12})[」』]/g)].map((m) =>
    trimPattern(m[1]),
  );
  return [...new Set([...marked, ...quoted])].filter((p) => p.length >= 2).slice(0, limit);
}

/** Which of the pages printing a pattern actually teach it.
 *
 * The ingest pipeline already recorded what each page teaches — the vision
 * model returns grammar_points per page — so a page that lists the pattern
 * as its own subject outranks a page that happens to use it in an exercise
 * sentence. After that: the textbooks the student owns, then pages that come
 * back to the pattern repeatedly, which is what an explanation does.
 */
export function rankExact<T extends { content: string; metadata: Record<string, unknown> | null }>(
  rows: T[],
  pattern: string,
): T[] {
  const bare = pattern.replace(/^[～〜~]+/, "");
  const score = (row: T) => {
    const taught = Array.isArray(row.metadata?.["grammar_points"])
      ? (row.metadata["grammar_points"] as unknown[]).some(
          (point) => typeof point === "string" && point.replace(/^[～〜~]+/, "").includes(bare),
        )
      : false;
    const mentions = row.content.split(bare).length - 1;
    const isTextbook = (row as { documents?: { is_citable?: boolean } }).documents?.is_citable;
    return (taught ? 8 : 0) + (isTextbook ? 3 : 0) + Math.min(mentions, 3);
  };
  return [...rows].sort((a, b) => score(b) - score(a));
}

/** Chunks containing a named pattern literally.
 *
 * A substring match is a blunt instrument, which is the point: when the
 * student names a pattern, the pages that print it are the pages they need,
 * and no amount of ranking should be able to lose them. Kept small — this
 * supplements the ranked candidates, it does not replace them.
 */
export async function retrieveExact(
  supabase: SupabaseClient,
  patterns: string[],
  perPattern = 2,
): Promise<RetrievedChunk[]> {
  if (patterns.length === 0) return [];

  const results = await Promise.all(
    patterns.map((pattern) =>
      supabase
        .from("chunks")
        .select(
          "id, document_id, pdf_page, book_page, content, metadata, documents!inner(title, doc_type, is_citable)",
        )
        .ilike("content", `%${pattern}%`)
        // Wider than needed, then ranked below. Unranked, the first rows back
        // were exercise sheets that merely USE the pattern in a sentence —
        // live, "〜ておくの使い方は？" came back with a 練習 page and the
        // answer said the textbooks do not cover 〜ておく.
        .limit(12)
        .then(({ data }) => rankExact(data ?? [], pattern).slice(0, perPattern)),
    ),
  );

  type Row = {
    id: number;
    document_id: number;
    pdf_page: number;
    book_page: string | null;
    content: string;
    metadata: Record<string, unknown> | null;
    documents: { title: string; doc_type: string; is_citable: boolean } | null;
  };

  return (results.flat() as unknown as Row[]).map((row) => ({
    chunk_id: row.id,
    document_id: row.document_id,
    doc_title: row.documents?.title ?? "",
    doc_type: row.documents?.doc_type ?? "",
    is_citable: Boolean(row.documents?.is_citable),
    pdf_page: row.pdf_page,
    book_page: row.book_page,
    content: row.content,
    metadata: row.metadata ?? {},
    score: 0,
    similarity: 0,
    exact: true,
  }));
}

const QUOTE_LIMIT = Number(process.env.CITATION_QUOTE_CHARS ?? 200);

/** Below this cosine similarity the corpus does not really cover the
 * question — cite nothing rather than decorate an answer with noise.
 * Measured on the live corpus: on-topic grammar questions score ~0.78,
 * small talk ~0.59. */
export const CITE_MIN_SIMILARITY = Number(process.env.CITE_MIN_SIMILARITY ?? 0.66);

/** Strip Markdown/furigana scaffolding so quotes read as plain text. */
function plainText(markdown: string): string {
  return markdown
    .replace(/《[^》]*》/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[|*_`>]/g, " ")
    .replace(/^\s*-{2,}.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build the citation list from retrieved chunks.
 *
 * Only textbook chunks (is_citable) appear here — a citation is a pointer to
 * a printed page the student can open, and handouts have no such page (the
 * model may still quote and name them freely in the answer itself). Quotes
 * are capped only to keep the citation card compact. Chunks below the
 * similarity floor never cite: an off-topic question retrieves *something*,
 * but decorating "hello" with a textbook reference helps nobody.
 */
export function buildCitations(chunks: RetrievedChunk[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const chunk of chunks) {
    if (!chunk.is_citable) continue;
    if ((chunk.similarity ?? 0) < CITE_MIN_SIMILARITY) continue;
    const key = `${chunk.document_id}:${chunk.book_page ?? chunk.pdf_page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      document_id: chunk.document_id,
      title: chunk.doc_title,
      book_page: chunk.book_page,
      quote: plainText(chunk.content).slice(0, QUOTE_LIMIT),
    });
  }

  return citations.slice(0, 4);
}
