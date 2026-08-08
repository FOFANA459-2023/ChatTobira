import { createClient as createSupabase } from "@supabase/supabase-js";
import { z } from "zod";

import { ADMIN_EMAIL, isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 30;

const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

/** The allowlist table is service-role only by design, so invites go through
 * this privileged client — after the admin check, never before. */
function serviceClient() {
  const url =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createSupabase(url, key, { auth: { persistSession: false } });
}

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

/** Invite a student: allowlist their email, then send them the sign-in link.
 * Both steps are idempotent — re-inviting someone just sends a fresh link. */
export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: "not_admin" }, { status: 403 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "bad_email" }, { status: 400 });
  }
  const { email } = parsed.data;

  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "invite_not_configured" }, { status: 503 });
  }

  const { error: allowlistError } = await service
    .from("allowlist")
    .upsert(
      { email, note: "invited via admin page", invited_by: ADMIN_EMAIL },
      { onConflict: "email", ignoreDuplicates: true },
    );
  if (allowlistError) {
    return Response.json({ error: "allowlist_failed" }, { status: 500 });
  }

  // The sign-in email is the same magic link students already use; the anon
  // client sends it so the flow matches a student requesting one themselves.
  const anon = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const { error: otpError } = await anon.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${new URL(request.url).origin}/auth/confirm` },
  });
  if (otpError) {
    // Allowlisted but the email did not go out (usually a rate limit). The
    // student can still request their own link from /login.
    return Response.json({ error: "send_failed", allowlisted: true }, { status: 502 });
  }

  return Response.json({ ok: true, email });
}

/** Invited students, newest first, for the admin page list. */
export async function GET() {
  if (!(await requireAdmin())) {
    return Response.json({ error: "not_admin" }, { status: 403 });
  }
  const service = serviceClient();
  if (!service) {
    return Response.json({ error: "invite_not_configured" }, { status: 503 });
  }

  const { data, error } = await service
    .from("allowlist")
    .select("email, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }
  return Response.json({ invites: data ?? [] });
}
