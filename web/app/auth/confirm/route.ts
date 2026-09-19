import { type EmailOtpType, type User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";

/** The token types an emailed link may carry. Anything else is refused
 * rather than handed to Supabase to interpret. */
const LINK_TYPES = new Set<EmailOtpType>(["email", "signup", "magiclink", "recovery", "email_change"]);

/** Where every emailed link lands: signup confirmation and password reset.
 *
 * Opening the link does NOT spend its token. University mail systems run
 * link scanners — Microsoft's Safe Links and their like — that open every
 * URL in an incoming message before the student sees it. A one-time token
 * spent on a GET is spent by the scanner, and the student who clicks a
 * minute later is told their link has expired. So a GET only shows a page
 * with a button (/auth/verify), and the token is spent by the POST that
 * button sends, which a scanner does not make.
 *
 * Two shapes arrive here:
 *  - ?token_hash=...&type=...  — the templates in supabase/email-templates,
 *    which link straight to the app. Held for the button.
 *  - ?code=...                 — the dashboard's default templates, which
 *    verify at Supabase first and hand back a PKCE code. That code is useless
 *    without the verifier cookie in the student's own browser, so a scanner
 *    cannot spend it; it is exchanged straight away.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const token_hash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const code = url.searchParams.get("code");
  // Only ever the reset page: an open `next` would make this route a
  // redirector for any URL somebody put in an email.
  const recovery = type === "recovery" || url.searchParams.get("next") === "/reset-password";

  if (token_hash && type && LINK_TYPES.has(type)) {
    const verify = new URL("/auth/verify", url);
    verify.searchParams.set("token_hash", token_hash);
    verify.searchParams.set("type", recovery ? "recovery" : type);
    return NextResponse.redirect(verify, 303);
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(await landingPath(supabase, recovery), url), 303);
  }

  return NextResponse.redirect(new URL("/login?error=link", url), 303);
}

/** The button on /auth/verify: spend the token and sign the student in. */
export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const back = (path: string) => NextResponse.redirect(new URL(path, url), 303);

  // Only this site's own page may submit a token. Without the check another
  // site could post a token of ITS choosing from a student's browser and sign
  // them in to an account the attacker controls.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return back("/login?error=link");

  const form = await request.formData().catch(() => null);
  const token_hash = form?.get("token_hash");
  const type = form?.get("type");
  if (
    typeof token_hash !== "string" ||
    typeof type !== "string" ||
    !LINK_TYPES.has(type as EmailOtpType)
  ) {
    return back("/login?error=link");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash });
  if (error) return back("/login?error=link");
  return back(await landingPath(supabase, type === "recovery"));
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
