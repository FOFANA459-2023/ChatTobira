import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuizView } from "../quiz";
import type { Quiz } from "@/lib/quiz";

vi.mock("next/navigation", () => ({
  usePathname: () => "/quiz",
}));

const BOOKS = {
  books: [{ id: 1, title: "Foundation 1 & 2" }],
};

const PAPER: Quiz = {
  scope_description: "Particles and polite past-tense forms from Topic 6.",
  sections: [
    {
      instruction_ja: "（　）に入る適切なことばを選んでください。",
      instruction_en: "Choose the word that fits the blank.",
      items: [
        {
          type: "multiple_choice",
          question: "毎日、部屋（　）勉強します。",
          choices: ["で", "に", "を", "へ"],
          answer: "で",
          explanation: "で marks the place where an action happens.",
        },
      ],
    },
    {
      instruction_ja: "＿＿のことばを正しい形にしてください。",
      instruction_en: "Write the correct form of the word.",
      items: [
        {
          type: "fill_blank",
          question: "「食べる」を正しい形にしてください: きのう、すしを＿＿。",
          answer: "食べました",
          explanation: "Past polite form of 食べる.",
        },
      ],
    },
  ],
};

function mockFetch() {
  const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(init?.method === "POST" ? PAPER : BOOKS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QuizView", () => {
  it("runs a full paper: generate, answer, check, score", async () => {
    const fetchMock = mockFetch();
    window.scrollTo = vi.fn();
    render(<QuizView initialKind="grammar" />);

    // Pick the textbook once the list loads, give a focus, start the test.
    const select = await screen.findByLabelText(/Textbook/);
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.change(screen.getByPlaceholderText(/Topic 13/), {
      target: { value: "particles" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Start the Grammar Practice Test/ }));

    // Paper renders with the fixed title, the scope note, and numbered
    // sections with instructions from the model.
    expect(await screen.findByText("Grammar Practice Test")).toBeInTheDocument();
    expect(
      screen.getByText("Particles and polite past-tense forms from Topic 6."),
    ).toBeInTheDocument();
    // 問題I and 問題II — the I-prefix regex matches both headers.
    expect(screen.getAllByText(/問題I/)).toHaveLength(2);
    expect(screen.getByText(/問題II/)).toBeInTheDocument();
    expect(screen.getByText(/適切なことばを選んでください/)).toBeInTheDocument();
    expect(screen.getByText("Choose the word that fits the blank.")).toBeInTheDocument();

    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.kind).toBe("grammar");
    expect(body.focus).toBe("particles");
    expect(body.count).toBe(15);

    // Checking is locked until every question is answered.
    const check = screen.getByRole("button", { name: /Check answers/ });
    expect(check).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /① で/ }));
    fireEvent.change(screen.getByPlaceholderText("こたえ"), {
      target: { value: "食べた" },
    });
    expect(check).toBeEnabled();
    fireEvent.click(check);

    // Score, per-item marking, and the explanation for the miss.
    await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());
    expect(screen.getByText("/ 2")).toBeInTheDocument();
    expect(screen.getByText(/50%/)).toBeInTheDocument();
    expect(screen.getByText("食べました")).toBeInTheDocument();
    expect(screen.getByText(/Past polite form/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retake this test/ })).toBeInTheDocument();
  });

  it("starts in kanji mode when linked with ?kind=kanji", async () => {
    mockFetch();
    render(<QuizView initialKind="kanji" />);
    expect(
      await screen.findByRole("button", { name: /Start the Kanji Practice Test/ }),
    ).toBeInTheDocument();
  });
});
