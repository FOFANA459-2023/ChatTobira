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
    email: "rin21ab@apu.ac.jp",
    name: "Rin Tanaka",
    gender: "female",
    gender_self_described: null,
    study_level: "undergraduate",
    college: "APM",
    semester: "3",
    reasons: ["japanese_class", "jpt_prep"],
    signed_up_at: ago(30 * 86400),
    verified: true,
    onboarded: true,
    suspended: false,
    last_sign_in_at: ago(3 * 3600),
    last_activity_at: ago(2 * 3600),
    questions_today: 4,
  },
  {
    email: "waiting@apu.ac.jp",
    name: "Aiko Sato",
    college: null,
    semester: null,
    reasons: [],
    signed_up_at: ago(2 * 86400),
    verified: false,
    onboarded: false,
    suspended: false,
    last_sign_in_at: null,
    last_activity_at: null,
    questions_today: 0,
  },
  {
    email: "halfway@apu.ac.jp",
    name: "Budi Santoso",
    college: null,
    semester: null,
    reasons: [],
    signed_up_at: ago(1 * 86400),
    verified: true,
    onboarded: false,
    suspended: false,
    last_sign_in_at: ago(86400),
    last_activity_at: ago(86400),
    questions_today: 0,
  },
  {
    email: "paused@apu.ac.jp",
    name: "Kenji Mori",
    gender: "other",
    gender_self_described: "non-binary",
    study_level: "graduate",
    college: "ST",
    semester: "graduated",
    reasons: ["improve_japanese"],
    signed_up_at: ago(60 * 86400),
    verified: true,
    onboarded: true,
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
    const row = (await screen.findByText("Rin Tanaka")).closest("tr")!;
    expect(within(row).getByText("rin21ab@apu.ac.jp")).toBeInTheDocument();
    expect(within(row).getByText("2 hours ago")).toBeInTheDocument();
    // Today's questions sit beside it: activity a month ago and activity this
    // morning are different situations.
    expect(within(row).getByText(/4 today/)).toBeInTheDocument();
  });

  it("shows the welcome answers: college, semester and reasons", async () => {
    render(<StudentsPage />);
    const row = (await screen.findByText("Rin Tanaka")).closest("tr")!;
    expect(within(row).getByText(/APM/)).toBeInTheDocument();
    expect(within(row).getByText(/3rd semester/)).toBeInTheDocument();
    expect(within(row).getByText("Japanese class, JPT test prep")).toBeInTheDocument();
  });

  it("shows who the student said they are, and a finished degree as Graduated", async () => {
    render(<StudentsPage />);
    const rin = (await screen.findByText("Rin Tanaka")).closest("tr")!;
    expect(within(rin).getByText("Female · Undergraduate")).toBeInTheDocument();

    // An 'other' answer reads as what the student wrote, not as "Other".
    const kenji = screen.getByText("Kenji Mori").closest("tr")!;
    expect(within(kenji).getByText("non-binary · Graduate")).toBeInTheDocument();
    expect(within(kenji).getByText(/Graduated/)).toBeInTheDocument();
    expect(within(kenji).queryByText(/graduated semester/)).not.toBeInTheDocument();
  });

  it("says plainly when a student has never signed in", async () => {
    render(<StudentsPage />);
    const row = (await screen.findByText("waiting@apu.ac.jp")).closest("tr")!;
    expect(within(row).getByText("Never logged in")).toBeInTheDocument();
    expect(within(row).getByText("Email not verified")).toBeInTheDocument();
  });

  it("distinguishes each step of signing up, and suspension, at a glance", async () => {
    render(<StudentsPage />);
    await screen.findByText("Rin Tanaka");
    const badges = document.querySelectorAll("tbody .rounded-full");
    expect([...badges].map((badge) => badge.textContent)).toEqual([
      "Active",
      "Email not verified",
      "Profile pending",
      "Suspended",
    ]);
  });

  it("filters to the students who have not finished signing up", async () => {
    render(<StudentsPage />);
    await screen.findByText("Rin Tanaka");
    screen.getByRole("button", { name: "Not finished signing up" }).click();
    await waitFor(() => expect(screen.queryByText("Rin Tanaka")).not.toBeInTheDocument());
    expect(screen.getByText("Aiko Sato")).toBeInTheDocument();
    expect(screen.getByText("Budi Santoso")).toBeInTheDocument();
  });

  it("offers Suspend and Remove, and no invite links", async () => {
    render(<StudentsPage />);
    const active = (await screen.findByText("Rin Tanaka")).closest("tr")!;
    expect(within(active).getByRole("button", { name: "Suspend" })).toBeInTheDocument();
    expect(within(active).getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resend/i })).not.toBeInTheDocument();
    const paused = screen.getByText("Kenji Mori").closest("tr")!;
    expect(within(paused).getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("offers a retry rather than an empty table when the roster fails to load", async () => {
    respond = async () => new Response("nope", { status: 500 });
    render(<StudentsPage />);
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
