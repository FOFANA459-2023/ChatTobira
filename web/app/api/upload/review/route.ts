import { z } from "zod";

import { ADMIN_EMAIL, isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { corpusPath, type CourseLevel } from "@/lib/uploads";

export const maxDuration = 30;

/** The gate between a student's file and the corpus every student reads.
 *
 * Nothing here is automated on purpose. Approving a document means agreeing
 * that the app may teach from it and cite it, which is a judgement about
 * correctness and about copyright that only the person running the course
 * can make.
 */

const ReviewSchema = z.object({
  id: z.number().int().positive(),
  action: z.enum(["approve", "reject"]),
  // Optional corrections at review time: a student who filed a Topic 13
  // worksheet under Topic 3 should not have to re-upload it.
  level: z.enum(["F2", "F3", "INT"]).optional(),
  topic: z.string().regex(/^T\d{1,2}$/).nullable().optional(),
});

async function requireAdmin() {
  const supabase = await createClient();
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user && isAdminEmail(user.email) ? user : null;
  } catch {
    return null;
  }
}

/** The review queue: everything students have offered, plus what is already
 * cleared and waiting for the pipeline to pick it up. */
export async function GET(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: "not_admin" }, { status: 403 });
  }
  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "uploads_not_configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const wanted = url.searchParams.get("status");
  const statuses = wanted ? [wanted] : ["submitted", "approved"];

  const { data, error } = await service
    .from("uploads")
    .select(
      "id, user_id, filename, content_type, size_bytes, level, topic, status, extracted, created_at",
    )
    .in("status", statuses)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }

  // The uploader's email, so the admin knows whose work they are reading —
  // and can ask them about it. listUsers is the only lookup available.
  const emails = new Map<string, string>();
  const { data: accounts } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const account of accounts?.users ?? []) {
    if (account.email) emails.set(account.id, account.email);
  }

  const queue = (data ?? []).map((row) => ({
    id: row.id as number,
    filename: row.filename as string,
    level: row.level as CourseLevel | null,
    topic: row.topic as string | null,
    status: row.status as string,
    size_bytes: row.size_bytes as number,
    created_at: row.created_at as string,
    uploader: emails.get(row.user_id as string) ?? "unknown",
    // Enough to judge the document without downloading it. The full text is
    // what would be ingested; this is the reviewer's look at it.
    preview: ((row.extracted as string | null) ?? "").slice(0, 1200),
    // Where it will land in the materials tree if approved, shown before
    // the decision rather than discovered afterwards.
    destination:
      row.level !== null
        ? corpusPath(row.level as CourseLevel, row.topic as string | null, row.filename as string)
        : null,
  }));

  return Response.json({ queue });
}

/** Approve or reject one submission.
 *
 * Approving does NOT put anything in the corpus by itself — it marks the row
 * for `ingest uploads`, which chunks and embeds it on the next run. The two
 * are deliberately separate: embedding needs the Python pipeline, and a
 * click in a browser should not be able to hang on a quota-limited batch.
 */
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) {
    return Response.json({ error: "not_admin" }, { status: 403 });
  }

  const parsed = ReviewSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { id, action, level, topic } = parsed.data;

  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "uploads_not_configured" }, { status: 503 });
  }

  const { data: upload } = await service
    .from("uploads")
    .select("id, status, level")
    .eq("id", id)
    .single();
  if (!upload) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  // Only a submission can be decided. Re-approving something already in the
  // corpus would queue a second ingest of the same document.
  if (upload.status !== "submitted") {
    return Response.json({ error: "not_submitted", status: upload.status }, { status: 409 });
  }

  const resolvedLevel = (level ?? upload.level) as CourseLevel | null;
  if (action === "approve" && !resolvedLevel) {
    // Level is what decides the folder, and the folder is what discover.py
    // reads level and topic back out of. Approving without one would file
    // the document nowhere.
    return Response.json({ error: "level_required" }, { status: 400 });
  }

  const { error } = await service
    .from("uploads")
    .update({
      status: action === "approve" ? "approved" : "rejected",
      ...(level ? { level } : {}),
      ...(topic !== undefined ? { topic } : {}),
      reviewed_by: ADMIN_EMAIL,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    return Response.json({ error: `${action}_failed` }, { status: 500 });
  }

  return Response.json({
    ok: true,
    id,
    status: action === "approve" ? "approved" : "rejected",
  });
}
