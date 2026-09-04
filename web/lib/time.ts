/** Timestamps as an admin reads them.
 *
 * "2026-08-10T03:57:36.314193Z" answers no question anyone actually has. The
 * questions are "is this student using it?" and "has this one ever shown
 * up?", and both are answered by a phrase, not a date.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** A relative phrase, or `never` when there is no timestamp at all.
 *
 * `now` is injectable so the tests do not depend on the clock.
 */
export function relativeTime(
  iso: string | null | undefined,
  { never = "Never", now = Date.now() }: { never?: string; now?: number } = {},
): string {
  if (!iso) return never;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return never;

  const seconds = Math.round((now - at) / 1000);
  // A clock skew of a few seconds between the database and the browser must
  // not render as "in 3 seconds".
  if (seconds < 45) return "just now";
  if (seconds < HOUR) return plural(Math.round(seconds / MINUTE), "minute");
  if (seconds < DAY) return plural(Math.round(seconds / HOUR), "hour");
  if (seconds < WEEK) return plural(Math.round(seconds / DAY), "day");
  if (seconds < MONTH) return plural(Math.round(seconds / WEEK), "week");
  if (seconds < YEAR) return plural(Math.round(seconds / MONTH), "month");
  return plural(Math.round(seconds / YEAR), "year");
}

/** The calendar date, for the columns where "3 weeks ago" is the wrong
 * answer — an invitation date is a fact to look up, not a duration. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Bytes as a person would say them. Mirrors formatBytes in lib/uploads so
 * the review queue and the document list agree. */
export function fileSize(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
