import { z } from "zod";

import { extractDocument, ExtractionError, isUnreadable } from "@/lib/extract";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import {
  isAcceptedType,
  UPLOAD_BUCKET,
  MAX_UPLOAD_BYTES,
  safeFilename,
  storageKey,
  TOPICS_BY_LEVEL,
  type CourseLevel,
} from "@/lib/uploads";

export const maxDuration = 60;

const CreateSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  // Both optional: the student is never asked to classify a file before
  // asking a question about it. Level rides along from their profile when
  // it is known, and the admin sets both for real on the review screen,
  // with the document in front of them. An upload with neither is still
  // perfectly usable as the uploader's own private context — the metadata
  // only decides where it is FILED, which only happens on approval.
  level: z.enum(["F2", "F3", "INT"]).optional(),
  topic: z.string().regex(/^T\d{1,2}$/).optional(),
});

const FinalizeSchema = z.object({
  id: z.number().int().positive(),
  // "extract" reads the stored bytes into text (the default, run right after
  // the browser finishes uploading). "share" is the student offering the
  // file to the shared corpus, which only queues it for review — nothing a
  // student does can put a document in front of the whole cohort.
  action: z.enum(["extract", "share"]).default("extract"),
});

async function requireUser() {
  const supabase = await createClient();
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return { supabase, user };
  } catch {
    return { supabase, user: null };
  }
}

/** Step 1: register the upload and hand back a signed URL.
 *
 * The bytes go from the browser straight to Storage and never through the
 * Worker — a 10 MB body would be both a CPU and a size problem there, and
 * relaying it buys nothing. The signed URL is what authorises the write, so
 * the bucket needs no student-facing storage policy at all.
 */
export async function POST(request: Request) {
  const { supabase, user } = await requireUser();
  if (!user) {
    // Uploads are a signed-in feature: they cost vision quota and they are
    // stored against an account. Trial visitors get the chat, not this.
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const parsed = CreateSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { filename, contentType, size, level, topic } = parsed.data;

  if (!isAcceptedType(contentType)) {
    return Response.json({ error: "unsupported_type" }, { status: 415 });
  }
  if (level && topic && !TOPICS_BY_LEVEL[level as CourseLevel].includes(topic)) {
    return Response.json({ error: "topic_not_in_level" }, { status: 400 });
  }

  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "uploads_not_configured" }, { status: 503 });
  }

  // Extraction is a vision call, the scarcest resource in this deployment.
  // Metered before anything is stored, and refunded below if the upload
  // never becomes usable.
  const { data: remaining, error: quotaError } = await supabase.rpc("consume_upload_quota");
  if (quotaError) {
    return Response.json({ error: "quota_check_failed" }, { status: 500 });
  }
  if (remaining === -1) {
    return Response.json(
      {
        error: "upload_quota_exhausted",
        message:
          "You have reached today's upload limit. It resets at midnight (Japan time).",
      },
      { status: 429 },
    );
  }

  // Inserted through the student's own client, so RLS re-checks that the row
  // belongs to them: the service role is used only for Storage below.
  const { data: row, error: insertError } = await supabase
    .from("uploads")
    .insert({
      user_id: user.id,
      filename: safeFilename(filename),
      content_type: contentType,
      size_bytes: size,
      level: level ?? null,
      topic: topic ?? null,
      // Placeholder: the real key needs the row id, so it is set immediately
      // below. Unique constraint keeps a collision impossible.
      storage_path: `pending/${user.id}/${crypto.randomUUID()}`,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !row) {
    await supabase.rpc("refund_upload_quota");
    return Response.json({ error: "create_failed" }, { status: 500 });
  }

  const path = storageKey(user.id, row.id as number, contentType);
  await supabase.from("uploads").update({ storage_path: path }).eq("id", row.id);

  const { data: signed, error: signError } = await service.storage
    .from(UPLOAD_BUCKET)
    .createSignedUploadUrl(path);

  if (signError || !signed) {
    await supabase.from("uploads").delete().eq("id", row.id);
    await supabase.rpc("refund_upload_quota");
    return Response.json({ error: "storage_unavailable" }, { status: 503 });
  }

  return Response.json({
    id: row.id,
    bucket: UPLOAD_BUCKET,
    path,
    token: signed.token,
    remaining,
  });
}

/** Step 2: the bytes are in Storage — read them once and extract the text.
 *
 * Runs after the browser has finished uploading. On failure the row is left
 * as 'failed' with a reason the student can see, and the quota unit is
 * refunded: a blurry photo should not cost one of five daily uploads.
 */
export async function PATCH(request: Request) {
  const { supabase, user } = await requireUser();
  if (!user) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const parsed = FinalizeSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  // RLS scopes this to the caller's own rows, so one student cannot trigger
  // extraction on another's upload.
  const { data: upload } = await supabase
    .from("uploads")
    .select("id, storage_path, content_type, status, extracted")
    .eq("id", parsed.data.id)
    .single();

  if (!upload) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  if (parsed.data.action === "share") {
    // Only a file that actually read cleanly can be offered: queueing a
    // blurred photo wastes the admin's time and would enter the corpus as
    // half a page if waved through.
    if (upload.status !== "ready") {
      return Response.json({ error: "not_ready" }, { status: 409 });
    }
    if (isUnreadable((upload.extracted as string) ?? "")) {
      return Response.json({ error: "unreadable" }, { status: 409 });
    }
    await supabase.from("uploads").update({ status: "submitted" }).eq("id", upload.id);
    return Response.json({ id: upload.id, status: "submitted" });
  }
  if (upload.status !== "pending") {
    // Already extracted, or already promoted. Re-running would spend vision
    // quota to produce the same text.
    return Response.json({ id: upload.id, status: upload.status });
  }

  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "uploads_not_configured" }, { status: 503 });
  }

  const fail = async (reason: string, status: number) => {
    await supabase
      .from("uploads")
      .update({ status: "failed", error: reason.slice(0, 300) })
      .eq("id", upload.id);
    await supabase.rpc("refund_upload_quota");
    return Response.json({ error: "extraction_failed", reason }, { status });
  };

  const { data: blob, error: downloadError } = await service.storage
    .from(UPLOAD_BUCKET)
    .download(upload.storage_path as string);
  if (downloadError || !blob) {
    return fail("the uploaded file could not be read back from storage", 502);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  // The declared size was trusted to issue the URL; the real bytes are what
  // actually reach the model, so they are checked here too.
  if (bytes.byteLength === 0) {
    return fail("the uploaded file was empty", 400);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return fail("the uploaded file is larger than the 10 MB limit", 413);
  }

  let extracted: string;
  try {
    extracted = await extractDocument(bytes, upload.content_type as string);
  } catch (error) {
    return fail(
      error instanceof ExtractionError
        ? error.message
        : "the file could not be read by the vision model",
      502,
    );
  }

  await supabase
    .from("uploads")
    .update({ status: "ready", extracted, error: null })
    .eq("id", upload.id);

  return Response.json({
    id: upload.id,
    status: "ready",
    unreadable: isUnreadable(extracted),
    characters: extracted.length,
  });
}

/** The caller's own uploads, newest first — the chat's attachment list. */
export async function GET() {
  const { supabase, user } = await requireUser();
  if (!user) {
    return Response.json({ uploads: [] });
  }

  const { data, error } = await supabase
    .from("uploads")
    .select("id, filename, content_type, size_bytes, level, topic, status, error, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }
  return Response.json({ uploads: data ?? [] });
}

/** Remove an upload: the object, then the row.
 *
 * Storage first, because a row without an object is merely untidy while an
 * object without a row is unreachable and un-deletable through the UI. An
 * upload already in the corpus keeps its chunks — those belong to the
 * document now, and removing them is `ingest push`'s job, not a student's.
 */
export async function DELETE(request: Request) {
  const { supabase, user } = await requireUser();
  if (!user) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const parsed = FinalizeSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const { data: upload } = await supabase
    .from("uploads")
    .select("id, storage_path")
    .eq("id", parsed.data.id)
    .single();
  if (!upload) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const service = serviceClient();
  if (service) {
    await service.storage.from(UPLOAD_BUCKET).remove([upload.storage_path as string]);
  }
  const { error } = await supabase.from("uploads").delete().eq("id", upload.id);
  if (error) {
    return Response.json({ error: "delete_failed" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
