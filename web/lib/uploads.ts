/** Student uploads: what the app accepts, and where an approved one lands.
 *
 * Two tiers, and the difference matters everywhere this module is used:
 * an upload is PRIVATE context for its uploader from the moment it is
 * extracted, and it becomes shared corpus only after the admin approves it.
 * Nothing here promotes anything on its own.
 */

/** Private bucket holding the raw files. Declared here rather than in the
 * route because a Next.js route module may export ONLY its handlers and a
 * fixed allowlist (maxDuration, runtime, …) — any other export fails the
 * production build, though tsc and the unit tests pass happily. */
export const UPLOAD_BUCKET = "chattobira-uploads";

export const UPLOAD_STATUSES = [
  "pending",
  "ready",
  "failed",
  "submitted",
  "approved",
  "ingested",
  "rejected",
] as const;

export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export interface Upload {
  id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  level: CourseLevel | null;
  topic: string | null;
  status: UploadStatus;
  error: string | null;
  created_at: string;
}

export type CourseLevel = "F2" | "F3" | "INT";

export const COURSE_LEVELS: { value: CourseLevel; label: string }[] = [
  { value: "F2", label: "Foundation 1 & 2" },
  { value: "F3", label: "Foundation 3" },
  { value: "INT", label: "Intermediate" },
];

/** Topics offered per level, matching how the courses are actually taught:
 * the Foundation 1 & 2 book runs Topics 1–10, Foundation 3 picks up at 11,
 * and the Intermediate volumes are divided into Lessons rather than Topics. */
export const TOPICS_BY_LEVEL: Record<CourseLevel, string[]> = {
  F2: Array.from({ length: 10 }, (_, i) => `T${i + 1}`),
  // 11–20, read off the ingested book: it carries Topics 11 through 20, even
  // though the course's own handouts stop at T17. The range follows the
  // textbook, because that is what a student is holding when they photograph
  // a page out of it.
  F3: Array.from({ length: 10 }, (_, i) => `T${i + 11}`),
  INT: Array.from({ length: 15 }, (_, i) => `T${i + 1}`),
};

/** What the picker offers and the API enforces.
 *
 * Photos and PDFs only for now: the vision model reads both natively, so an
 * upload is answerable in the same chat turn it arrives in. Office formats
 * need LibreOffice to become pages at all, which cannot run in a Worker —
 * they need the out-of-band pipeline, so they are deliberately absent rather
 * than accepted and silently unanswerable.
 */
export const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

export const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(",");

/** 10 MB. A phone photo of a worksheet is ~3 MB and a scanned handout ~5 MB,
 * so this clears the real cases with room to spare while keeping the bytes
 * the Worker has to base64-encode for the vision call bounded. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function isAcceptedType(contentType: string): boolean {
  return (ACCEPTED_TYPES as readonly string[]).includes(contentType);
}

export function isPdf(contentType: string): boolean {
  return contentType === "application/pdf";
}

/** Human-readable size for the picker and the review queue. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strip anything that would make a storage key or a filesystem path
 * awkward, while keeping the name recognisable to the student who uploaded
 * it. Japanese filenames are common here and Storage rejects some of the
 * characters they contain outright — backup.py hit exactly that with a
 * combining dakuten — so the object key is built from the upload id and this
 * is only ever the display/corpus name. */
export function safeFilename(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  // A name carrying no letter, digit or kana/kanji is not a name — and the
  // dangerous cases live exactly there. ".." survives separator-stripping
  // intact and would still mean "the parent directory" when this is joined
  // into a corpus path, so anything that reduces to punctuation is replaced
  // outright rather than sanitised further.
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "upload";
}

/** Object key in the private bucket. Keyed by user then id: the prefix makes
 * "everything this student uploaded" a single listing, and the id keeps it
 * unique without depending on the filename being ASCII. */
export function storageKey(userId: string, uploadId: number, contentType: string): string {
  const extension = isPdf(contentType) ? "pdf" : (contentType.split("/")[1] ?? "bin");
  return `${userId}/${uploadId}.${extension}`;
}

const LEVEL_FOLDER: Record<CourseLevel, string> = {
  F2: "Foundation 2",
  F3: "Foundation 3",
  INT: "Intermediate",
};

/** Where an approved upload is filed in the materials tree.
 *
 * The folder name carries the topic marker because that is how discover.py
 * derives topic and level — from the path, not from a database column. A
 * file at "Foundation 3/T13 Student uploads/foo.pdf" reads back as level F3,
 * topic T13 with no extra wiring, and the "Student uploads" segment keeps
 * contributed material visibly separate from the class's own handouts.
 */
export function corpusPath(
  level: CourseLevel,
  topic: string | null,
  filename: string,
): string {
  const folder = topic ? `${topic} Student uploads` : "Student uploads";
  return `${LEVEL_FOLDER[level]}/${folder}/${safeFilename(filename)}`;
}
