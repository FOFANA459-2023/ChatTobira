import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StudentsPage from "@/app/admin/students/page";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { email: "fvarlee@gmail.com" } } }),
      signInWithPassword: vi.fn(),
    },
  }),
}));

const NOW = Date.now();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

const STUDENTS = [
  {
    email: "active@ed.ritsumei.ac.jp",
    name: "Rin",
    invited_at: ago(30 * 86400),
    registered: true,
    accepted: true,
    suspended: false,
    last_sign_in_at: ago(3 * 3600),
    last_activity_at: ago(2 * 3600),
    questions_today: 4,
  },
  {
    email: "waiting@ed.ritsumei.ac.jp",
    name: null,
    invited_at: ago(2 * 86400),
    registered: false,
    accepted: false,
    suspended: false,
    last_sign_in_at: null,
    last_activity_at: null,
    questions_today: 0,
  },
  {
    email: "paused@ed.ritsumei.ac.jp",
    name: "Kenji",
    invited_at: ago(60 * 86400),
    registered: true,
    accepted: true,
    suspended: true,
    last_sign_in_at: ago(20 * 86400),
    last_activity_at: ago(20 * 86400),
    questions_today: 0,
  },
];

let respond: () => Promise<Response>;

beforeEach(() => {
  respond = async () =>
    new Response(JSON.stringify({ students: STUDENTS }), {
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (String(url).includes("/api/admin/students")) return respond();
    return Promise.resolve(new Response(JSON.stringify({ queue: [] })));
  }));
});

describe("admin students page", () => {
  it("shows a skeleton while the roster loads, not an empty table", async () => {
    let release: (value: Response) => void = () => {};
    respond = () => new Promise<Response>((resolve) => (release = resolve));

    render(<StudentsPage />);
    // The gate resolves first, then the table's own loading state.
    expect(await screen.findByLabelText("Loading")).toBeInTheDocument();

    release(new Response(JSON.stringify({ students: STUDENTS })));
    await waitFor(() => expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument());
  });

  it("shows each student's name, email and last activity", async () => {
    render(<StudentsPage />);
    const row = (await screen.findByText("Rin")).closest("tr")!;
    expect(within(row).getByText("active@ed.ritsumei.ac.jp")).toBeInTheDocument();
    expect(within(row).getByText("2 hours ago")).toBeInTheDocument();
    // Today's questions sit beside it: activity a month ago and activity this
    // morning are different situations.
    expect(within(row).getByText(/4 today/)).toBeInTheDocument();
  });

  it("says plainly when a student has never signed in", async () => {
    render(<StudentsPage />);
    const row = (await screen.findByText("waiting@ed.ritsumei.ac.jp")).closest("tr")!;
    expect(within(row).getByText("Never logged in")).toBeInTheDocument();
    expect(within(row).getByText("Invited")).toBeInTheDocument();
  });

  it("distinguishes active, waiting and suspended at a glance", async () => {
    render(<StudentsPage />);
    await screen.findByText("Rin");
    // Scoped to the rows: "Invited" is also a column heading, and the badge
    // is the thing under test.
    const badges = document.querySelectorAll("tbody .rounded-full");
    expect([...badges].map((badge) => badge.textContent)).toEqual([
      "Active",
      "Invited",
      "Suspended",
    ]);
  });

  it("offers Suspend only for students who have an account to suspend", async () => {
    render(<StudentsPage />);
    const waiting = (await screen.findByText("waiting@ed.ritsumei.ac.jp")).closest("tr")!;
    expect(within(waiting).queryByRole("button", { name: "Suspend" })).not.toBeInTheDocument();
    // A link can always be resent, account or not.
    expect(within(waiting).getByRole("button", { name: "Resend link" })).toBeInTheDocument();

    const active = screen.getByText("Rin").closest("tr")!;
    expect(within(active).getByRole("button", { name: "Suspend" })).toBeInTheDocument();
  });

  it("offers a retry rather than an empty table when the roster fails to load", async () => {
    respond = async () => new Response("nope", { status: 500 });
    render(<StudentsPage />);
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
