import { type EmailOtpType, type User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

import { isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";

/** Where every emailed link lands: signup confirmation and password reset.
 * Handles both shapes Supabase can deliver:
 *  - ?token_hash=...&type=...  — the templates in supabase/email-templates
 *    link straight to the app, which verifies the token itself (the
 *    recommended SSR pattern)
 *  - ?code=...                 — the default templates link to Supabase's
 *    /verify, which verifies and redirects here with a PKCE exchange code
 * Supporting both means a template edit in the dashboard lands a session
 * instead of looping to /login. */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  // Only ever the reset page: an open `next` would make this route a
  // redirector for any URL somebody put in an email.
  const recovery = type === "recovery" || searchParams.get("next") === "/reset-password";

  const supabase = await createClient();

  let verified = false;
  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    verified = !error;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    verified = !error;
  }

  if (!verified) redirect("/login?error=link");
  redirect(await landingPath(supabase, recovery));
}

/** The admin account must NEVER get a session from an emailed link — a leaked
 * or intercepted URL would be an admin session — so a link that verifies as
 * the admin is signed straight back out and sent to the password page. A
 * student goes to the welcome questions until they are answered. */
async function landingPath(
  supabase: Awaited<ReturnType<typeof createClient>>,
  recovery: boolean,
): Promise<string> {
  let user: User | null = null;
  try {
    ({
      data: { user },
    } = await supabase.auth.getUser());
  } catch {
    return "/login?error=link";
  }
  if (!user) return "/login?error=link";
  if (isAdminEmail(user.email)) {
    await supabase.auth.signOut();
    return "/admin";
  }
  if (recovery) return "/reset-password";
  return user.app_metadata?.onboarded ? "/" : "/welcome";
}
