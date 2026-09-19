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

/** The name to greet a signed-in student by.
 *
 * Students give their FULL name at signup, as printed on the APU ID card, and
 * nothing says which word of it is the given name — cards print "FOFANA
 * VARLEE" as readily as "Varlee Fofana". Greeting someone by their surname
 * alone is worse than greeting them by both, so the whole name is used,
 * title-cased when it arrived in capitals. An explicit first_name (the admin
 * account sets one) still wins.
 */
export function greetingName(metadata: Record<string, unknown> | undefined): string | null {
  const first = metadata?.["first_name"];
  if (typeof first === "string" && first.trim()) return capitalize(first.trim());
  const full = metadata?.["full_name"];
  if (typeof full !== "string" || !full.trim()) return null;
  const name = full.trim().replace(/\s+/g, " ");
  return name === name.toUpperCase()
    ? name
        .toLowerCase()
        .split(" ")
        .map((part) => part.replace(/(^|[-'’])(\p{L})/gu, (_, sep, letter) => sep + letter.toUpperCase()))
        .join(" ")
    : name;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
