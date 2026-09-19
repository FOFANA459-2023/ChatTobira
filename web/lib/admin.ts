/** The one teacher account. It signs in with a password on /admin, and it is
 * the only address outside @apu.ac.jp the app accepts. Safe to ship
 * client-side — it gates nothing by itself; the admin APIs re-check the
 * session's email server-side. Duplicated in supabase/migrations/0009 and
 * 0010 — change them together. */
export const ADMIN_EMAIL = "fvarlee@gmail.com";

export function isAdminEmail(email: string | null | undefined): boolean {
  return (email ?? "").toLowerCase() === ADMIN_EMAIL;
}
