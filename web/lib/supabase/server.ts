import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/** Whether this deployment has Supabase credentials at all.
 *
 * createClient() throws on construction without them, and that throw lands
 * BEFORE any try block in a route handler. Middleware already fails closed
 * on missing config, but it deliberately lets the public trial routes
 * through (/api/chat, /api/quiz, /api/quiz/feedback), so those routes are
 * the ones that would answer a bare 500 instead of naming the problem.
 * Caught by the container smoke test, which runs with no secrets at all. */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/** Cookie-bound Supabase client for route handlers and server components.
 * Every query runs as the signed-in student, so RLS applies. */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component: middleware refreshes sessions.
          }
        },
      },
    },
  );
}
