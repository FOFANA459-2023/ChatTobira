import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = {
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth }) }));

const { GET, POST } = await import("@/app/auth/confirm/route");

const SITE = "https://chattobira.com";

function post(body: Record<string, string>, origin: string | null = SITE) {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) form.set(key, value);
  return new NextRequest(`${SITE}/auth/confirm`, {
    method: "POST",
    body: form,
    headers: origin ? { origin } : {},
  });
}

const where = (response: Response) => {
  const url = new URL(response.headers.get("location")!);
  return url.pathname + url.search;
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.verifyOtp.mockResolvedValue({ error: null });
  auth.getUser.mockResolvedValue({ data: { user: { email: "fo25v2eg@apu.ac.jp", app_metadata: {} } } });
});

describe("opening an emailed link", () => {
  it("does not spend the token — a mail scanner opening it changes nothing", async () => {
    const response = await GET(
      new NextRequest(`${SITE}/auth/confirm?token_hash=pkce_abc&type=email`),
    );
    expect(response.status).toBe(303);
    expect(where(response)).toBe("/auth/verify?token_hash=pkce_abc&type=email");
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("carries a password reset to the reset page's button", async () => {
    const response = await GET(
      new NextRequest(`${SITE}/auth/confirm?token_hash=t&type=email&next=/reset-password`),
    );
    expect(where(response)).toBe("/auth/verify?token_hash=t&type=recovery");
  });

  it("holds sign-in and email-change links for the button too", async () => {
    for (const type of ["magiclink", "email_change"]) {
      const response = await GET(new NextRequest(`${SITE}/auth/confirm?token_hash=t&type=${type}`));
      expect(where(response)).toBe(`/auth/verify?token_hash=t&type=${type}`);
    }
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("refuses a link type it does not expect", async () => {
    const response = await GET(new NextRequest(`${SITE}/auth/confirm?token_hash=t&type=invite`));
    expect(where(response)).toBe("/login?error=link");
  });

  it("still exchanges a PKCE code at once — it is useless without the student's own cookie", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ error: null });
    const response = await GET(new NextRequest(`${SITE}/auth/confirm?code=xyz`));
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("xyz");
    expect(where(response)).toBe("/welcome");
  });
});

describe("pressing Confirm", () => {
  it("spends the token and sends a new student to the welcome questions", async () => {
    const response = await POST(post({ token_hash: "pkce_abc", type: "email" }));
    expect(auth.verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "pkce_abc" });
    expect(response.status).toBe(303);
    expect(where(response)).toBe("/welcome");
  });

  it("sends an onboarded student straight to the chat", async () => {
    auth.getUser.mockResolvedValue({
      data: { user: { email: "fo25v2eg@apu.ac.jp", app_metadata: { onboarded: true } } },
    });
    expect(where(await POST(post({ token_hash: "t", type: "email" })))).toBe("/");
  });

  it("sends a password reset to the new-password page", async () => {
    expect(where(await POST(post({ token_hash: "t", type: "recovery" })))).toBe("/reset-password");
  });

  it("refuses a token posted from another site", async () => {
    const response = await POST(post({ token_hash: "t", type: "email" }, "https://evil.example"));
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(where(response)).toBe("/login?error=link");
  });

  it("says the link expired when Supabase refuses the token", async () => {
    auth.verifyOtp.mockResolvedValue({ error: { message: "expired" } });
    expect(where(await POST(post({ token_hash: "t", type: "email" })))).toBe("/login?error=link");
  });

  it("never gives the admin a session from an emailed link", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { email: "fvarlee@gmail.com", app_metadata: {} } } });
    expect(where(await POST(post({ token_hash: "t", type: "email" })))).toBe("/admin");
    expect(auth.signOut).toHaveBeenCalled();
  });
});
