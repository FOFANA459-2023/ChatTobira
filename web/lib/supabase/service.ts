import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Service-role client. Bypasses RLS, so it must only ever be constructed on
 * the server and only after the caller has established who is asking.
 *
 * Two legitimate uses here: the admin allowlist (a table with no policies at
 * all, service-role by design), and reads on behalf of anonymous trial
 * visitors, who have no session for RLS to evaluate but are metered by a
 * cookie before they get this far.
 *
 * Returns null when the deployment has no service key, which is a supported
 * state — the trial then answers ungrounded rather than erroring, and invites
 * report themselves as unconfigured. */
export function serviceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
