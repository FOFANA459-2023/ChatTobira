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
from .transcribe import DailyQuotaError, PageText, TransientVisionError, transcribe

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

        unreadable: list[str] = []

        try:
            pages = done_pages + transcribe(
                remaining,
                start_page=len(done_pages) + 1,
                on_batch=lambda batch, p=partial, d=done_pages: _save_pages(p, d + batch),
                on_warning=lambda message, seen=unreadable: (
                    seen.append(message),
                    console.print(f"[yellow]warn[/yellow]    {message}"),
                )[0],
            )
        except DailyQuotaError:
            console.print(
                "[red]daily quota exhausted on every vision model[/red] — progress "
                "is checkpointed; re-run this command tomorrow to continue."
            )
            raise typer.Exit(75)  # EX_TEMPFAIL
        except TransientVisionError as exc:
            # A page-sized traceback for a dropped connection buries the one
            # actionable fact: nothing is lost and re-running resumes.
            console.print(f"[red]network failure[/red] — {exc}")
            raise typer.Exit(75)  # EX_TEMPFAIL

        _save_pages(_text_path(doc), pages)
        partial.unlink(missing_ok=True)
        manifest.mark("transcribe", doc.path, doc.content_sha, pages=len(pages))

        japanese = sum(1 for p in pages if p.has_japanese)
        console.print(
            f"[green]done[/green]    {doc.path}: {japanese}/{len(pages)} pages with Japanese"
        )
        if unreadable:
            console.print(
                f"[yellow]note[/yellow]    {len(unreadable)} page(s) could not be "
                "transcribed and were stored empty; re-run with --force to retry them"
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


@app.command("invite")
def cmd_invite(
    # Optional so `--list` works on its own rather than demanding a dummy email.
    emails: list[str] | None = typer.Argument(None, help="Email addresses to invite"),
    note: str = typer.Option("", help="Optional note, e.g. 'F3 spring cohort'"),
    remove: bool = typer.Option(False, "--remove", help="Remove instead of add"),
    show: bool = typer.Option(False, "--list", help="List the allowlist and exit"),
) -> None:
    """Manage which students can sign up. Signup is blocked for anyone else."""
    from . import invite

    if show:
        rows = invite.list_all()
        for row in rows:
            console.print(f"{row['email']}  [dim]{row['note'] or ''}[/dim]")
        console.print(f"[bold]{len(rows)} invited[/bold]")
        return

    if not emails:
        console.print("[red]No email addresses given.[/red] Try --list to see the allowlist.")
        raise typer.Exit(2)

    if remove:
        for email in emails:
            gone = invite.remove(email)
            console.print(f"{'removed' if gone else 'not found'}: {email}")
        return

    added = invite.add(emails, note=note or None)
    skipped = len(emails) - len(added)
    console.print(
        f"[green]{len(added)} invited[/green]" + (f", {skipped} already present" if skipped else "")
    )


@app.command("backup")
def cmd_backup() -> None:
    """Mirror source files and transcripts to the private Supabase bucket.

    Content-addressed: an unchanged corpus uploads nothing but the index."""
    from . import backup

    manifest = Manifest()
    to_upload, unchanged = backup.plan_backup(manifest)
    console.print(f"{len(unchanged)} object(s) already backed up, {len(to_upload)} to upload")

    with backup.client() as http:
        backup.ensure_bucket(http)
        for item in to_upload:
            mb = item.size / (1 << 20)
            console.print(f"[cyan]upload[/cyan]  {item.path} ({mb:.1f} MB)")
            backup.upload(
                http, item.object_key, item.local.read_bytes(), backup.content_type_of(item.path)
            )
            # The first backup run stored objects under raw filename keys
            # before a Japanese filename hit InvalidKey; sweep that scheme's
            # object out as its replacement lands.
            previous = manifest.get("backup", item.path)
            if previous and not previous.get("object"):
                backup.delete(http, item.path)
            manifest.mark("backup", item.path, item.sha, object=item.object_key, size=item.size)

        # The manifest itself and the index ride along on every run: they are
        # tiny, and they are what a bare machine needs first.
        backup.upload(http, "work/manifest.json", manifest.path.read_bytes(), "application/json")
        backup.write_index(http, to_upload + unchanged)

    console.print(f"[green]backed up[/green] {len(to_upload)} object(s); index updated")


@app.command("restore")
def cmd_restore(
    force: bool = typer.Option(False, help="Overwrite local files even if they exist"),
) -> None:
    """Pull sources and transcripts down from the backup bucket.

    On a fresh machine: clone the repo, fill in .env, run `ingest restore`,
    and `ingest push` works immediately — no re-transcription."""
    from . import backup

    with backup.client() as http:
        index = json.loads(backup.download(http, backup.INDEX_KEY))
        fetched = skipped = 0
        for entry in index:
            target = backup.restore_target(entry["path"])
            if target is None:
                continue
            if target.exists() and not force:
                skipped += 1
                continue
            console.print(f"[cyan]fetch[/cyan]   {entry['path']}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(backup.download(http, entry["object"]))
            fetched += 1

        manifest_bytes = backup.download(http, "work/manifest.json")
        manifest_path = CONFIG.work_dir / "manifest.json"
        if force or not manifest_path.exists():
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_bytes(manifest_bytes)

    console.print(f"[green]restored[/green] {fetched} object(s), {skipped} already present")


@app.command("bounces")
def cmd_bounces(
    days: int = typer.Option(7, help="How many days of bounce messages to scan"),
    dry_run: bool = typer.Option(False, help="Report what would be revoked without deleting"),
) -> None:
    """Revoke invites whose email bounced.

    Gmail accepts a message and the invite API reports success; the
    university gateway rejects it minutes later and the bounce lands in the
    sending inbox. This reads that inbox and removes any student whose invite
    provably never arrived and who has never signed in."""
    from . import bounces

    found = bounces.fetch_bounces(days=days)
    if not found:
        console.print("no bounce messages found — every sent invite was accepted downstream")
        return

    for b in found:
        console.print(f"[yellow]bounce[/yellow]  {b.recipient} at {b.bounced_at:%Y-%m-%d %H:%M}")
    if dry_run:
        console.print("[dim]dry run — nothing deleted[/dim]")
        return

    revoked = bounces.sweep(found)
    for address in revoked:
        console.print(f"[red]revoked[/red] {address} — invite removed, they were never reachable")
    console.print(
        f"[bold]{len(revoked)} invite(s) revoked[/bold]"
        if revoked
        else "bounces were stale or students already signed in — nothing revoked"
    )


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
