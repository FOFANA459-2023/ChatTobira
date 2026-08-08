/** Best-effort first name for greeting a signed-in student.
 *
 * Preference order: an explicit first name captured at sign-in, any name-ish
 * metadata an auth provider set, then a guess from the email local part. The
 * guess is conservative — university addresses like gr0123ab@ed.ritsumei.ac.jp
 * are IDs, not names, and greeting someone as "Gr0123ab" is worse than no
 * greeting — so anything that does not look like a plain word is dropped.
 */
export function firstNameFrom(
  metadata: Record<string, unknown> | undefined,
  email: string | null | undefined,
): string | null {
  for (const key of ["first_name", "given_name", "name", "full_name"]) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) {
      return capitalize(value.trim().split(/\s+/)[0]);
    }
  }

  const local = (email ?? "").split("@")[0];
  const token = local.split(/[._\-+]/)[0].replace(/\d+$/, "");
  if (/^[a-zA-Z]{2,20}$/.test(token) && /[aeiouy]/i.test(token)) {
    return capitalize(token);
  }
  return null;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
