import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/** Session refresh + auth gate. Everything except /login and the auth
 * callback requires a signed-in (allowlisted) student. */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const path = request.nextUrl.pathname;
  // /admin is public because it IS the admin's sign-in page; the invite API
  // behind it still requires an authenticated admin session. The chat and the
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

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)"],
};
