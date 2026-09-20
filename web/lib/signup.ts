/** What signing up asks for, and what counts as a valid answer.
 *
 * The database enforces the same rules (supabase/migrations/0010_open_signup.sql)
 * and is the one that decides — the anon key is public, so anything checked
 * only here can be skipped by calling Supabase directly. These exist so a
 * student is told what is wrong before a round trip, in words, rather than
 * after one as "Database error saving new user".
 */

import { isAdminEmail } from "./admin";
import { normalizeEmail } from "./email";

export const APU_DOMAIN = "apu.ac.jp";

/** Exactly @apu.ac.jp — no subdomains, no lookalikes. Same pattern as the
 * database's is_apu_email(). Takes a normalised address. */
const APU_EMAIL = /^[a-z0-9._%+-]+@apu\.ac\.jp$/;

export function isApuEmail(address: string): boolean {
  return APU_EMAIL.test(address);
}

/** Why this address cannot sign up, or null when it can. The admin's
 * personal address is the only non-APU one the app accepts, and it signs in
 * on /admin rather than signing up. */
export function emailProblem(raw: string): string | null {
  const address = normalizeEmail(raw);
  if (!address) return "Enter your APU email address.";
  if (isAdminEmail(address)) return null;
  if (!isApuEmail(address)) {
    return `Use your APU student email — it ends in @${APU_DOMAIN}.`;
  }
  return null;
}

export const MIN_PASSWORD = 8;

export function passwordProblem(password: string, confirm?: string): string | null {
  if (password.length < MIN_PASSWORD) {
    return `Use at least ${MIN_PASSWORD} characters for your password.`;
  }
  if (confirm !== undefined && password !== confirm) {
    return "The two passwords do not match.";
  }
  return null;
}

/** Collapse runs of whitespace (including the full-width space an IME types)
 * and trim, so "FOFANA　 Varlee " is stored as "FOFANA Varlee". */
export function cleanFullName(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Letters in any script, with the spaces, hyphens, apostrophes and periods
 * names on an ID card actually carry. No digits, no symbols. */
const NAME_SHAPE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;

export function fullNameProblem(raw: string): string | null {
  const name = cleanFullName(raw);
  if (name.length < 2) return "Enter your full name as it appears on your student ID card.";
  if (name.length > 100) return "That name is too long — 100 characters at most.";
  if (!NAME_SHAPE.test(name)) {
    return "Use letters only, as printed on your student ID card.";
  }
  return null;
}

/** Asked at signup, and required. 'other' is answered in the student's own
 * words rather than by a fourth button. */
export const GENDERS = [
  { id: "female", label: "Female" },
  { id: "male", label: "Male" },
  { id: "other", label: "Other" },
] as const;
export type Gender = (typeof GENDERS)[number]["id"];

/** Long enough for any answer someone writes about themselves, short enough
 * that the column is not a free text field. Mirrored by the check constraint
 * on profiles.gender_self_described. */
export const MAX_GENDER_DESCRIPTION = 40;

export const STUDY_LEVELS = [
  { id: "undergraduate", label: "Undergraduate" },
  { id: "graduate", label: "Graduate" },
] as const;
export type StudyLevel = (typeof STUDY_LEVELS)[number]["id"];

/** Same treatment the full name gets: an IME's full-width space is a space. */
export function cleanGenderDescription(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Why this gender answer cannot be stored, or null when it can. The write-in
 * is required by, and only by, the 'other' answer. */
export function genderProblem(gender: string | null, selfDescribed: string): string | null {
  if (!GENDERS.some((g) => g.id === gender)) return "Choose an option.";
  if (gender !== "other") return null;
  const described = cleanGenderDescription(selfDescribed);
  if (described.length < 1) return "Type how you would describe it.";
  if (described.length > MAX_GENDER_DESCRIPTION) {
    return `Keep it to ${MAX_GENDER_DESCRIPTION} characters or fewer.`;
  }
  return null;
}

export function studyLevelProblem(level: string | null): string | null {
  return STUDY_LEVELS.some((l) => l.id === level) ? null : "Choose an option.";
}

// ---------------------------------------------------------------------------
// The welcome questions
// ---------------------------------------------------------------------------

export const COLLEGES = [
  { id: "APS", label: "APS", name: "College of Asia Pacific Studies" },
  { id: "APM", label: "APM", name: "College of International Management" },
  { id: "ST", label: "ST", name: "College of Sustainability and Tourism" },
] as const;
export type College = (typeof COLLEGES)[number]["id"];

/** A student who has finished the degree has no semester number, so the
 * answer is not always one — which is why profiles.semester is text. */
export const GRADUATED = "graduated";

export const SEMESTERS = [
  { id: "1", label: "1st" },
  { id: "2", label: "2nd" },
  { id: "3", label: "3rd" },
  { id: "4", label: "4th" },
  { id: "5", label: "5th" },
  { id: "6", label: "6th" },
  { id: "7", label: "7th" },
  { id: "8", label: "8th" },
  { id: GRADUATED, label: "Graduated" },
] as const;
export type Semester = (typeof SEMESTERS)[number]["id"];

/** How a stored semester reads on the admin roster: "3rd semester", or
 * "Graduated" on its own, since "graduated semester" is not a thing. */
export function semesterLabel(id: string | null | undefined): string | null {
  const found = SEMESTERS.find((s) => s.id === id);
  if (!found) return null;
  return id === GRADUATED ? found.label : `${found.label} semester`;
}

export const REASONS = [
  { id: "japanese_class", label: "Japanese class" },
  { id: "jpt_prep", label: "JPT test prep" },
  { id: "improve_japanese", label: "Improving my Japanese" },
] as const;
export type Reason = (typeof REASONS)[number]["id"];

export interface ProfileAnswers {
  college: string | null;
  semester: string | null;
  reasons: string[];
}

/** One message per unanswered question, keyed by question. Empty when the
 * answers are complete. */
export function profileProblems(answers: ProfileAnswers): Partial<Record<keyof ProfileAnswers, string>> {
  const problems: Partial<Record<keyof ProfileAnswers, string>> = {};
  if (!COLLEGES.some((c) => c.id === answers.college)) {
    problems.college = "Choose your college.";
  }
  if (!SEMESTERS.some((s) => s.id === answers.semester)) {
    problems.semester = "Choose your semester.";
  }
  const valid = answers.reasons.filter((r) => REASONS.some((option) => option.id === r));
  if (valid.length === 0) {
    problems.reasons = "Choose at least one reason.";
  }
  return problems;
}
