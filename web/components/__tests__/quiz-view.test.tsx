import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
          review: "Topic 3 — location particles (p. 33)",
        },
      ],
    },
    {
      instruction_ja: "＿＿のことばを正しい形にしてください。",
      instruction_en: "Write the correct form of the word.",
      items: [
        {
          type: "fill_blank",
          question: "正しい形にしてください。",
          sentence: "きのう、すしを【食べる】。",
          answer: "食べました",
          answer_kana: "たべました",
          explanation: "Past polite form of 食べる.",
          review: "Topic 6 — polite past tense (p. 76)",
        },
      ],
    },
    {
      instruction_ja: "つぎの文章を読んで、内容と合っていれば○、違っていれば×を選んでください。",
      instruction_en: "Read the passage and mark each statement ○ or ×.",
      passage:
        "わたしは まいあさ 七時に おきます。あさごはんを 食べてから、大学（だいがく）へ 行きます。",
      items: [
        {
          type: "true_false",
          question: "この人は あさごはんを 食べません。",
          answer: "×",
          explanation: "The passage says breakfast comes before leaving.",
          review: "Topic 4 — daily routines (p. 45)",
        },
      ],
    },
  ],
};

const FEEDBACK = {
  feedback:
    "Solid grasp of location particles. Your miss was the polite past tense — review Topic 6 (p. 76) and drill ました forms.",
};

function mockFetch() {
  const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    const body = target.endsWith("/api/quiz/feedback")
      ? FEEDBACK
      : init?.method === "POST"
        ? PAPER
        : BOOKS;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
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
    // 問題I, 問題II, 問題III — the I-prefix regex matches all three headers.
    expect(screen.getAllByText(/問題I/)).toHaveLength(3);
    expect(screen.getByText(/問題II\b/)).toBeInTheDocument();
    expect(screen.getByText(/適切なことばを選んでください/)).toBeInTheDocument();
    expect(screen.getByText("Choose the word that fits the blank.")).toBeInTheDocument();

    // The reading section renders its passage above the ○× statements, and
    // the beyond-scope word's furigana renders as ruby ON TOP of the kanji —
    // the annotation parens never reach the page.
    expect(screen.getByText(/あさごはんを 食べてから、/)).toBeInTheDocument();
    const ruby = document.querySelector("ruby");
    expect(ruby).toHaveTextContent("大学");
    expect(ruby?.querySelector("rt")).toHaveTextContent("だいがく");
    expect(screen.queryByText(/（だいがく）/)).not.toBeInTheDocument();

    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.kind).toBe("grammar");
    expect(body.focus).toBe("particles");
    expect(body.count).toBe(15);

    // Checking is locked until every question is answered.
    const check = screen.getByRole("button", { name: /Check answers/ });
    expect(check).toBeDisabled();

    // The 【 】-marked target word renders as a real underline, brackets gone.
    const underlined = document.querySelector("u");
    expect(underlined).toHaveTextContent("食べる");
    expect(screen.queryByText(/【/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /① で/ }));
    fireEvent.change(screen.getByPlaceholderText("こたえ"), {
      target: { value: "食べた" },
    });
    // Still one unanswered: the ○× statement locks checking too.
    expect(check).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    expect(check).toBeEnabled();
    fireEvent.click(check);

    // Score, per-item marking, and the explanation for the miss.
    await waitFor(() => expect(screen.getByText("2")).toBeInTheDocument());
    expect(screen.getByText("/ 3")).toBeInTheDocument();
    expect(screen.getByText(/67%/)).toBeInTheDocument();
    expect(screen.getByText(/食べました（たべました）/)).toBeInTheDocument();
    expect(screen.getByText(/Past polite form/)).toBeInTheDocument();

    // Every item shows its review reference; the study plan aggregates ONLY
    // the missed one and leaves the correctly-answered topic out.
    const planBox = screen.getByText(/Where to study next/).closest("div")!;
    expect(within(planBox as HTMLElement).getByText(/Topic 6 — polite past tense/)).toBeInTheDocument();
    expect(
      within(planBox as HTMLElement).queryByText(/Topic 3 — location particles/),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText(/Topic 3 — location particles/).length).toBe(1);

    // The AI coach's feedback arrives after checking, alongside the plan.
    expect(await screen.findByText(/Your study coach/)).toBeInTheDocument();
    expect(screen.getByText(/drill ました forms/)).toBeInTheDocument();
    const feedbackCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/api/quiz/feedback"),
    );
    const feedbackBody = JSON.parse(String(feedbackCall?.[1]?.body));
    expect(feedbackBody.score).toEqual({ correct: 2, total: 3 });
    expect(feedbackBody.results).toHaveLength(3);
    expect(feedbackBody.results[1].correct).toBe(false);
    expect(feedbackBody.results[1].review).toMatch(/Topic 6/);
    expect(feedbackBody.results[2].correct).toBe(true);

    expect(screen.getByRole("button", { name: /Retake this test/ })).toBeInTheDocument();
    // Renamed from "New test, same settings" / "New test": both the score
    // card and the bottom bar now read exactly "New Test".
    expect(screen.getAllByRole("button", { name: "New Test" })).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: /same settings/i }),
    ).not.toBeInTheDocument();

    // "New Test" sends the sat paper's texts so the next one avoids them.
    fireEvent.click(screen.getAllByRole("button", { name: "New Test" })[0]);
    await waitFor(() => {
      const regen = fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith("/api/quiz") && init?.method === "POST",
      );
      const lastBody = JSON.parse(String(regen.at(-1)?.[1]?.body));
      expect(lastBody.avoid).toEqual(
        expect.arrayContaining(["毎日、部屋（　）勉強します。", "きのう、すしを【食べる】。"]),
      );
    });
  });

  it("accepts a romaji answer as correct", async () => {
    mockFetch();
    window.scrollTo = vi.fn();
    render(<QuizView initialKind="grammar" />);

    const select = await screen.findByLabelText(/Textbook/);
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /Start the Grammar Practice Test/ }));

    await screen.findByText("Grammar Practice Test");
    fireEvent.click(screen.getByRole("button", { name: /① で/ }));
    fireEvent.change(screen.getByPlaceholderText("こたえ"), {
      target: { value: "tabemashita" },
    });
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    fireEvent.click(screen.getByRole("button", { name: /Check answers/ }));

    // 3/3: the romaji answer graded as たべました.
    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument());
    expect(screen.getByText(/100%/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing to review from this paper/)).toBeInTheDocument();
  });

  it("starts in kanji mode when linked with ?kind=kanji", async () => {
    mockFetch();
    render(<QuizView initialKind="kanji" />);
    expect(
      await screen.findByRole("button", { name: /Start the Kanji Practice Test/ }),
    ).toBeInTheDocument();
  });
});
