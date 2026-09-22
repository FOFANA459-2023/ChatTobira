"use client";

import { useEffect, useMemo, useState } from "react";

import { AdminShell, Card, TableSkeleton } from "@/components/admin/shell";
import { fileSize, shortDate } from "@/lib/time";
import { buildUploadZip, type CollectedUpload } from "@/lib/upload-zip";

interface Listed extends CollectedUpload {
  uploader: string;
}

/** Every file students have added to their chats, and one button that takes
 * them all away as a zip.
 *
 * These files are not in the knowledge base and nothing here puts them there.
 * The zip is raw material: download it, clean it, and add what is worth
 * keeping through the ingest pipeline. */
export default function UploadsPage() {
  const [uploads, setUploads] = useState<Listed[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [since, setSince] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void fetch("/api/admin/uploads")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { uploads: Listed[] }) => setUploads(body.uploads))
      .catch(() => {
        setFailed(true);
        setUploads([]);
      });
  }, []);

  const shown = useMemo(
    () => (uploads ?? []).filter((u) => !since || u.createdAt.slice(0, 10) >= since),
    [uploads, since],
  );
  const totalBytes = shown.reduce((sum, u) => sum + (u.sizeBytes ?? 0), 0);

  async function download() {
    if (shown.length === 0) return;
    setNote(null);
    setProgress({ done: 0, total: shown.length });
    try {
      const { zip, missing } = await buildUploadZip(
        shown,
        async (url) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(String(response.status));
          return new Uint8Array(await response.arrayBuffer());
        },
        (done, total) => setProgress({ done, total }),
      );
      const blob = new Blob([zip as BlobPart], { type: "application/zip" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `chattobira-uploads-${new Date().toISOString().slice(0, 10)}${since ? `-since-${since}` : ""}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      setNote(
        missing.length === 0
          ? { ok: true, text: `Downloaded ${shown.length} ${shown.length === 1 ? "file" : "files"}.` }
          : {
              ok: false,
              text: `Downloaded, but ${missing.length} ${missing.length === 1 ? "file" : "files"} could not be fetched (listed in manifest.csv with fetched = no).`,
            },
      );
    } catch {
      setNote({ ok: false, text: "The zip could not be built. Reload the page and try again." });
    } finally {
      setProgress(null);
    }
  }

  return (
    <AdminShell
      active="uploads"
      title="Student uploads"
      intro="Every file students have added to their chats. Kept apart from the knowledge base: download them, clean them, then add what is worth keeping through the ingest pipeline."
    >
      {note && (
        <p
          className={`mb-4 rounded-xl px-4 py-2.5 text-sm ${
            note.ok ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-900"
          }`}
        >
          {note.text}
        </p>
      )}

      <Card
        title="Download"
        description="A zip with each file, the text read out of it, and a manifest. No student names or emails go into it."
      >
        <div className="flex flex-wrap items-end gap-3 px-4 py-4">
          <label className="text-sm text-stone-600">
            <span className="block text-xs text-stone-500">Only files since</span>
            <input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="mt-1 rounded-lg border border-stone-300 px-2.5 py-1.5 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() => void download()}
            disabled={progress !== null || shown.length === 0}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {progress
              ? `Fetching ${progress.done} / ${progress.total}…`
              : `Download ${shown.length} ${shown.length === 1 ? "file" : "files"} (.zip)`}
          </button>
          {shown.length > 0 && !progress && (
            <span className="text-xs text-stone-500">about {fileSize(totalBytes)}</span>
          )}
        </div>
      </Card>

      <div className="mt-6">
        <Card title="Files" description="Newest first. Open any file to view it in the browser.">
          {uploads === null ? (
            <TableSkeleton rows={4} columns={4} />
          ) : failed ? (
            <p className="px-4 py-8 text-center text-sm text-red-700">
              The uploads could not be loaded.
            </p>
          ) : shown.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-stone-500">
              {since ? "No files since that date." : "No student has uploaded a file yet."}
            </p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {shown.map((u) => (
                <li key={u.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <a
                    href={`/api/upload/view?id=${u.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 max-w-full truncate font-medium text-stone-900 underline decoration-stone-300 underline-offset-2 hover:decoration-stone-700"
                  >
                    {u.filename}
                  </a>
                  <span className="text-xs text-stone-500">
                    {u.uploader} · {fileSize(u.sizeBytes)} · {shortDate(u.createdAt)}
                    {u.level ? ` · ${u.level}${u.topic ? ` ${u.topic}` : ""}` : ""}
                    {u.status === "failed" ? " · could not be read" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AdminShell>
  );
}
