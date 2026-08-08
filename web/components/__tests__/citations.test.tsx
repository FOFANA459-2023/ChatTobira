import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Citations } from "../citations";

describe("Citations", () => {
  it("renders nothing when there are no citations", () => {
    const { container } = render(<Citations citations={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows textbook title, printed page, and quote", () => {
    render(
      <Citations
        citations={[
          {
            document_id: 1,
            title: "Tobira Intermediate Japanese",
            book_page: "112",
            quote: "〜ておく：前もって何かをする。",
          },
        ]}
      />,
    );
    expect(screen.getByText("Tobira Intermediate Japanese")).toBeInTheDocument();
    expect(screen.getByText(/p\. 112/)).toBeInTheDocument();
    expect(screen.getByText(/前もって何かをする/)).toBeInTheDocument();
  });

  it("lists a book once when several pages of it are cited", () => {
    render(
      <Citations
        citations={[
          {
            document_id: 1,
            title: "Tobira Intermediate Japanese",
            book_page: "112",
            quote: "〜ておく：前もって何かをする。",
          },
          {
            document_id: 1,
            title: "Tobira Intermediate Japanese",
            book_page: "145",
            quote: "〜てみる：ためしに何かをする。",
          },
        ]}
      />,
    );
    expect(screen.getAllByText("Tobira Intermediate Japanese")).toHaveLength(1);
    expect(screen.getByText(/pp\. 112, 145/)).toBeInTheDocument();
    expect(screen.getByText(/前もって何かをする/)).toBeInTheDocument();
    expect(screen.getByText(/ためしに何かをする/)).toBeInTheDocument();
  });

  it("handles a missing printed page without rendering a dangling label", () => {
    render(
      <Citations
        citations={[
          { document_id: 2, title: "Foundation 1 & 2", book_page: null, quote: "" },
        ]}
      />,
    );
    expect(screen.getByText("Foundation 1 & 2")).toBeInTheDocument();
    expect(screen.queryByText(/p\./)).not.toBeInTheDocument();
  });
});
