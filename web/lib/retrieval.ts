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
 * HARD RULE: only textbook chunks (is_citable) may ever appear here. Class
 * handouts ground the answer but are never named. Enforced here, server-side,
 * regardless of what the model says. Quotes are capped so the app excerpts
 * rather than reproduces the commercial textbooks.
 */
export function buildCitations(chunks: RetrievedChunk[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const chunk of chunks) {
    if (!chunk.is_citable) continue;
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
