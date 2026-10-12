// @vitest-environment node
//
// Node, not jsdom: NextResponse.next() checks the request's headers against
// the runtime's own Headers class, and jsdom supplies a different one.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The gates a request passes through before it reaches a page.
 *
 * Written after an approval gate and a welcome gate, each correct on its own,
 * sent every waiting student round in a circle: /pending failed the welcome
 * gate and went to /welcome, /welcome failed the approval gate and went back
 * to /pending. The browser gave up with ERR_TOO_MANY_REDIRECTS and a
 * confirmed student could not sign in at all. Nothing tested the middleware,
 * so nothing caught it.
 */

const getUser = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

const { middleware } = await import("@/middleware");

const SITE = "https://chattobira.com";

interface Who {
  email: string;
  approved?: boolean;
  onboarded?: boolean;
}

function signedIn(who: Who | null) {
  getUser.mockResolvedValue({
    data: {
      user: who
        ? {
            email: who.email,
            app_metadata: { approved: who.approved ?? false, onboarded: who.onboarded ?? false },
          }
        : null,
    },
  });
}

/** Where a request to `path` ends up: a pathname when it is redirected, or
 * "(served)" when the middleware lets it through. */
async function go(path: string): Promise<string> {
  const response = await middleware(new NextRequest(`${SITE}${path}`));
  const location = response.headers.get("location");
  if (!location) return response.status === 200 ? "(served)" : `(${response.status})`;
  return new URL(location).pathname;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
});

describe("a student who has confirmed their email but is not approved yet", () => {
  beforeEach(() => signedIn({ email: "someone@gmail.com", approved: false }));

  it("is sent to the waiting page from anywhere in the app", async () => {
    expect(await go("/")).toBe("/pending");
    expect(await go("/translate")).toBe("/pending");
    expect(await go("/quiz?kind=grammar")).toBe("/pending");
  });

  it("STAYS on the waiting page, rather than being bounced to the welcome questions", async () => {
    // The loop, in one line. /pending must be an answer, not another hop.
    expect(await go("/pending")).toBe("(served)");
  });

  it("is not asked the welcome questions at all, having not been let in yet", async () => {
    expect(await go("/welcome")).toBe("/pending");
  });

  it("can still open the link in their confirmation email", async () => {
    expect(await go("/auth/confirm?token_hash=abc&type=email")).toBe("(served)");
  });

  it("is sent to the waiting page from the sign-in forms, being signed in already", async () => {
    expect(await go("/login")).toBe("/pending");
    expect(await go("/signup")).toBe("/pending");
  });

  it("gets a status an API caller can branch on, not a redirect to a page", async () => {
    const response = await middleware(new NextRequest(`${SITE}/api/translate/session`));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_approved" });
  });
});

describe("a student the teacher has approved", () => {
  it("is asked the welcome questions, once, and then let in", async () => {
    signedIn({ email: "someone@gmail.com", approved: true, onboarded: false });
    expect(await go("/")).toBe("/welcome");
    expect(await go("/welcome")).toBe("(served)");

    signedIn({ email: "someone@gmail.com", approved: true, onboarded: true });
    expect(await go("/")).toBe("(served)");
    expect(await go("/translate")).toBe("(served)");
  });

  it("has no use for the waiting page any more", async () => {
    signedIn({ email: "someone@gmail.com", approved: true, onboarded: true });
    expect(await go("/pending")).toBe("/");
  });
});

describe("the teacher", () => {
  it("needs no approval, having nobody to approve them", async () => {
    signedIn({ email: "fvarlee@gmail.com", approved: false, onboarded: false });
    expect(await go("/admin")).toBe("(served)");
    expect(await go("/")).toBe("(served)");
  });
});

describe("a visitor who is not signed in", () => {
  beforeEach(() => signedIn(null));

  it("can reach the sign-in forms and the trial, and nothing else", async () => {
    expect(await go("/login")).toBe("(served)");
    expect(await go("/signup")).toBe("(served)");
    expect(await go("/")).toBe("(served)");
    expect(await go("/translate")).toBe("/login");
  });

  it("is not offered the waiting page, which would say nothing to them", async () => {
    expect(await go("/pending")).toBe("/login");
  });
});
