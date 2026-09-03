import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Answer } from "@/components/answer";

describe("Answer", () => {
  it("sets furigana as real ruby instead of printing the brackets", () => {
    const { container } = render(<Answer text="語彙（ごい）を勉強します。" />);
    const ruby = container.querySelector("ruby");
    expect(ruby).not.toBeNull();
    expect(ruby?.querySelector("rt")?.textContent).toBe("ごい");
    // The bracket characters themselves must be gone from the text.
    expect(container.textContent).not.toContain("（ごい）");
  });

  it("lays a word list out as a numbered two-column table", () => {
    const { container } = render(
      <Answer text={"- 三角（さんかく）: triangle\n- 四角（しかく）: square"} />,
    );
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("1");
    expect(rows[0].textContent).toContain("triangle");
    expect(rows[1].textContent).toContain("square");
    // No literal bullet markup survives into the page.
    expect(container.textContent).not.toContain("*");
    expect(container.textContent).not.toContain(": triangle");
  });

  it("renders a heading with its English gloss, without the # markers", () => {
    const { container } = render(<Answer text="## 形 (Shape)" />);
    const heading = container.querySelector("h3");
    expect(heading?.textContent).toBe("形Shape");
    expect(container.textContent).not.toContain("#");
  });

  it("renders a Markdown table as a table", () => {
    render(<Answer text={"| 形 | 意味 |\n| --- | --- |\n| 食べる | to eat |"} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "to eat" })).toBeInTheDocument();
  });

  it("marks Japanese as Japanese and leaves the English gloss alone", () => {
    const { container } = render(<Answer text={"- 紙（かみ）: paper\n- 布（ぬの）: cloth"} />);
    const [, term, gloss] = container.querySelectorAll("tbody tr:first-child td");
    expect(term.getAttribute("lang")).toBe("ja");
    expect(gloss.getAttribute("lang")).toBeNull();
  });

  it("renders nothing at all for an answer that has not started streaming", () => {
    const { container } = render(<Answer text="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
