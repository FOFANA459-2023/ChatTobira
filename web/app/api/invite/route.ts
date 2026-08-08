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

/** Auth-user lookup by email via the paged admin listing — there is no
 * direct getUserByEmail in the admin API. */
async function findAuthUser(
  service: NonNullable<ReturnType<typeof serviceClient>>,
  email: string,
): Promise<{ id: string } | null> {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return null;
    const match = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (match) return { id: match.id };
    if (data.users.length < 200) return null;
  }
  return null;
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
  if (isAdminEmail(email)) {
    // The admin is not an invited student — and must never receive a
    // sign-in link.
    return Response.json({ error: "is_admin" }, { status: 400 });
  }

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

  // Re-inviting someone previously revoked lifts their suspension.
  const existing = await findAuthUser(service, email);
  if (existing) {
    await service.auth.admin.updateUserById(existing.id, { ban_duration: "none" });
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
    // The admin is not an invited student and never shows in this list.
    .neq("email", ADMIN_EMAIL)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }
  return Response.json({ invites: data ?? [] });
}

/** Revoke a student: off the allowlist (blocks re-signup) and the account
 * suspended (kills existing access — their session dies at the next token
 * refresh, within the hour). Re-inviting lifts the suspension. */
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
    return Response.json({ error: "invite_not_configured" }, { status: 503 });
  }

  const { error: allowlistError } = await service
    .from("allowlist")
    .delete()
    .eq("email", email);
  if (allowlistError) {
    return Response.json({ error: "allowlist_failed" }, { status: 500 });
  }

  const authUser = await findAuthUser(service, email);
  if (authUser) {
    // ~100 years; "none" on re-invite lifts it.
    const { error: banError } = await service.auth.admin.updateUserById(authUser.id, {
      ban_duration: "876000h",
    });
    if (banError) {
      return Response.json({ error: "suspend_failed", unlisted: true }, { status: 502 });
    }
  }

  return Response.json({ ok: true, email });
}
