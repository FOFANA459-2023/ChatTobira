import { createClient as createSupabase } from "@supabase/supabase-js";
import { z } from "zod";

import { ADMIN_EMAIL, isAdminEmail } from "@/lib/admin";
import { normalizeEmail } from "@/lib/email";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

export const maxDuration = 30;

// normalizeEmail first: school addresses arrive with full-width characters
// from Japanese IMEs (＠, ｅｄ, trailing 全角 space) and as Outlook's
// "Name <email>" form. Validating the raw text rejected every one of them,
// which looked like a ban on .ac.jp domains from the admin page.
const BodySchema = z.object({
  email: z.string().transform(normalizeEmail).pipe(z.string().email()),
});

const PatchSchema = BodySchema.extend({
  action: z.enum(["suspend", "restore"]),
});

// Supabase expresses an indefinite ban as a very long duration; "none" lifts it.
const SUSPEND_DURATION = "876000h"; // ~100 years

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

type Service = NonNullable<ReturnType<typeof serviceClient>>;

interface AuthAccount {
  id: string;
  suspended: boolean;
  /** Clicked their link at least once. An account row alone proves nothing:
   * the OTP send itself creates one before any email arrives. */
  confirmed: boolean;
}

/** Every auth account by lowercased email. There is no getUserByEmail in the
 * admin API, so the paged listing is the only lookup available; building the
 * whole map once costs the same as one search and serves the list view too. */
async function authAccounts(service: Service): Promise<Map<string, AuthAccount>> {
  const accounts = new Map<string, AuthAccount>();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) break;
    for (const user of data.users) {
      const email = (user.email ?? "").toLowerCase();
      if (!email) continue;
      // banned_until is a timestamp, and a past one is an expired ban.
      const until = (user as { banned_until?: string | null }).banned_until;
      accounts.set(email, {
        id: user.id,
        suspended: Boolean(until && new Date(until).getTime() > Date.now()),
        confirmed: Boolean(user.email_confirmed_at),
      });
    }
    if (data.users.length < 200) break;
  }
  return accounts;
}

async function findAuthUser(service: Service, email: string): Promise<AuthAccount | null> {
  return (await authAccounts(service)).get(email) ?? null;
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

  // The allowlist row must exist BEFORE the send — the signup trigger
  // rejects user creation for non-allowlisted emails — but an invite is only
  // real once the email goes out, so a failed send rolls this row back below.
  // .select() reports whether the row was newly inserted: a pre-existing
  // invite must never be revoked by a failed RE-send.
  const { data: inserted, error: allowlistError } = await service
    .from("allowlist")
    .upsert(
      { email, note: "invited via admin page", invited_by: ADMIN_EMAIL },
      { onConflict: "email", ignoreDuplicates: true },
    )
    .select("email");
  if (allowlistError) {
    return Response.json({ error: "allowlist_failed" }, { status: 500 });
  }
  const newlyInvited = (inserted ?? []).length > 0;

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
    // The email did not go out, so a brand-new invite is rolled back — the
    // student list must only show people who actually received a link. The
    // OTP call may have created a bare auth account before the send failed;
    // that is removed too, or a later /login attempt would sneak past the
    // allowlist trigger. Re-invites of already-listed students keep
    // everything: their standing invite is not hostage to one failed email.
    if (newlyInvited) {
      if (!existing) {
        const created = await findAuthUser(service, email);
        if (created) await service.auth.admin.deleteUser(created.id);
      }
      await service.from("allowlist").delete().eq("email", email);
    }
    // The provider's own words distinguish a rate limit from broken SMTP —
    // without them the admin is left guessing which knob to turn.
    return Response.json(
      {
        error: "send_failed",
        allowlisted: !newlyInvited,
        reason: otpError.message.slice(0, 200),
      },
      { status: 502 },
    );
  }

  return Response.json({ ok: true, email });
}

/** Invited students, newest first, each marked suspended or active. */
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

  // Suspension lives on the auth account, not the allowlist, so the two have
  // to be joined here for the list to show which button to offer.
  const accounts = await authAccounts(service);
  const invites = (data ?? []).map((row) => {
    const account = accounts.get((row.email as string).toLowerCase());
    return {
      email: row.email as string,
      created_at: row.created_at as string,
      suspended: account?.suspended ?? false,
      // Never signed in: there is no account to suspend yet.
      registered: Boolean(account),
      // The email went out, but the link has never been used — either it is
      // sitting unread, or the university mail gateway swallowed it. This is
      // the flag that tells the admin who to chase.
      accepted: account?.confirmed ?? false,
    };
  });
  return Response.json({ invites });
}

/** Suspend or restore a student.
 *
 * Suspension pauses access but keeps everything: the allowlist row stays, the
 * account stays, and their history stays, so restoring is a single click. The
 * ban is what actually stops them — an existing session dies at its next token
 * refresh, within the hour. */
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
    return Response.json({ error: "invite_not_configured" }, { status: 503 });
  }

  const account = await findAuthUser(service, email);
  if (!account) {
    // Invited but never signed in, so there is no account to pause. Saying so
    // beats reporting a success that changed nothing.
    return Response.json({ error: "never_signed_in" }, { status: 404 });
  }

  const { error } = await service.auth.admin.updateUserById(account.id, {
    ban_duration: action === "suspend" ? SUSPEND_DURATION : "none",
  });
  if (error) {
    return Response.json({ error: `${action}_failed` }, { status: 502 });
  }

  return Response.json({ ok: true, email, suspended: action === "suspend" });
}

/** Remove a student completely: off the allowlist, and the auth account
 * deleted outright. Every table that references auth.users cascades, so their
 * conversations, messages, feedback, and quota rows go with it. Irreversible —
 * suspend is the reversible option. */
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

  // Allowlist first: while the row exists the signup trigger would let them
  // back in, so removing it before the account closes the re-signup window.
  const { error: allowlistError } = await service
    .from("allowlist")
    .delete()
    .eq("email", email);
  if (allowlistError) {
    return Response.json({ error: "allowlist_failed" }, { status: 500 });
  }

  const account = await findAuthUser(service, email);
  if (account) {
    const { error: deleteError } = await service.auth.admin.deleteUser(account.id);
    if (deleteError) {
      // Off the allowlist but still holding a session. Suspend so the removal
      // is at least effective, and report the partial result honestly.
      await service.auth.admin.updateUserById(account.id, {
        ban_duration: SUSPEND_DURATION,
      });
      return Response.json(
        { error: "delete_failed", unlisted: true, suspended: true },
        { status: 502 },
      );
    }
  }

  return Response.json({ ok: true, email });
}
