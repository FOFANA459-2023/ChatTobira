"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminShell, Card, TableSkeleton } from "@/components/admin/shell";
import { fileSize, relativeTime, shortDate } from "@/lib/time";
import { COURSE_LEVELS, TOPICS_BY_LEVEL, type CourseLevel } from "@/lib/uploads";

interface Document {
  id: number;
  title: string;
  path: string;
  level: string | null;
  topics: string[];
  doc_type: string;
  is_citable: boolean;
  page_count: number | null;
  ingested_at: string;
  chunk_count: number;
  embedded_count: number;
  paged_count: number;
  status: "indexed" | "partial" | "empty";
}

interface Submission {
  id: number;
  filename: string;
  level: CourseLevel | null;
  topic: string | null;
  status: string;
  size_bytes: number;
  created_at: string;
  uploader: string;
  preview: string;
  destination: string | null;
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[] | null>(null);
  const [queue, setQueue] = useState<Submission[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    void fetch("/api/admin/documents")
      .then((r) => (r.ok ? r.json() : { documents: [] }))
      .then((body: { documents: Document[] }) => setDocuments(body.documents))
      .catch(() => setDocuments([]));
    void fetch("/api/upload/review")
      .then((r) => (r.ok ? r.json() : { queue: [] }))
      .then((body: { queue?: Submission[] }) => setQueue(body.queue ?? []))
      .catch(() => setQueue([]));
  }, []);

  useEffect(load, [load]);

  async function review(
    id: number,
    action: "approve" | "reject",
    level?: CourseLevel | null,
    topic?: string | null,
  ) {
    setBusyId(id);
    setNote(null);
    try {
      const response = await fetch("/api/upload/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          action,
          ...(level ? { level } : {}),
          ...(topic !== undefined ? { topic } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        setNote({
          ok: true,
          text:
            action === "approve"
              ? "Approved. It joins the corpus on the next `ingest uploads` run."
              : "Rejected. It stays private to the student who uploaded it.",
        });
      } else if (body.error === "level_required") {
        setNote({ ok: false, text: "Choose a level before approving — it decides where the file is filed." });
      } else {
        setNote({ ok: false, text: "That could not be saved. Please try again." });
      }
      load();
    } catch {
      setNote({ ok: false, text: "That could not be saved. Please try again." });
    } finally {
      setBusyId(null);
    }
  }

  const waiting = (queue ?? []).filter((item) => item.status === "submitted");
  const cleared = (queue ?? []).filter((item) => item.status === "approved");

  return (
    <AdminShell
      active="documents"
      title="Knowledge base"
      intro="Everything the assistant can answer from, and what students have offered to it."
    >
      {note && (
        <p
          className={`mb-4 rounded-xl px-4 py-2.5 text-sm ${
            note.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
          }`}
        >
          {note.text}
        </p>
      )}

      <Card
        title="Student uploads awaiting review"
        description="Nothing reaches the shared corpus until you approve it."
      >
        {queue === null ? (
          <TableSkeleton rows={2} columns={3} />
        ) : waiting.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-stone-500">
            Nothing waiting.
            {cleared.length > 0 &&
              ` ${cleared.length} approved ${cleared.length === 1 ? "file is" : "files are"} queued for the next ingest run.`}
          </p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {waiting.map((item) => (
              <li key={item.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="font-medium text-stone-900">{item.filename}</p>
                    <p className="text-xs text-stone-500">
                      {item.uploader} · {fileSize(item.size_bytes)} ·{" "}
                      {relativeTime(item.created_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ReviewControls
                      item={item}
                      busy={busyId === item.id}
                      onApprove={(level, topic) => review(item.id, "approve", level, topic)}
                      onReject={() => review(item.id, "reject")}
                    />
                    <button
                      onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                      className="rounded-lg border border-stone-200 px-2.5 py-1 text-xs text-stone-600 hover:bg-stone-100"
                    >
                      {expanded === item.id ? "Hide" : "Read"}
                    </button>
                  </div>
                </div>
                {item.destination && (
                  <p className="mt-1 text-xs text-stone-400">Will be filed as {item.destination}</p>
                )}
                {expanded === item.id && (
                  <pre
                    lang="ja"
                    className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-stone-50 p-3 text-xs leading-6 text-stone-700"
                  >
                    {item.preview || "(nothing was extracted from this file)"}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-4">
        <Card
          title={documents ? `${documents.length} documents in the corpus` : "Corpus"}
          description="Ingested through the pipeline. Passages are what retrieval actually searches."
        >
          {documents === null ? (
            <TableSkeleton rows={6} columns={5} />
          ) : documents.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-stone-500">
              No documents ingested yet. Run `ingest all` to build the corpus.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-stone-100 text-left text-xs uppercase tracking-wide text-stone-400">
                    <th className="px-4 py-2 font-medium">Document</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Pages</th>
                    <th className="px-4 py-2 font-medium">Passages</th>
                    <th className="px-4 py-2 font-medium">Indexed</th>
                    <th className="px-4 py-2 font-medium">Added</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {documents.map((document) => (
                    <tr key={document.id} className="hover:bg-stone-50/60">
                      <td className="px-4 py-3">
                        <p className="font-medium text-stone-900">{document.title}</p>
                        <p className="truncate text-xs text-stone-400" title={document.path}>
                          {document.path}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">
                          {document.doc_type}
                        </span>
                        {document.is_citable && (
                          <span
                            className="ml-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-800"
                            title="Answers may cite this book by page"
                          >
                            citable
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-stone-600">{document.page_count ?? "—"}</td>
                      <td className="px-4 py-3 text-stone-600">
                        {document.chunk_count.toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <IndexBadge document={document} />
                      </td>
                      <td className="px-4 py-3 text-stone-500">
                        {shortDate(document.ingested_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <p className="mt-4 text-xs text-stone-400">
        Documents are added and removed by the ingest pipeline (`ingest all`, `ingest uploads`),
        which owns transcription and embedding. This page reports what it produced.
      </p>
    </AdminShell>
  );
}

/** Whether this document can actually answer a question. A document with
 * passages but no embeddings is in the corpus and invisible to search, which
 * looks identical to a healthy one from every other angle. */
function IndexBadge({ document }: { document: Document }) {
  if (document.status === "empty") {
    return (
      <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
        No passages
      </span>
    );
  }
  if (document.status === "partial") {
    return (
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
        {document.embedded_count}/{document.chunk_count} embedded
      </span>
    );
  }
  return (
    <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800">
      Searchable
    </span>
  );
}

/** Approving needs a level, because the level and topic decide the folder the
 * file is written to, and the folder is what the pipeline reads them back
 * out of. The student's own choice is pre-filled and correctable here. */
function ReviewControls({
  item,
  busy,
  onApprove,
  onReject,
}: {
  item: Submission;
  busy: boolean;
  onApprove: (level: CourseLevel | null, topic: string | null) => void;
  onReject: () => void;
}) {
  const [level, setLevel] = useState<CourseLevel | "">(item.level ?? "");
  const [topic, setTopic] = useState<string>(item.topic ?? "");

  return (
    <>
      <select
        value={level}
        onChange={(event) => {
          setLevel(event.target.value as CourseLevel | "");
          setTopic("");
        }}
        className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-xs"
        aria-label="Level"
      >
        <option value="">Level…</option>
        {COURSE_LEVELS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        value={topic}
        onChange={(event) => setTopic(event.target.value)}
        disabled={!level}
        className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-xs disabled:opacity-50"
        aria-label="Topic"
      >
        <option value="">Topic…</option>
        {level &&
          TOPICS_BY_LEVEL[level].map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
      </select>
      <button
        onClick={() => onApprove(level || null, topic || null)}
        disabled={busy || !level}
        title={level ? undefined : "Choose a level first"}
        className="rounded-lg bg-stone-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-40"
      >
        {busy ? "…" : "Approve"}
      </button>
      <button
        onClick={onReject}
        disabled={busy}
        className="rounded-lg border border-stone-200 px-2.5 py-1 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-40"
      >
        Reject
      </button>
    </>
  );
}
