import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsentBanner } from "@/components/consent-banner";

/** The notice must never be standing on the page.
 *
 * It is fixed to the bottom of the window, and every full-height screen in
 * this app centres its content in the viewport — so the notice does not push
 * anything aside, it covers it. On an ordinary laptop window that put the
 * card squarely over the "Confirm my email" button, and a student following
 * the link from their signup email pressed a button that could not be
 * pressed: nothing happened, every time, on the one screen they cannot skip.
 *
 * The fix is a strip the notice reserves for itself, which h-viewport and
 * min-h-viewport subtract. These tests hold that contract.
 */

const BAR_HEIGHT = 240;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.documentElement.style.removeProperty("--consent-inset");
  // jsdom lays nothing out, so every element measures zero and the component
  // would reserve a strip of nothing. A fixed height stands in for a real
  // one; a ResizeObserver it has never heard of has to stand in too.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(BAR_HEIGHT);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Render, then let the two seconds it waits before appearing pass. */
async function showBanner() {
  const view = render(<ConsentBanner />);
  await act(async () => {
    vi.advanceTimersByTime(2500);
  });
  return view;
}

const inset = () => document.documentElement.style.getPropertyValue("--consent-inset");

describe("the privacy notice and the page underneath it", () => {
  it("reserves a strip the height of itself while it is showing", async () => {
    await showBanner();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(inset()).toBe(`${BAR_HEIGHT}px`);
  });

  it("takes nothing while it is not showing", () => {
    render(<ConsentBanner />);
    expect(inset()).toBe("");
  });

  it("gives the strip back the moment it is acknowledged", async () => {
    await showBanner();
    await act(async () => {
      screen.getByRole("button", { name: /I understand/i }).click();
    });
    expect(inset()).toBe("");
  });

  it("gives the strip back if the page leaves while it is up", async () => {
    const { unmount } = await showBanner();
    unmount();
    expect(inset()).toBe("");
  });

  it("lets clicks through the gutter beside the card, and not through the card", async () => {
    await showBanner();
    const wrapper = screen.getByRole("dialog");
    // The wrapper IS the full-width strip either side of the card. It was
    // swallowing clicks on whatever showed through it.
    expect(wrapper.className).toContain("pointer-events-none");
    expect(wrapper.firstElementChild?.className).toContain("pointer-events-auto");
  });

  it("stays quiet once it has been acknowledged in this browser", async () => {
    localStorage.setItem("tobira_consent_v1", new Date().toISOString());
    await showBanner();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(inset()).toBe("");
  });
});
