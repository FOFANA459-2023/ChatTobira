import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Answer } from "@/components/answer";

/** A practice question inside a chat answer, from the student's side.
 *
 * The thing being tested is a negative: until they press something, the page
 * must not tell them which option is the answer. Everything else here — the
 * verdict, the explanation, the score — only matters because it arrives
 * afterwards.
 */
const F = "```";

const ANSWER = [
  "Here are two to try.",
  "",
  `${F}quiz`,
  "Q: 友達に写真を見せて（　）。",
  "- [ ] あげました",
  "- [x] もらいました",
  "- [ ] くれました",
  "E: 「もらう」 takes 〜に for the person who did you the favour.",
  "Q: きのう、何を（　）か。",
  "- [x] 食べました",
  "- [ ] 食べます",
  "E: きのう is yesterday, so the verb is past.",
  F,
].join("\n");

const options = () => screen.getAllByRole("button");
const option = (text: string) =>
  options().find((button) => button.textContent?.includes(text))!;

describe("a practice question in a chat answer", () => {
  it("gives the student a button for every option", () => {
    render(<Answer text={ANSWER} />);
    expect(option("あげました")).toBeTruthy();
    expect(option("もらいました")).toBeTruthy();
    expect(option("くれました")).toBeTruthy();
    // The prose around the questions is still the answer it was.
    expect(screen.getByText("Here are two to try.")).toBeTruthy();
  });

  it("says nothing about which option is right until one is pressed", () => {
    const { container } = render(<Answer text={ANSWER} />);
    // No verdict, no explanation, and nothing in the markup a curious
    // student could read the answer off.
    expect(screen.queryByText("Correct")).toBeNull();
    expect(screen.queryByText(/Not quite/)).toBeNull();
    expect(container.textContent).not.toContain("takes 〜に");
    expect(container.textContent).not.toContain("[x]");
    expect(container.innerHTML).not.toContain("correct");
  });

  it("marks a right answer right, and shows why", () => {
    render(<Answer text={ANSWER} />);
    fireEvent.click(option("もらいました"));
    expect(screen.getByText("Correct")).toBeTruthy();
    expect(screen.getByText(/takes 〜に/)).toBeTruthy();
  });

  it("marks a wrong answer wrong, and still shows which one was right", () => {
    render(<Answer text={ANSWER} />);
    fireEvent.click(option("あげました"));
    expect(screen.getByText("Not quite")).toBeTruthy();
    // Wrong with no way to learn what right was is a worse answer than none.
    expect(option("もらいました").className).toContain("green");
    expect(option("あげました").className).toContain("red");
  });

  it("will not let the same question be answered twice", () => {
    render(<Answer text={ANSWER} />);
    fireEvent.click(option("あげました"));
    expect(option("もらいました")).toBeDisabled();
    fireEvent.click(option("もらいました"));
    // Still the first verdict: a student cannot press around until it goes
    // green, which is the one way to make a question teach nothing.
    expect(screen.getByText("Not quite")).toBeTruthy();
    expect(screen.queryByText("Correct")).toBeNull();
  });

  it("answers each question on its own, not the paper as a whole", () => {
    render(<Answer text={ANSWER} />);
    fireEvent.click(option("もらいました"));
    expect(screen.getByText("Correct")).toBeTruthy();
    // The second question is untouched and still answerable.
    expect(option("食べました")).toBeEnabled();
    expect(screen.queryByText(/yesterday, so the verb is past/)).toBeNull();
  });

  it("totals the score once every question has been answered", () => {
    render(<Answer text={ANSWER} />);
    fireEvent.click(option("あげました"));
    expect(screen.queryByText(/correct$/)).toBeNull();
    fireEvent.click(option("食べました"));
    expect(screen.getByText("1 / 2 correct")).toBeTruthy();
  });

  it("hands the questions back unanswered when asked to try again", () => {
    render(<Answer text={ANSWER} />);
    fireEvent.click(option("あげました"));
    fireEvent.click(option("食べました"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByText("Not quite")).toBeNull();
    expect(option("あげました")).toBeEnabled();
  });

  it("leaves an answer the model never ticked unpressable rather than lying", () => {
    // Nothing to mark against. The questions are still worth reading; a
    // button that could only ever mark the student wrong is not.
    render(<Answer text={[`${F}quiz`, "Q: どれ", "- [ ] に", "- [ ] で", F].join("\n")} />);
    expect(option("に")).toBeDisabled();
    expect(screen.queryByText("Correct")).toBeNull();
  });

  it("sets furigana and lang on the questions like the rest of the answer", () => {
    const { container } = render(
      <Answer text={[`${F}quiz`, "Q: 写真（しゃしん）", "- [x] photo", "- [ ] paper", F].join("\n")} />,
    );
    expect(container.querySelector("ruby rt")?.textContent).toBe("しゃしん");
    expect(container.querySelector('[lang="ja"]')).not.toBeNull();
  });
});
