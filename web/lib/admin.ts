/** The one teacher account. It signs in with a password on /admin and is the
 * only account allowed to send student invites. Safe to ship client-side —
 * it gates nothing by itself; the invite API re-checks the session's email
 * server-side. */
export const ADMIN_EMAIL = "fvarlee@gmail.com";

export function isAdminEmail(email: string | null | undefined): boolean {
  return (email ?? "").toLowerCase() === ADMIN_EMAIL;
}
