/** What a signed-in student may use per five-hour window, and how to spend it.
 *
 * The numbers live in the database (supabase/migrations/0011_usage_windows.sql)
 * and are enforced there, atomically; these copies exist only for wording.
 * Change one and change the other.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const CHAT_ALLOWANCE = 20;
export const VOICE_ALLOWANCE_SECONDS = 600;
export const WINDOW_HOURS = 5;
/** Voice is charged a minute at a time, as each minute starts. */
export const VOICE_SLICE_SECONDS = 60;
/** Each minute's token lives this much longer than the minute, and the
 * browser moves to the next token this long before the current one ends —
 * so a charged minute is a full minute of talk, and a browser that refused to
 * move on could keep at most this much extra per minute. */
export const VOICE_HANDOVER_MS = 8_000;

export type AllowanceKind = "chat" | "voice";

export type Spend =
  | { ok: true; remaining: number; resetsAt: string | null }
  | { ok: false; exhausted: true; resetsAt: string | null }
  | { ok: false; exhausted: false };

/** Spend from the caller's allowance. `exhausted` means it did not fit and
 * nothing was spent; any other failure is the database's, not the student's. */
export async function spendAllowance(
  supabase: SupabaseClient,
  kind: AllowanceKind,
  amount: number,
): Promise<Spend> {
  const { data, error } = await supabase.rpc("consume_allowance", {
    p_kind: kind,
    p_amount: amount,
  });
  if (error) return { ok: false, exhausted: false };
  const row = (Array.isArray(data) ? data[0] : data) as
    | { allowed: boolean; remaining: number; resets_at: string | null }
    | undefined;
  if (!row) return { ok: false, exhausted: false };
  return row.allowed
    ? { ok: true, remaining: row.remaining, resetsAt: row.resets_at }
    : { ok: false, exhausted: true, resetsAt: row.resets_at };
}

/** "3:40 PM" in Japan time — where every student using this app is. */
export function resetTime(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null;
  const when = new Date(resetsAt);
  if (Number.isNaN(when.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    minute: "2-digit",
  }).format(when);
}

/** The sentence a student sees when an allowance runs out. */
export function exhaustedMessage(kind: AllowanceKind, resetsAt: string | null | undefined): string {
  const at = resetTime(resetsAt);
  const when = at ? `at ${at} (Japan time)` : `within ${WINDOW_HOURS} hours`;
  return kind === "chat"
    ? `You have used your ${CHAT_ALLOWANCE} questions and practice tests for now. More are available ${when}.`
    : `You have used your ${VOICE_ALLOWANCE_SECONDS / 60} minutes of conversation for now. More are available ${when}.`;
}
