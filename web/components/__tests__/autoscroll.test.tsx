import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { useAutoScroll } from "@/lib/use-autoscroll";

/** jsdom has no layout, so a scrolling container has to be described to it:
 * scrollHeight and clientHeight are readonly getters on the prototype, and
 * scrollTop is inert. Own properties shadow all three, which gives a box that
 * behaves like a real one for the only question this hook asks — how far the
 * bottom is from the viewport. */
function makeScrollable(element: HTMLElement, { content = 1000, view = 300 } = {}) {
  let top = 0;
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => content });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => view });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  return {
    scrollTo(position: number) {
      top = position;
      fireEvent.scroll(element);
    },
  };
}

function Harness() {
  const scroll = useAutoScroll<HTMLDivElement>();
  const [lines, setLines] = useState(1);
  return (
    <div>
      <div ref={scroll.ref} data-testid="list">
        {Array.from({ length: lines }, (_, i) => (
          <p key={i}>line {i}</p>
        ))}
      </div>
      <span data-testid="pinned">{scroll.pinned ? "following" : "held"}</span>
      <button onClick={() => setLines((n) => n + 1)}>add</button>
      <button onClick={() => scroll.scrollToBottom()}>jump</button>
    </div>
  );
}

const pinned = () => screen.getByTestId("pinned").textContent;

describe("following the newest message", () => {
  it("starts following, and scrolls to the bottom when content arrives", async () => {
    render(<Harness />);
    const list = screen.getByTestId("list");
    makeScrollable(list);
    expect(pinned()).toBe("following");

    fireEvent.click(screen.getByText("add"));
    // 1000 content − 300 viewport: the bottom is scrollTop 700.
    await waitFor(() => expect(list.scrollTop).toBe(1000));
  });

  it("stops following the moment the student scrolls up", () => {
    render(<Harness />);
    const box = makeScrollable(screen.getByTestId("list"));

    box.scrollTo(200); // well above the bottom
    expect(pinned()).toBe("held");
  });

  it("leaves the view exactly where they put it while an answer streams", async () => {
    render(<Harness />);
    const list = screen.getByTestId("list");
    const box = makeScrollable(list);

    box.scrollTo(200);
    fireEvent.click(screen.getByText("add"));
    fireEvent.click(screen.getByText("add"));

    await waitFor(() => expect(screen.getAllByText(/^line/)).toHaveLength(3));
    // The whole point: content grew twice and the student was not moved.
    expect(list.scrollTop).toBe(200);
    expect(pinned()).toBe("held");
  });

  it("picks the following back up when they return to the bottom themselves", () => {
    render(<Harness />);
    const box = makeScrollable(screen.getByTestId("list"));

    box.scrollTo(200);
    expect(pinned()).toBe("held");
    box.scrollTo(700); // 1000 − 300, the bottom
    expect(pinned()).toBe("following");
  });

  it("counts near enough to the bottom as the bottom", () => {
    // Sub-pixel scroll heights and the last message's margin mean scrollTop
    // never quite reaches the arithmetic bottom.
    render(<Harness />);
    const box = makeScrollable(screen.getByTestId("list"));
    box.scrollTo(660); // 40px short
    expect(pinned()).toBe("following");
  });

  it("resumes on demand, for the jump-to-latest button", async () => {
    render(<Harness />);
    const list = screen.getByTestId("list");
    const box = makeScrollable(list);

    box.scrollTo(100);
    expect(pinned()).toBe("held");

    fireEvent.click(screen.getByText("jump"));
    await waitFor(() => expect(pinned()).toBe("following"));
    expect(list.scrollTop).toBe(1000);
  });
});
