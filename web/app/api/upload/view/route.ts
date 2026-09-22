import { isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { UPLOAD_BUCKET } from "@/lib/uploads";

/** How long a view link lives. Long enough to open and read the file; short
 * enough that a link copied out of the address bar is soon worth nothing. */
const VIEW_SECONDS = 5 * 60;

/** Open an uploaded file in the browser, not as a download.
 *
 * GET /api/upload/view?id=<number> → 302 to a short-lived signed URL
 *
 * The bucket is private and has no student-facing policy, so the file is
 * never reachable directly. Whether this student may see it is answered by
 * reading the row under their own RLS — their own uploads only — and the
 * admin may open any. The signed URL is created without `download`, which is
 * what makes Storage serve it inline: an image or a PDF opens in the tab.
 */
export async function GET(request: Request) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const supabase = await createClient();
  let user = null;
  try {
    ({
      data: { user },
    } = await supabase.auth.getUser());
  } catch {
    user = null;
  }
  if (!user) return Response.json({ error: "not_signed_in" }, { status: 401 });

  const service = serviceClient();
  if (!service) return Response.json({ error: "uploads_not_configured" }, { status: 503 });

  // The admin reads through the service client; a student through their own
  // RLS, so another student's id finds nothing.
  const reader = isAdminEmail(user.email) ? service : supabase;
  const { data: upload } = await reader
    .from("uploads")
    .select("storage_path")
    .eq("id", id)
    .maybeSingle();
  if (!upload) return Response.json({ error: "not_found" }, { status: 404 });

  const { data: signed, error } = await service.storage
    .from(UPLOAD_BUCKET)
    .createSignedUrl(upload.storage_path as string, VIEW_SECONDS);
  if (error || !signed?.signedUrl) {
    return Response.json({ error: "not_available" }, { status: 404 });
  }
  return Response.redirect(signed.signedUrl, 302);
}
