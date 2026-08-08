"""Ingestion CLI.

Stages are split so the expensive one is checkpointed: `transcribe` writes
Markdown to .work/text and records completion in the manifest, so a run killed
by a rate limit resumes rather than re-paying for pages already read. `push` is
cheap and can be re-run freely against that cache.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from . import render, store, verify
from .chunker import chunk_document
from .config import CONFIG
from .discover import SourceDoc, discover
from .embed import embed_documents
from .manifest import Manifest
from .transcribe import DailyQuotaError, PageText, transcribe

app = typer.Typer(add_completion=False, help="ChatTobira ingestion pipeline")
console = Console()

# Windows consoles default to cp1252 and cannot print Japanese.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _text_path(doc: SourceDoc) -> Path:
    return CONFIG.text_dir / f"{doc.content_sha[:12]}.json"


def _partial_path(doc: SourceDoc) -> Path:
    return CONFIG.text_dir / f"{doc.content_sha[:12]}.partial.json"


def _save_pages(path: Path, pages: list[PageText]) -> None:
    path.write_text(
        json.dumps([p.__dict__ for p in pages], ensure_ascii=False, indent=1),
        "utf-8",
    )


def _load_pages(doc: SourceDoc) -> list[PageText] | None:
    path = _text_path(doc)
    if not path.exists():
        return None
    raw = json.loads(path.read_text("utf-8"))
    return [PageText(**p) for p in raw]


@app.command("discover")
def cmd_discover() -> None:
    """Inventory the materials tree and show derived metadata."""
    docs = discover()
    table = Table(title=f"{len(docs)} source documents")
    for col in ("level", "topic", "type", "cite", "grammar point", "path"):
        table.add_column(col, overflow="fold")
    for d in docs:
        table.add_row(
            d.level or "-",
            ",".join(d.topics) or "-",
            d.doc_type,
            "YES" if d.is_citable else "-",
            d.grammar_point or "-",
            d.path,
        )
    console.print(table)


@app.command("transcribe")
def cmd_transcribe(
    only: str = typer.Option("", help="Substring filter on the document path"),
    limit: int = typer.Option(0, help="Stop after N documents (0 = all)"),
    force: bool = typer.Option(False, help="Re-transcribe even if cached"),
) -> None:
    """Convert, render, and transcribe pages to Markdown (the expensive stage)."""
    CONFIG.ensure_dirs()
    manifest = Manifest()
    docs = [d for d in discover() if not only or only.lower() in d.path.lower()]
    # Smallest sources first: on a quota-capped day this completes dozens of
    # handouts instead of burning the whole budget partway into one textbook.
    docs.sort(key=lambda d: d.size_bytes)
    if limit:
        docs = docs[:limit]

    for doc in docs:
        if not force and manifest.done("transcribe", doc.path, doc.content_sha):
            console.print(f"[dim]cached[/dim]  {doc.path}")
            continue

        console.print(f"[cyan]render[/cyan]  {doc.path}")
        try:
            pdf = render.to_pdf(doc)
        except RuntimeError as exc:
            if "LibreOffice" in str(exc):
                # No converter on this machine: do every PDF now, leave the
                # Office files for a machine that has LibreOffice.
                console.print(f"[yellow]skip[/yellow]    {doc.path} (needs LibreOffice)")
                continue
            raise
        images = render.render_pages(doc, pdf)

        # Resume a partially transcribed document from its checkpoint file:
        # with a 20-requests/day model, pages already paid for must never be
        # paid for twice.
        partial = _partial_path(doc)
        done_pages: list[PageText] = []
        if not force and partial.exists():
            done_pages = [PageText(**p) for p in json.loads(partial.read_text("utf-8"))]
            console.print(f"[dim]resume[/dim]  {doc.path}: {len(done_pages)} pages checkpointed")

        remaining = images[len(done_pages) :]
        console.print(f"[cyan]vision[/cyan]  {doc.path} ({len(remaining)}/{len(images)} pages)")

        try:
            pages = done_pages + transcribe(
                remaining,
                start_page=len(done_pages) + 1,
                on_batch=lambda batch, p=partial, d=done_pages: _save_pages(p, d + batch),
            )
        except DailyQuotaError:
            console.print(
                "[red]daily quota exhausted on every vision model[/red] — progress "
                "is checkpointed; re-run this command tomorrow to continue."
            )
            raise typer.Exit(75)  # EX_TEMPFAIL

        _save_pages(_text_path(doc), pages)
        partial.unlink(missing_ok=True)
        manifest.mark("transcribe", doc.path, doc.content_sha, pages=len(pages))

        japanese = sum(1 for p in pages if p.has_japanese)
        console.print(
            f"[green]done[/green]    {doc.path}: {japanese}/{len(pages)} pages with Japanese"
        )


@app.command("push")
def cmd_push(
    only: str = typer.Option("", help="Substring filter on the document path"),
) -> None:
    """Chunk, embed, and upsert transcribed documents into Supabase."""
    docs = [d for d in discover() if not only or only.lower() in d.path.lower()]
    total = 0

    for doc in docs:
        pages = _load_pages(doc)
        if pages is None:
            console.print(f"[yellow]skip[/yellow]    {doc.path} (not transcribed yet)")
            continue

        chunks = chunk_document(doc, pages)
        if not chunks:
            console.print(f"[yellow]skip[/yellow]    {doc.path} (no chunks)")
            continue

        console.print(f"[cyan]embed[/cyan]   {doc.path} ({len(chunks)} chunks)")
        vectors = embed_documents([c.metadata["embed_text"] for c in chunks])

        with store.connect() as conn:
            document_id = store.upsert_document(conn, doc, page_count=len(pages))
            written = store.replace_chunks(conn, document_id, chunks, vectors)
            conn.commit()
        total += written
        console.print(f"[green]stored[/green]  {doc.path}: {written} chunks")

    console.print(f"\n[bold]{total} chunks written[/bold]")


@app.command("verify")
def cmd_verify() -> None:
    """Run corpus health checks. Exits non-zero on failure."""
    with store.connect() as conn:
        docs = store.fetch_documents(conn)
        chunks = store.fetch_chunk_fields(conn)
        stats = store.corpus_stats(conn)

    counts: dict[int, int] = {}
    book_pages: dict[int, int] = {}
    for c in chunks:
        counts[c["document_id"]] = counts.get(c["document_id"], 0) + 1
        if c.get("book_page"):
            book_pages[c["document_id"]] = book_pages.get(c["document_id"], 0) + 1
    for d in docs:
        d["_has_book_pages"] = book_pages.get(d["id"], 0) > 0

    ok = verify.report(verify.check_chunks(chunks) + verify.check_documents(docs, counts))
    console.print(f"\n{stats}")
    raise typer.Exit(0 if ok else 1)


@app.command("all")
def cmd_all(
    only: str = typer.Option("", help="Substring filter on the document path"),
) -> None:
    """transcribe -> push -> verify."""
    cmd_transcribe(only=only, limit=0, force=False)
    cmd_push(only=only)
    cmd_verify()


if __name__ == "__main__":
    app()
