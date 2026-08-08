"""Embeddings via gemini-embedding-001.

Output is truncated to 768 dimensions using Matryoshka representation learning,
which keeps the whole corpus inside Supabase's 500MB free tier. Truncated
vectors are NOT unit length, so they must be re-normalised before storage —
pgvector's cosine operator tolerates it, but the semantic cache compares raw
similarity values and would drift without it.
"""

from __future__ import annotations

import math

from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from .config import CONFIG

# Document and query embeddings use different task types; mismatching them
# measurably degrades retrieval.
TASK_DOCUMENT = "RETRIEVAL_DOCUMENT"
TASK_QUERY = "RETRIEVAL_QUERY"

BATCH_SIZE = 32


class TransientEmbedError(RuntimeError):
    pass


def _client():
    from google import genai

    return genai.Client(api_key=CONFIG.google_api_key)


def _normalise(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector))
    return [v / norm for v in vector] if norm else vector


@retry(
    retry=retry_if_exception_type(TransientEmbedError),
    wait=wait_exponential(multiplier=4, min=4, max=120),
    stop=stop_after_attempt(6),
    reraise=True,
)
def _embed_batch(texts: list[str], task: str) -> list[list[float]]:
    from google.genai import types

    try:
        response = _client().models.embed_content(
            model=CONFIG.embed_model,
            contents=texts,
            config=types.EmbedContentConfig(
                task_type=task,
                output_dimensionality=CONFIG.embed_dim,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        message = str(exc)
        if any(m in message for m in ("429", "RESOURCE_EXHAUSTED", "503", "UNAVAILABLE")):
            raise TransientEmbedError(message) from exc
        raise

    return [_normalise(list(e.values)) for e in response.embeddings]


def embed_documents(texts: list[str]) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), BATCH_SIZE):
        out.extend(_embed_batch(texts[i : i + BATCH_SIZE], TASK_DOCUMENT))
    return out


def embed_query(text: str) -> list[float]:
    return _embed_batch([text], TASK_QUERY)[0]
