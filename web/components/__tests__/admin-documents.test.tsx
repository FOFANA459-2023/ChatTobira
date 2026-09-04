import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DocumentsPage from "@/app/admin/documents/page";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { email: "fvarlee@gmail.com" } } }),
      signInWithPassword: vi.fn(),
    },
  }),
}));

// Shaped like the live corpus: four textbooks plus a handout, with the chunk
// and embedding counts admin_documents() actually returns.
const DOCUMENTS = [
  {
    id: 1,
    title: "Foundation 3 Textbook",
    path: "Foundation 3/Foundation 3 Textbook.pdf",
    level: "F3",
    topics: [],
    doc_type: "textbook",
    is_citable: true,
    page_count: 290,
    ingested_at: "2026-08-10T03:00:00Z",
    chunk_count: 481,
    embedded_count: 481,
    paged_count: 472,
    status: "indexed" as const,
  },
  {
    id: 2,
    title: "25SP Foundation Japanese BF",
    path: "Foundation 2/T7 Materials used in class/25SP.pdf",
    level: "F2",
    topics: ["T7"],
    doc_type: "grammar",
    is_citable: false,
    page_count: 3,
    ingested_at: "2026-08-11T03:00:00Z",
    chunk_count: 2,
    embedded_count: 0,
    paged_count: 0,
    status: "partial" as const,
  },
];

const QUEUE = [
  {
    id: 9,
    filename: "worksheet.jpg",
    level: "F3",
    topic: "T14",
    status: "submitted",
    size_bytes: 2_400_000,
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    uploader: "rin@ed.ritsumei.ac.jp",
    preview: "トピック 14 新しい語彙",
    destination: "Foundation 3/T14 Student uploads/worksheet.jpg",
  },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(url).includes("/api/admin/documents")
              ? { documents: DOCUMENTS }
              : { queue: QUEUE },
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    ),
  );
});

describe("admin documents page", () => {
  it("loads with skeletons rather than an empty page", async () => {
    // Held open on purpose: with an instant mock the loading state is real
    // but lasts a microtask, and the point of it is the slow case.
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).includes("/api/admin/documents")
          ? new Promise<Response>((resolve) => (release = resolve))
          : Promise.resolve(new Response(JSON.stringify({ queue: [] }))),
      ),
    );

    render(<DocumentsPage />);
    await waitFor(() => expect(screen.getAllByLabelText("Loading").length).toBeGreaterThan(0));

    release(new Response(JSON.stringify({ documents: DOCUMENTS })));
    await waitFor(() => expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument());
    expect(screen.getByText("Foundation 3 Textbook")).toBeInTheDocument();
  });

  it("shows each document's metadata", async () => {
    render(<DocumentsPage />);
    const row = (await screen.findByText("Foundation 3 Textbook")).closest("tr")!;
    expect(within(row).getByText("textbook")).toBeInTheDocument();
    expect(within(row).getByText("citable")).toBeInTheDocument();
    expect(within(row).getByText("290")).toBeInTheDocument();
    expect(within(row).getByText("481")).toBeInTheDocument();
    expect(within(row).getByText("10 Aug 2026")).toBeInTheDocument();
  });

  it("flags a document the RAG system cannot actually search", async () => {
    render(<DocumentsPage />);
    const row = (await screen.findByText("25SP Foundation Japanese BF")).closest("tr")!;
    // Chunks exist but nothing is embedded: in the corpus, invisible to search.
    expect(within(row).getByText("0/2 embedded")).toBeInTheDocument();
  });

  it("keeps the upload review queue and its approve/reject controls", async () => {
    render(<DocumentsPage />);
    expect(await screen.findByText("worksheet.jpg")).toBeInTheDocument();
    expect(screen.getByText(/rin@ed.ritsumei.ac.jp/)).toBeInTheDocument();
    expect(screen.getByText(/2.3 MB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    // Where it lands is shown before the decision, not discovered after it.
    expect(screen.getByText(/T14 Student uploads/)).toBeInTheDocument();
  });

  it("pre-fills the student's own filing so the admin only corrects it", async () => {
    render(<DocumentsPage />);
    await screen.findByText("worksheet.jpg");
    expect(screen.getByLabelText("Level")).toHaveValue("F3");
    expect(screen.getByLabelText("Topic")).toHaveValue("T14");
  });
});
