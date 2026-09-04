import { isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

export const maxDuration = 30;

/** The corpus as the RAG system currently sees it.
 *
 * Everything here is already recorded by the ingest pipeline; this reads it
 * back rather than tracking anything of its own. The one derived fact is
 * `status`, which turns three counts into the question an admin is actually
 * asking: is this document answering questions or not?
 */
export async function GET() {
  const supabase = await createClient();
  let email: string | undefined;
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    email = user?.email;
  } catch {
    /* an unreachable auth backend is not an admin session */
  }
  if (!isAdminEmail(email)) {
    return Response.json({ error: "not_admin" }, { status: 403 });
  }

  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "admin_not_configured" }, { status: 503 });
  }

  const { data, error } = await service.rpc("admin_documents");
  if (error) {
    console.error("admin_documents failed:", error.message);
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }

  interface Row {
    id: number;
    path: string;
    title: string;
    level: string | null;
    topic: string | null;
    topics: string[] | null;
    doc_type: string;
    is_citable: boolean;
    page_count: number | null;
    ingested_at: string | null;
    created_at: string;
    chunk_count: number;
    embedded_count: number;
    paged_count: number;
  }

  const documents = ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    title: row.title,
    path: row.path,
    level: row.level,
    topics: row.topics ?? [],
    doc_type: row.doc_type,
    is_citable: row.is_citable,
    page_count: row.page_count,
    ingested_at: row.ingested_at ?? row.created_at,
    chunk_count: Number(row.chunk_count),
    embedded_count: Number(row.embedded_count),
    paged_count: Number(row.paged_count),
    status: documentStatus(Number(row.chunk_count), Number(row.embedded_count)),
  }));

  return Response.json({
    documents,
    summary: {
      documents: documents.length,
      searchable: documents.filter((d) => d.status === "indexed").length,
      chunks: documents.reduce((total, d) => total + d.chunk_count, 0),
      citable: documents.filter((d) => d.is_citable).length,
    },
  });
}

/** A document with chunks but no embeddings is in the corpus and invisible
 * to search — the failure worth surfacing, and the one that looks identical
 * to a healthy document from every other angle. */
function documentStatus(chunks: number, embedded: number): "indexed" | "partial" | "empty" {
  if (chunks === 0) return "empty";
  if (embedded < chunks) return "partial";
  return "indexed";
}
