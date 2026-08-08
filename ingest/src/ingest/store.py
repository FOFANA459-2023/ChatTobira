"""Write documents and chunks to Supabase using the service role key."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from .chunker import Chunk
from .config import CONFIG
from .discover import SourceDoc

INSERT_BATCH = 100


@lru_cache(maxsize=1)
def client():
    from supabase import create_client

    return create_client(CONFIG.supabase_url, CONFIG.supabase_key)


def _vector_literal(values: list[float]) -> str:
    """pgvector's text input format.

    PostgREST serialises a Python list as a Postgres *array* literal, which does
    not cast to vector. The bracketed form does.
    """
    return "[" + ",".join(f"{v:.7g}" for v in values) + "]"


def upsert_document(doc: SourceDoc, page_count: int) -> int:
    row: dict[str, Any] = {
        "path": doc.path,
        "title": doc.title,
        "level": doc.level,
        "topic": doc.topic,
        "topics": doc.topics,
        "doc_type": doc.doc_type,
        "is_citable": doc.is_citable,
        "page_count": page_count,
        "content_sha": doc.content_sha,
        "ingested_at": "now()",
    }
    result = client().table("documents").upsert(row, on_conflict="path").execute()
    return result.data[0]["id"]


def replace_chunks(document_id: int, chunks: list[Chunk], embeddings: list[list[float]]) -> int:
    if len(chunks) != len(embeddings):
        raise ValueError(f"{len(chunks)} chunks but {len(embeddings)} embeddings")

    # Full replace keeps re-ingestion idempotent: an edited handout must not
    # leave stale chunks behind that would still surface in retrieval.
    client().table("chunks").delete().eq("document_id", document_id).execute()

    rows = [
        {
            "document_id": document_id,
            "pdf_page": chunk.pdf_page,
            "book_page": chunk.book_page,
            "ord": chunk.ord,
            "content": chunk.content,
            "tokens_text": chunk.tokens,
            "reading": chunk.reading,
            "embedding": _vector_literal(vector),
            "metadata": chunk.metadata,
        }
        for chunk, vector in zip(chunks, embeddings, strict=True)
    ]

    for i in range(0, len(rows), INSERT_BATCH):
        client().table("chunks").insert(rows[i : i + INSERT_BATCH]).execute()

    return len(rows)


def corpus_stats() -> dict[str, Any]:
    docs = client().table("documents").select("id,path,is_citable,page_count").execute()
    chunks = client().table("chunks").select("id", count="exact").limit(1).execute()
    return {
        "documents": len(docs.data),
        "citable_documents": sum(1 for d in docs.data if d["is_citable"]),
        "chunks": chunks.count,
    }
