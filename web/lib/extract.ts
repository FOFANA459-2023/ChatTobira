import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

import { isPdf } from "./uploads";

/** Turn an uploaded photo or PDF into Markdown, once, at upload time.
 *
 * Extracting here rather than sending the file with every question is what
 * keeps the rest of the stack unchanged: the result is plain text, so the
 * Groq → DeepSeek → Gemini cascade still answers questions about it, and one
 * vision call covers a whole conversation instead of one per turn. It is
 * also exactly the transcript `ingest uploads` reuses if the admin approves
 * the file, so an approved upload is never transcribed a second time.
 *
 * Deliberately close to the ingest pipeline's transcription prompt: the
 * corpus should not be able to tell whether a page arrived through the
 * Python pipeline or through a student's phone camera.
 */
const PROMPT = `Transcribe this Japanese course material into faithful Markdown.

It is a page (or a photograph of a page) from a university Japanese course:
a handout, worksheet, textbook page, slide, or a student's own notes.

Rules:
- Transcribe ALL Japanese text exactly as printed or written. Never translate
  it, never paraphrase it, never "correct" it. Okurigana, particles and
  punctuation must match the page character for character.
- Render furigana as 漢字《ふりがな》, attached to the word it annotates.
- Reproduce tables as Markdown tables, including empty cells. Conjugation
  tables are the most useful thing on a page like this.
- Keep example sentences verbatim, one per line.
- Keep fill-in-the-blank gaps as ＿＿, and keep any handwritten or printed
  answers exactly where they appear — but if an answer is handwritten, mark
  it as such, e.g. ＿＿[手書き: 食べた]. A student's own working is not the
  same as the material's printed answer, and a reader must be able to tell
  them apart.
- Preserve the page's heading structure with Markdown headings.
- Describe a purely pictorial element in square brackets, e.g. [写真: 家族の絵].
- If the image is too blurred, dark or cropped to read with confidence, say
  so plainly in one line beginning "UNREADABLE:" and transcribe whatever is
  legible. Do not guess at characters you cannot see.
- Never repeat any character more than three times in a row.
- Output the Markdown only. No preamble, no commentary.`;

/** Cap on stored extraction. Well past a dense worksheet, and it bounds both
 * the row and the context block an upload can occupy in a prompt. */
const MAX_EXTRACTED_CHARS = 24_000;

export class ExtractionError extends Error {}

/** Models that can read an image or a PDF, cheapest first. Only Google is in
 * this list because it is the only provider in this stack that reads files
 * at all — the chat cascade's other tiers are text-only, which is precisely
 * why extraction happens here instead of at question time. */
function visionModels(): string[] {
  const preferred = process.env.UPLOAD_VISION_MODEL ?? "gemini-3.5-flash-lite";
  return [preferred, "gemini-3.5-flash"].filter((m, i, all) => all.indexOf(m) === i);
}

export async function extractDocument(
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new ExtractionError("model_keys_not_configured");
  }
  const google = createGoogleGenerativeAI({ apiKey });

  let last: unknown;
  for (const name of visionModels()) {
    try {
      const { text } = await generateText({
        model: google(name),
        // Transcription, not composition: any creativity here is an error.
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              {
                type: "file",
                data: bytes,
                mediaType: isPdf(contentType) ? "application/pdf" : contentType,
              },
            ],
          },
        ],
      });

      const cleaned = text.trim();
      if (!cleaned) {
        throw new ExtractionError("the model returned nothing for this file");
      }
      return cleaned.slice(0, MAX_EXTRACTED_CHARS);
    } catch (error) {
      // A rate limit or a spent daily bucket on one model says nothing about
      // the next; log and drop down. An all-models failure is reported to the
      // student as a failed upload they can retry, never as a silent success.
      console.error(
        `upload extraction failed on ${name}:`,
        error instanceof Error ? error.message : error,
      );
      last = error;
    }
  }

  throw new ExtractionError(
    last instanceof Error ? last.message.slice(0, 200) : "every vision model declined",
  );
}

/** True when the model itself reported it could not read the page. Stored
 * extractions that say this are kept — the student should see that their
 * photo was too blurry rather than wonder why answers ignore it — but they
 * must never be offered to the shared corpus. */
export function isUnreadable(extracted: string): boolean {
  return /^UNREADABLE:/m.test(extracted);
}
