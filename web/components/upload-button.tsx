"use client";

import { useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  ACCEPT_ATTRIBUTE,
  formatBytes,
  isAcceptedType,
  MAX_UPLOAD_BYTES,
  type CourseLevel,
} from "@/lib/uploads";

export interface AttachedFile {
  id: number;
  filename: string;
  status: "uploading" | "reading" | "ready" | "failed";
  detail?: string;
}

/** Attach a photo or PDF of a handout and ask questions about it.
 *
 * One click opens the device's file picker, the way every chat app works.
 * The student is asked nothing else: which course and topic a file belongs
 * to only matters if it is ever promoted into the shared corpus, and that
 * decision is the admin's, made on the review screen where the metadata can
 * be set with the document actually in front of them. Asking a student to
 * classify a worksheet before they can ask a question about it is a form
 * to fill in, not a chat.
 *
 * The bytes go from the browser straight to Storage with a server-issued
 * signed URL — never through the Worker, which would have to hold 10 MB in
 * memory to accomplish nothing. The server then reads the file once and
 * extracts its text, which is what actually reaches the model.
 */
export function UploadButton({
  defaultLevel,
  disabled,
  onAttached,
  onUpdate,
}: {
  defaultLevel?: CourseLevel | null;
  disabled?: boolean;
  onAttached: (file: AttachedFile) => void;
  onUpdate: (id: number, patch: Partial<AttachedFile>) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState("");

  async function handleFile(file: File) {
    setError("");
    if (!isAcceptedType(file.type)) {
      setError("Photos and PDFs only for now.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`That file is ${formatBytes(file.size)} — the limit is 10 MB.`);
      return;
    }

    // 1. Register the upload and get a signed URL to write to. Level rides
    //    along only as a hint from the student's profile; it is not asked
    //    for, and the admin sets it for real at review time.
    const created = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
        size: file.size,
        level: defaultLevel ?? undefined,
      }),
    });

    if (!created.ok) {
      const body = (await created.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      setError(
        body.message ??
          (body.error === "not_signed_in"
            ? "Sign in to attach your own material."
            : "That upload could not be started."),
      );
      return;
    }

    const { id, bucket, path, token } = (await created.json()) as {
      id: number;
      bucket: string;
      path: string;
      token: string;
    };
    onAttached({ id, filename: file.name, status: "uploading" });

    // 2. Browser -> Storage directly.
    const supabase = createClient();
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .uploadToSignedUrl(path, token, file);
    if (uploadError) {
      onUpdate(id, { status: "failed", detail: "Upload interrupted." });
      return;
    }

    // 3. Server reads it back once and extracts the text.
    onUpdate(id, { status: "reading" });
    const finalized = await fetch("/api/upload", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    if (!finalized.ok) {
      const body = (await finalized.json().catch(() => ({}))) as { reason?: string };
      onUpdate(id, {
        status: "failed",
        detail: body.reason ?? "That file could not be read.",
      });
      return;
    }

    const { unreadable } = (await finalized.json()) as { unreadable?: boolean };
    onUpdate(id, {
      status: "ready",
      detail: unreadable
        ? "Parts of this were too blurry to read — a clearer photo would help."
        : undefined,
    });
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ""; // re-picking the same file must re-fire
          if (file) void handleFile(file);
        }}
      />

      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        aria-label="Attach a photo or PDF"
        title="Attach a photo or PDF of your handout"
        className="relative rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-stone-600 hover:bg-stone-100 disabled:opacity-50"
      >
        {/* paperclip */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        {error && (
          <span className="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-left text-xs font-normal text-red-700">
            {error}
          </span>
        )}
      </button>
    </>
  );
}
