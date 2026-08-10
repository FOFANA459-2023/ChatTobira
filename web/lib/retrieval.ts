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

/** Small talk needs no retrieval: answering "hello" through an embedding
 * call, a cache probe, and a vector search wastes ~1s and then decorates the
 * greeting with textbook citations. */
export function isSmallTalk(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (GREETING_RE.test(trimmed)) return true;
  // Very short Latin-only messages ("ok!", "lol") are never grammar questions.
  return trimmed.length < 8 && !/[぀-ヿ一-鿿]/.test(trimmed);
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
export function tokensForQuery(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const tokens = segmenter
    .segment(trimmed)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !/^[\s\p{P}]+$/u.test(t));

  if (trimmed.length <= 16) {
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
