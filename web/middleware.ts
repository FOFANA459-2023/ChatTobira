import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isAdminEmail } from "@/lib/admin";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/** Session refresh, auth gate, and the welcome gate. Everything except the
 * sign-in pages, the auth callback and the two trial surfaces requires a
 * signed-in student — and a signed-in student who has not yet answered the
 * welcome questions is sent to answer them first. */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const path = request.nextUrl.pathname;
  // /admin is public because it IS the admin's sign-in page; the admin APIs
  // behind it still require an authenticated admin session. The chat and the
  // quiz are public because both offer a trial — 3 questions and 1 practice
  // test — and each route meters anonymous visitors itself with its own
  // cookie. Every other API stays signed-in only.
  const isPublic =
    path === "/" ||
    path === "/api/chat" ||
    path === "/quiz" ||
    path === "/api/quiz" ||
    path === "/api/quiz/feedback" ||
    path.startsWith("/login") ||
    path.startsWith("/signup") ||
    path.startsWith("/auth") ||
    path.startsWith("/admin");

  // The public APIs establish who is asking themselves — each one calls
  // getUser() and meters anonymous callers on its own cookie — so the
  // round trip here would be a second, discarded copy of that answer in
  // front of every message a student sends and every test they generate.
  // Skipped for those routes only: session refresh still happens on page
  // navigations, and on these routes inside the handler's own client.
  if (isPublic && path.startsWith("/api/")) {
    return response;
  }

  // Missing Supabase config must fail CLOSED but render something: everyone
  // is treated as signed out and lands on /login, not on a 500 stack trace.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    if (isPublic) return response;
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "not_signed_in" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Do not add logic between client creation and getUser(): the refresh that
  // getUser() performs is what keeps sessions alive.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic) {
    // API callers need a status code they can branch on, not a redirect to an
    // HTML login page.
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "not_signed_in" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && !isAdminEmail(user.email)) {
    // The welcome questions are required. Read off app_metadata, which only
    // complete_profile() writes and the student cannot, on the user this
    // function already fetched — so the gate costs no extra round trip.
    const onboarded = Boolean(user.app_metadata?.onboarded);
    const exempt =
      path.startsWith("/welcome") ||
      path.startsWith("/reset-password") ||
      path.startsWith("/auth") ||
      path.startsWith("/admin");
    if (!onboarded && !exempt) {
      if (path.startsWith("/api/")) {
        return NextResponse.json({ error: "profile_incomplete" }, { status: 403 });
      }
      return redirectTo(request, "/welcome", response);
    }
    // A signed-in student has no use for the sign-in forms.
    if (path.startsWith("/login") || path.startsWith("/signup")) {
      return redirectTo(request, onboarded ? "/" : "/welcome", response);
    }
  }

  return response;
}

/** Redirect, carrying over any session cookies getUser() just refreshed —
 * dropping them would sign the student out on the very redirect. */
function redirectTo(request: NextRequest, pathname: string, from: NextResponse) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  const redirect = NextResponse.redirect(url);
  for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)"],
};
