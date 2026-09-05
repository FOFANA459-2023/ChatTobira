"""Write documents and chunks straight to Postgres via DATABASE_URL.

Direct connection rather than the PostgREST API: ingestion is a trusted batch
process with the database password, so routing through the API layer would add
a dependency on the service-role key for zero benefit. RLS does not apply to
the postgres role; the API keys matter only for the web app.
"""

from __future__ import annotations

import json
from typing import Any

import psycopg

from .chunker import Chunk
from .config import CONFIG
from .discover import SourceDoc


def connect() -> psycopg.Connection:
    return psycopg.connect(CONFIG.database_url, connect_timeout=15)


def _vector_literal(values: list[float]) -> str:
    """pgvector's text input format; cast with ::vector in SQL."""
    return "[" + ",".join(f"{v:.7g}" for v in values) + "]"


def upsert_document(
    conn: psycopg.Connection,
    doc: SourceDoc,
    page_count: int,
    topics: list[str] | None = None,
) -> int:
    """Insert or update the document row, returning its id.

    `topics` overrides what discovery read off the path. It exists for the
    past-paper compilations, whose topics are printed on their pages and not
    in their filenames: the override is what lets a topic-scoped search reach
    them, because that arm filters on documents.topics.
    """
    resolved = doc.topics if topics is None else topics
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into documents
              (path, title, level, topic, topics, doc_type, is_citable,
               page_count, content_sha, ingested_at)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            on conflict (path) do update set
              title = excluded.title,
              level = excluded.level,
              topic = excluded.topic,
              topics = excluded.topics,
              doc_type = excluded.doc_type,
              is_citable = excluded.is_citable,
              page_count = excluded.page_count,
              content_sha = excluded.content_sha,
              ingested_at = now()
            returning id
            """,
            (
                doc.path,
                doc.title,
                doc.level,
                doc.topic or (resolved[0] if resolved else None),
                resolved,
                doc.doc_type,
                doc.is_citable,
                page_count,
                doc.content_sha,
            ),
        )
        return cur.fetchone()[0]


def replace_chunks(
    conn: psycopg.Connection,
    document_id: int,
    chunks: list[Chunk],
    embeddings: list[list[float]],
) -> int:
    if len(chunks) != len(embeddings):
        raise ValueError(f"{len(chunks)} chunks but {len(embeddings)} embeddings")

    with conn.cursor() as cur:
        # Full replace keeps re-ingestion idempotent: an edited handout must not
        # leave stale chunks behind that would still surface in retrieval.
        cur.execute("delete from chunks where document_id = %s", (document_id,))
        cur.executemany(
            """
            insert into chunks
              (document_id, pdf_page, book_page, ord, content, tokens_text,
               reading, embedding, metadata)
            values (%s, %s, %s, %s, %s, %s, %s, %s::vector, %s)
            """,
            [
                (
                    document_id,
                    c.pdf_page,
                    c.book_page,
                    c.ord,
                    c.content,
                    c.tokens,
                    c.reading,
                    _vector_literal(v),
                    json.dumps(c.metadata, ensure_ascii=False),
                )
                for c, v in zip(chunks, embeddings, strict=True)
            ],
        )
    return len(chunks)


def fetch_document_shas(conn: psycopg.Connection) -> dict[str, tuple[str | None, int | None]]:
    """path -> (content_sha, page_count) for everything already indexed.

    The push stage's duplicate check. The page count rides along because a
    document interrupted mid-transcription can be pushed with a subset of its
    pages and later completed: the file's bytes never changed, so the hash
    alone would call the half-ingested version current and the rest of the
    book would never be indexed.
    """
    with conn.cursor() as cur:
        cur.execute("select path, content_sha, page_count from documents")
        return {path: (sha, pages) for path, sha, pages in cur.fetchall()}


def fetch_documents(conn: psycopg.Connection) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            "select id, path, is_citable, doc_type, level, topics, page_count "
            "from documents order by id"
        )
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def fetch_chunk_fields(conn: psycopg.Connection) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute("select id, document_id, content, tokens_text, book_page, metadata from chunks")
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def corpus_stats(conn: psycopg.Connection) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            """
            select
              (select count(*) from documents),
              (select count(*) from documents where is_citable),
              (select count(*) from chunks)
            """
        )
        docs, citable, chunks = cur.fetchone()
    return {"documents": docs, "citable_documents": citable, "chunks": chunks}
