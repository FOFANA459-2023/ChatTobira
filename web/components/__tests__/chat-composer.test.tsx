import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Chat } from "../chat";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: vi.fn(), getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    storage: { from: () => ({ uploadToSignedUrl: vi.fn() }) },
  }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    status: "ready",
    error: undefined,
  }),
}));

/** The composer's controls, which is what a student actually looks for.
 *
 * These exist because the attach button was reported missing: it renders
 * only for a signed-in student, so a signed-out session shows the input and
 * Send alone and looks broken to anyone expecting otherwise.
 */
describe("chat composer", () => {
  it("offers the attach button to a signed-in student", () => {
    render(<Chat authenticated firstName="Rin" />);
    expect(screen.getByLabelText("Attach a photo or PDF")).toBeInTheDocument();
  });

  it("puts it beside Send, where a chat app keeps it", () => {
    render(<Chat authenticated firstName="Rin" />);
    const attach = screen.getByLabelText("Attach a photo or PDF");
    const send = screen.getByRole("button", { name: "Send" });
    // Same row: an attach control docked anywhere else is not findable.
    expect(attach.closest("div")).toBe(send.closest("div"));
  });

  it("hides it from signed-out visitors, who have no account to store against", () => {
    render(<Chat authenticated={false} />);
    expect(screen.queryByLabelText("Attach a photo or PDF")).not.toBeInTheDocument();
    // The trial still works, so the composer itself must remain usable.
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("keeps the composer laid out as one row, in reading order", () => {
    render(<Chat authenticated firstName="Rin" />);
    const row = screen.getByRole("button", { name: "Send" }).parentElement!;
    expect(row.className).toContain("flex");

    // The hidden file input is a sibling too, so look at what a student can
    // actually see: question box, attach, mic, send.
    const visible = [...row.querySelectorAll("input, button")].filter(
      (el) => el.getAttribute("type") !== "file",
    );
    expect(
      visible.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? el.tagName),
    ).toEqual([
      "",
      "Attach a photo or PDF",
      "Record a spoken question",
      "Send",
    ]);
  });
});
