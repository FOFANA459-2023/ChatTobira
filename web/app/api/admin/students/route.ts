import { ADMIN_EMAIL, isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

export const maxDuration = 30;

/** The student roster for the admin portal.
 *
 * One RPC rather than the paged crawl through the Auth Admin API this used
 * to need: admin_students() joins the allowlist to auth accounts and to what
 * students have actually done, in the database, where it is a single round
 * trip. See supabase/migrations/0006_admin_views.sql.
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
    // An unreachable auth backend is not an admin session.
  }
  if (!isAdminEmail(email)) {
    return Response.json({ error: "not_admin" }, { status: 403 });
  }

  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "admin_not_configured" }, { status: 503 });
  }

  const { data, error } = await service.rpc("admin_students");
  if (error) {
    console.error("admin_students failed:", error.message);
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }

  interface Row {
    email: string;
    display_name: string | null;
    invited_at: string;
    invited_by: string | null;
    registered: boolean;
    accepted: boolean;
    suspended: boolean;
    last_sign_in_at: string | null;
    last_activity_at: string | null;
    questions_today: number;
  }

  const students = ((data ?? []) as Row[])
    // The administrator is not one of their own students.
    .filter((row) => row.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase())
    .map((row) => ({
      email: row.email,
      name: row.display_name,
      invited_at: row.invited_at,
      registered: row.registered,
      accepted: row.accepted,
      suspended: row.suspended,
      last_sign_in_at: row.last_sign_in_at,
      last_activity_at: row.last_activity_at,
      questions_today: row.questions_today,
    }));

  return Response.json({
    students,
    summary: {
      invited: students.length,
      accepted: students.filter((s) => s.accepted).length,
      // Invited, emailed, and never once opened: the students to chase.
      waiting: students.filter((s) => !s.accepted).length,
      suspended: students.filter((s) => s.suspended).length,
    },
  });
}
