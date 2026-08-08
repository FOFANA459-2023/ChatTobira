import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

import { isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";

/** Magic-link landing. Handles both shapes Supabase can deliver:
 *  - ?token_hash=...&type=email  — template links straight to the app,
 *    which verifies the OTP itself (the recommended SSR pattern)
 *  - ?code=...                   — template links to Supabase's /verify,
 *    which verifies and then redirects here with a PKCE exchange code
 * Supporting both means the default template, our custom template, and any
 * future template edit all land a session instead of looping to /login. */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");

  const supabase = await createClient();

  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      redirect(await landingPath(supabase));
    }
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      redirect(await landingPath(supabase));
    }
  }

  // Verification failed — expired, already used, or malformed. Land on the
  // login page WITH a reason, so the student knows to request a fresh link
  // instead of staring at a silent form.
  redirect("/login?link=invalid");
}

/** Students land on the chat. The admin account must NEVER get a session
 * from an emailed link — a leaked or intercepted URL would be an admin
 * session — so a link that verifies as the admin is signed straight back
 * out and sent to the password page. */
async function landingPath(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (isAdminEmail(user?.email)) {
      await supabase.auth.signOut();
      return "/admin";
    }
    return "/";
  } catch {
    return "/";
  }
}
