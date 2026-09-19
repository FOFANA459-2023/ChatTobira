import { z } from "zod";

import { ADMIN_EMAIL, isAdminEmail } from "@/lib/admin";
import { normalizeEmail } from "@/lib/email";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

export const maxDuration = 30;

// normalizeEmail first: addresses arrive with full-width IME characters and
// as Outlook's "Name <email>" form.
const BodySchema = z.object({
  email: z.string().transform(normalizeEmail).pipe(z.string().email()),
});

const PatchSchema = BodySchema.extend({
  action: z.enum(["suspend", "restore"]),
});

// Supabase expresses an indefinite ban as a very long duration; "none" lifts it.
const SUSPEND_DURATION = "876000h"; // ~100 years

async function requireAdmin(): Promise<boolean> {
  const supabase = await createClient();
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return isAdminEmail(user?.email);
  } catch {
    // An unreachable auth backend is not an admin session.
    return false;
  }
}

type Service = NonNullable<ReturnType<typeof serviceClient>>;

/** The auth id for one address, straight from profiles.
 *
 * profiles is written by the signup trigger in the same transaction that
 * creates the auth user, so a row here means an account exists and its id IS
 * the auth id — one indexed lookup rather than a crawl over every user. */
async function findAccountId(service: Service, email: string): Promise<string | null> {
  const { data } = await service.from("profiles").select("id").ilike("email", email).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** The student roster for the admin portal.
 *
 * One RPC: admin_students() joins accounts, profiles and what students have
 * actually done, in the database. See supabase/migrations/0010_open_signup.sql.
 */
export async function GET() {
  if (!(await requireAdmin())) {
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
    full_name: string | null;
    college: string | null;
    semester: number | null;
    reasons: string[] | null;
    signed_up_at: string;
    verified: boolean;
    onboarded: boolean;
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
      name: row.full_name,
      college: row.college,
      semester: row.semester,
      reasons: row.reasons ?? [],
      signed_up_at: row.signed_up_at,
      verified: row.verified,
      onboarded: row.onboarded,
      suspended: row.suspended,
      last_sign_in_at: row.last_sign_in_at,
      last_activity_at: row.last_activity_at,
      questions_today: row.questions_today,
    }));

  return Response.json({
    students,
    summary: {
      total: students.length,
      active: students.filter((s) => s.onboarded && !s.suspended).length,
      // Signed up and never clicked the confirmation link.
      unverified: students.filter((s) => !s.verified).length,
      // Verified, but stopped at the welcome questions.
      incomplete: students.filter((s) => s.verified && !s.onboarded).length,
      suspended: students.filter((s) => s.suspended).length,
    },
  });
}

/** Suspend or restore a student.
 *
 * Suspension pauses access but keeps the account and its history, so
 * restoring is a single click. The ban is what actually stops them — an
 * existing session dies at its next token refresh, within the hour. */
export async function PATCH(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: "not_admin" }, { status: 403 });
  }

  const parsed = PatchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { email, action } = parsed.data;
  if (isAdminEmail(email)) {
    return Response.json({ error: "is_admin" }, { status: 400 });
  }

  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "admin_not_configured" }, { status: 503 });
  }

  const id = await findAccountId(service, email);
  if (!id) {
    return Response.json({ error: "no_account" }, { status: 404 });
  }

  const { error } = await service.auth.admin.updateUserById(id, {
    ban_duration: action === "suspend" ? SUSPEND_DURATION : "none",
  });
  if (error) {
    return Response.json({ error: `${action}_failed` }, { status: 502 });
  }

  return Response.json({ ok: true, email, suspended: action === "suspend" });
}

/** Remove a student completely: the auth account is deleted outright, and
 * every table that references auth.users cascades — conversations, messages,
 * feedback, quiz history and quota rows go with it. Irreversible; suspend is
 * the reversible option. They may sign up again with the same address. */
export async function DELETE(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: "not_admin" }, { status: 403 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "bad_email" }, { status: 400 });
  }
  const { email } = parsed.data;
  if (isAdminEmail(email)) {
    return Response.json({ error: "is_admin" }, { status: 400 });
  }

  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "admin_not_configured" }, { status: 503 });
  }

  const id = await findAccountId(service, email);
  if (!id) {
    return Response.json({ error: "no_account" }, { status: 404 });
  }

  const { error } = await service.auth.admin.deleteUser(id);
  if (error) {
    // Still holding a session. Suspend so the removal is at least effective,
    // and report the partial result honestly.
    await service.auth.admin.updateUserById(id, { ban_duration: SUSPEND_DURATION });
    return Response.json({ error: "delete_failed", suspended: true }, { status: 502 });
  }

  return Response.json({ ok: true, email });
}
