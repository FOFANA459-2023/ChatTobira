import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UploadButton } from "../upload-button";

const uploadToSignedUrl = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    storage: { from: () => ({ uploadToSignedUrl }) },
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  uploadToSignedUrl.mockReset();
});

function open() {
  return render(
    <UploadButton onAttached={vi.fn()} onUpdate={vi.fn()} defaultLevel="F3" />,
  );
}

function pick(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

describe("UploadButton", () => {
  it("opens the device file picker on a single click, like any chat app", () => {
    open();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const picker = vi.spyOn(input, "click");

    fireEvent.click(screen.getByLabelText("Attach a photo or PDF"));

    // No intermediate form: the student asked to attach a file, so the file
    // dialog is what should happen.
    expect(picker).toHaveBeenCalled();
  });

  it("asks the student to classify nothing", () => {
    open();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/Topic/i)).not.toBeInTheDocument();
  });

  it("accepts photos and PDFs only", () => {
    open();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain("application/pdf");
    expect(input.accept).toContain("image/jpeg");
    expect(input.accept).not.toContain("powerpoint");
  });

  it("refuses an Office file with a reason, before any request is made", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    open();
    pick(new File(["x"], "deck.pptx", { type: "application/vnd.ms-powerpoint" }));

    expect(await screen.findByText(/Photos and PDFs only/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an oversized file locally rather than wasting the upload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    open();
    const huge = new File(["x"], "scan.pdf", { type: "application/pdf" });
    Object.defineProperty(huge, "size", { value: 25 * 1024 * 1024 });
    pick(huge);

    expect(await screen.findByText(/the limit is 10 MB/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces the server's quota message instead of a generic failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "upload_quota_exhausted",
          message: "You have reached today's upload limit.",
        }),
        { status: 429 },
      ),
    );
    open();
    pick(new File(["x"], "a.pdf", { type: "application/pdf" }));

    expect(await screen.findByText(/today's upload limit/i)).toBeInTheDocument();
  });

  it("reports the file ready once it is stored and extracted", async () => {
    const onAttached = vi.fn();
    const onUpdate = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      init?.method === "PATCH"
        ? new Response(JSON.stringify({ id: 1, status: "ready" }), { status: 200 })
        : new Response(
            JSON.stringify({ id: 1, bucket: "b", path: "p", token: "t" }),
            { status: 200 },
          ),
    );
    uploadToSignedUrl.mockResolvedValue({ error: null });

    render(<UploadButton onAttached={onAttached} onUpdate={onUpdate} defaultLevel="F3" />);
    fireEvent.click(screen.getByLabelText("Attach a photo or PDF"));
    pick(new File(["x"], "worksheet.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(1, expect.objectContaining({ status: "ready" })),
    );
  });

  it("says a blurry photo was hard to read rather than failing silently", async () => {
    const onUpdate = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      init?.method === "PATCH"
        ? new Response(JSON.stringify({ id: 2, status: "ready", unreadable: true }), {
            status: 200,
          })
        : new Response(
            JSON.stringify({ id: 2, bucket: "b", path: "p", token: "t" }),
            { status: 200 },
          ),
    );
    uploadToSignedUrl.mockResolvedValue({ error: null });

    render(<UploadButton onAttached={vi.fn()} onUpdate={onUpdate} defaultLevel="F3" />);
    fireEvent.click(screen.getByLabelText("Attach a photo or PDF"));
    pick(new File(["x"], "photo.jpg", { type: "image/jpeg" }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ detail: expect.stringMatching(/blurry/i) }),
      ),
    );
  });
});
