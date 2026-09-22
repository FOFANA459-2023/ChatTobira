import { strToU8, zipSync, type Zippable } from "fflate";

/** One student upload, as the admin listing hands it over. */
export interface CollectedUpload {
  id: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  level: string | null;
  topic: string | null;
  status: string;
  createdAt: string;
  extracted: string;
  url: string | null;
}

/** A name that is safe as a zip entry on every OS the admin might unzip on. */
export function safeName(filename: string): string {
  const cleaned = filename
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, "-")
    // Control characters, by code rather than as an escape in the pattern.
    .replace(/./gu, (ch) => (ch.charCodeAt(0) < 32 ? "-" : ch))
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(-120) || "file";
}

/** `2026-09-22_417_worksheet.pdf`: sortable by date, unique by id, and still
 * recognisable by the name the student gave it. */
export function entryBase(upload: Pick<CollectedUpload, "id" | "filename" | "createdAt">): string {
  const day = upload.createdAt.slice(0, 10);
  return `${day}_${upload.id}_${safeName(upload.filename)}`;
}

const BOM = String.fromCharCode(0xfeff);
const CRLF = String.fromCharCode(13, 10);

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const README = `Student uploads from ChatTobira

files/        each file exactly as the student uploaded it
transcripts/  the text read out of it when it was uploaded, as Markdown,
              so a clean file does not need transcribing again
manifest.csv  one row per upload: where it is in this zip and what is known
              about it (course level and topic when set)

No student names or email addresses are in this zip. It is raw material:
check each file, drop what is wrong or not course material, then add what is
worth keeping under MATERIALS_ROOT and run the ingest pipeline.
`;

/** Build the zip in the browser: fetch each file, add its transcript, write
 * a manifest. A file that cannot be fetched is listed in `missing` and in the
 * manifest rather than failing the whole download.
 *
 * Images and PDFs are stored, not compressed — they already are, and
 * deflating them again costs time for no bytes. */
export async function buildUploadZip(
  uploads: CollectedUpload[],
  fetchBytes: (url: string) => Promise<Uint8Array>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ zip: Uint8Array; missing: number[] }> {
  const entries: Zippable = { "README.txt": strToU8(README) };
  const rows: string[] = [
    [
      "id",
      "file",
      "transcript",
      "original_filename",
      "content_type",
      "size_bytes",
      "level",
      "topic",
      "uploaded_at",
      "fetched",
    ].join(","),
  ];
  const missing: number[] = [];

  let done = 0;
  for (const upload of uploads) {
    const base = entryBase(upload);
    const file = `files/${base}`;
    const transcript = upload.extracted.trim() ? `transcripts/${base}.md` : "";

    let fetched = false;
    if (upload.url) {
      try {
        entries[file] = [await fetchBytes(upload.url), { level: 0 }];
        fetched = true;
      } catch {
        fetched = false;
      }
    }
    if (!fetched) missing.push(upload.id);
    if (transcript) entries[transcript] = strToU8(upload.extracted);

    rows.push(
      [
        upload.id,
        fetched ? file : "",
        transcript,
        upload.filename,
        upload.contentType,
        upload.sizeBytes,
        upload.level,
        upload.topic,
        upload.createdAt,
        fetched ? "yes" : "no",
      ]
        .map(csvCell)
        .join(","),
    );
    onProgress?.(++done, uploads.length);
  }

  // A BOM so Excel opens the Japanese filenames as UTF-8, not mojibake.
  entries["manifest.csv"] = strToU8(`${BOM}${rows.join(CRLF)}${CRLF}`);
  return { zip: zipSync(entries, { level: 6 }), missing };
}
