import { strFromU8, strToU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { buildUploadZip, entryBase, safeName, type CollectedUpload } from "../upload-zip";

const upload = (over: Partial<CollectedUpload>): CollectedUpload => ({
  id: 1,
  filename: "worksheet.pdf",
  contentType: "application/pdf",
  sizeBytes: 3,
  level: "F3",
  topic: "T13",
  status: "ready",
  createdAt: "2026-09-21T03:04:05Z",
  extracted: "# 第13課\nことば",
  url: "https://storage.example/1",
  ...over,
});

describe("entry names", () => {
  it("sorts by date, is unique by id, and keeps the student's own name", () => {
    expect(entryBase(upload({ id: 417 }))).toBe("2026-09-21_417_worksheet.pdf");
  });

  it("makes a filename safe to unzip anywhere", () => {
    expect(safeName('T13: "宿題"/p.3?.jpg')).toBe("T13- -宿題--p.3-.jpg");
    expect(safeName("   ")).toBe("file");
  });
});

describe("buildUploadZip", () => {
  it("packs each file, its transcript and a manifest — with no student in it", async () => {
    const { zip, missing } = await buildUploadZip(
      [upload({ id: 1 }), upload({ id: 2, filename: "写真.jpg", contentType: "image/jpeg", extracted: "" })],
      async (url) => strToU8(`bytes of ${url}`),
    );
    expect(missing).toEqual([]);

    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      "README.txt",
      "files/2026-09-21_1_worksheet.pdf",
      "files/2026-09-21_2_写真.jpg",
      "manifest.csv",
      "transcripts/2026-09-21_1_worksheet.pdf.md",
    ]);
    expect(strFromU8(files["files/2026-09-21_1_worksheet.pdf"])).toBe(
      "bytes of https://storage.example/1",
    );
    expect(strFromU8(files["transcripts/2026-09-21_1_worksheet.pdf.md"])).toContain("第13課");

    // A UTF-8 BOM first, so Excel reads the Japanese names correctly.
    expect([...files["manifest.csv"].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const manifest = strFromU8(files["manifest.csv"]).replace(String.fromCharCode(0xfeff), "");
    expect(manifest.split(String.fromCharCode(13, 10))[0]).toBe(
      "id,file,transcript,original_filename,content_type,size_bytes,level,topic,uploaded_at,fetched",
    );
    expect(manifest).toContain("2,files/2026-09-21_2_写真.jpg,,写真.jpg,image/jpeg");
    expect(manifest).not.toMatch(/@|uploader|user_id/);
  });

  it("lists a file it could not fetch instead of failing the download", async () => {
    const { zip, missing } = await buildUploadZip(
      [
        upload({ id: 1, url: "https://storage.example/1" }),
        upload({ id: 2, url: null }),
        upload({ id: 3, url: "https://storage.example/3" }),
      ],
      async (url) => {
        if (url.endsWith("/1")) throw new Error("expired");
        return strToU8("ok");
      },
    );
    expect(missing).toEqual([1, 2]);
    const files = unzipSync(zip);
    expect(files["files/2026-09-21_3_worksheet.pdf"]).toBeDefined();
    expect(files["files/2026-09-21_1_worksheet.pdf"]).toBeUndefined();
    const manifest = strFromU8(files["manifest.csv"]);
    expect(manifest).toMatch(/\r\n1,,transcripts\/2026-09-21_1_worksheet\.pdf\.md,.*,no\r\n/);
  });

  it("quotes manifest cells that would break the CSV", async () => {
    const { zip } = await buildUploadZip(
      [upload({ filename: 'notes, "draft".pdf' })],
      async () => strToU8("x"),
    );
    const manifest = strFromU8(unzipSync(zip)["manifest.csv"]);
    expect(manifest).toContain('"notes, ""draft"".pdf"');
  });
});
