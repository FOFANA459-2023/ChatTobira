// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The roster the admin screen is drawn from.
 *
 * Written after approval shipped broken: admin_students() returned
 * approved_at, the screen read approved_at, and this route in between quietly
 * dropped it, because it copies the columns it wants one by one. Every
 * student therefore showed as "waiting", and approving one appeared to do
 * nothing — the RPC succeeded, the list reloaded, and the row looked the
 * same. The component test did not catch it: it mocks this endpoint, so it
 * was asserting against a payload no server ever sent.
 */

const auth = { getUser: vi.fn() };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth }) }));

const rpc = vi.fn();
const updateUserById = vi.fn();
/** profiles lookup: the route checks the account exists before acting. */
const maybeSingle = vi.fn();
vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    rpc,
    from: () => ({ select: () => ({ ilike: () => ({ maybeSingle }) }) }),
    auth: { admin: { updateUserById } },
  }),
}));

const { GET, PATCH } = await import("@/app/api/admin/students/route");

const SITE = "https://chattobira.com";

function row(over: Record<string, unknown> = {}) {
  return {
    email: "someone@gmail.com",
    full_name: "SOMEONE",
    gender: null,
    gender_self_described: null,
    study_level: null,
    college: null,
    semester: null,
    reasons: null,
    signed_up_at: "2026-10-01T00:00:00Z",
    verified: true,
    onboarded: false,
    approved_at: null,
    suspended: false,
    last_sign_in_at: null,
    last_activity_at: null,
    questions_today: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.getUser.mockResolvedValue({ data: { user: { email: "fvarlee@gmail.com" } } });
  rpc.mockResolvedValue({ data: [], error: null });
  maybeSingle.mockResolvedValue({ data: { id: "account-1" } });
});

describe("the roster the teacher sees", () => {
  it("carries whether each account has been approved", async () => {
    rpc.mockResolvedValue({
      data: [
        row({ email: "waiting@gmail.com" }),
        row({
          email: "letin@apu.ac.jp",
          onboarded: true,
          approved_at: "2026-10-02T09:00:00Z",
        }),
      ],
      error: null,
    });

    const body = (await (await GET()).json()) as {
      students: { email: string; approved_at: string | null }[];
      summary: { waiting: number; active: number; total: number };
    };

    expect(body.students.map((s) => [s.email, s.approved_at])).toEqual([
      ["waiting@gmail.com", null],
      ["letin@apu.ac.jp", "2026-10-02T09:00:00Z"],
    ]);
    expect(body.summary.waiting).toBe(1);
    expect(body.summary.active).toBe(1);
  });

  it("does not count an account as active until it has been approved", async () => {
    // Onboarded and unsuspended used to be enough, which was true when the
    // email domain was the gate and nothing else stood in the way.
    rpc.mockResolvedValue({
      data: [row({ onboarded: true, approved_at: null })],
      error: null,
    });
    const body = (await (await GET()).json()) as { summary: { active: number; waiting: number } };
    expect(body.summary).toMatchObject({ active: 0, waiting: 1 });
  });

  it("is refused to anyone who is not the teacher", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { email: "someone@gmail.com" } } });
    expect((await GET()).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("approving an account", () => {
  const patch = (body: object) =>
    PATCH(new Request(`${SITE}/api/admin/students`, { method: "PATCH", body: JSON.stringify(body) }));

  it("writes both halves through the one function that keeps them together", async () => {
    rpc.mockImplementation((name: string) =>
      name === "set_student_approval"
        ? Promise.resolve({ data: "2026-10-02T09:00:00Z", error: null })
        : Promise.resolve({ data: [], error: null }),
    );

    const response = await patch({ email: "Someone@Gmail.com ", action: "approve" });

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("set_student_approval", {
      p_email: "someone@gmail.com",
      p_approved: true,
    });
    expect(await response.json()).toEqual({
      ok: true,
      email: "someone@gmail.com",
      approvedAt: "2026-10-02T09:00:00Z",
    });
    // Approval is not a ban being lifted; nothing touches the auth account.
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("takes it back the same way, and the timestamp goes with it", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const response = await patch({ email: "someone@gmail.com", action: "unapprove" });
    expect(rpc).toHaveBeenCalledWith("set_student_approval", {
      p_email: "someone@gmail.com",
      p_approved: false,
    });
    expect(await response.json()).toMatchObject({ ok: true, approvedAt: null });
  });

  it("says so plainly when the database has no such function yet", async () => {
    // 0019 not applied. Reported as a failure rather than as a silent success,
    // because the screen would otherwise go on showing the account as waiting
    // with nothing to explain why.
    rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const response = await patch({ email: "someone@gmail.com", action: "approve" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "approve_failed" });
  });

  it("will not let the teacher's own account be un-approved", async () => {
    const response = await patch({ email: "fvarlee@gmail.com", action: "unapprove" });
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
