import { isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { UPLOAD_BUCKET } from "@/lib/uploads";

export const maxDuration = 30;

/** How long the download links in one listing live. An hour covers building
 * a zip of every file over a slow connection. */
const LINK_SECONDS = 60 * 60;

/** Every file students have added to their chats, for the admin to collect.
 *
 * Student uploads live apart from the knowledge base: their own bucket, their
 * own table, and no path from either into the documents and chunks the tutor
 * answers from. Growing the knowledge base from them is deliberately manual —
 * the admin downloads the lot as a zip from /admin/uploads, cleans it, and
 * adds what is worth keeping through the ingest pipeline.
 *
 * GET → { uploads: [...] }, each with a short-lived `url` to fetch the file
 *       from and the text read out of it at upload time. The browser builds
 *       the zip, so the Worker never holds a single file, let alone all of
 *       them.
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
    email = undefined;
  }
  if (!isAdminEmail(email)) {
    return Response.json({ error: "not_admin" }, { status: 403 });
  }

  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "uploads_not_configured" }, { status: 503 });
  }

  const { data, error } = await service
    .from("uploads")
    .select(
      "id, user_id, filename, content_type, size_bytes, storage_path, level, topic, status, extracted, created_at",
    )
    // 'pending' never finished uploading, so there is no file to collect.
    .neq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) {
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }
  const rows = data ?? [];

  // One call signs every link.
  const { data: signed } = await service.storage
    .from(UPLOAD_BUCKET)
    .createSignedUrls(
      rows.map((row) => row.storage_path as string),
      LINK_SECONDS,
    );
  const urls = new Map(
    (signed ?? []).map((entry) => [entry.path ?? "", entry.signedUrl ?? null]),
  );

  // Who uploaded it, shown on the page so the admin can ask about a file. It
  // is never written into the zip: the knowledge base needs the page, not the
  // student.
  const emails = new Map<string, string>();
  const { data: accounts } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const account of accounts?.users ?? []) {
    if (account.email) emails.set(account.id, account.email);
  }

  return Response.json({
    uploads: rows.map((row) => ({
      id: row.id as number,
      filename: row.filename as string,
      contentType: row.content_type as string,
      sizeBytes: row.size_bytes as number,
      level: (row.level as string | null) ?? null,
      topic: (row.topic as string | null) ?? null,
      status: row.status as string,
      createdAt: row.created_at as string,
      uploader: emails.get(row.user_id as string) ?? "unknown",
      extracted: (row.extracted as string | null) ?? "",
      url: urls.get(row.storage_path as string) ?? null,
    })),
  });
}
