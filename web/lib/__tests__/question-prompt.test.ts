import { describe, expect, it } from "vitest";

import { systemPrompt } from "@/lib/prompt";

/** What the tutor is told about questions the student answers on screen.
 *
 * The format is a contract with lib/answer.ts: the parser recognises one
 * shape, so the prompt has to ask for that shape and no other. These tests
 * hold the two halves together — and hold the prompt to leaving everything
 * ELSE to the student, which is the whole point of it being a capability
 * rather than a quiz feature.
 */
const scope: Parameters<typeof systemPrompt>[0] = {};

const F = "```";

describe("the question format the tutor is given", () => {
  const prompt = systemPrompt(scope);

  it("asks for the block the parser actually reads", () => {
    expect(prompt).toContain(`${F}quiz`);
    expect(prompt).toContain("- [ ]");
    expect(prompt).toContain("- [x]");
    expect(prompt).toContain("Q:");
    expect(prompt).toContain("E:");
  });

  it("forbids the answer appearing anywhere else", () => {
    // The format is pointless if the prose underneath says "the answer is b".
    expect(prompt).toContain("THE ANSWERS APPEAR NOWHERE ELSE");
  });

  it("tells it not to letter the options, because the app does", () => {
    expect(prompt).toMatch(/Do not letter or number the options/);
  });

  it("leaves the number, kind and language of the questions to the student", () => {
    // Everything this app knows about what a good practice question is, it
    // knows from the student asking for it. A prompt that fixes the count or
    // the kind is a prompt that cannot be asked for three hard ones in
    // Japanese.
    expect(prompt).toContain("EVERYTHING ELSE IS THE STUDENT'S TO DECIDE");
    expect(prompt).toMatch(/true\/false/);
    expect(prompt).not.toMatch(/Five questions unless/);
  });

  it("does not turn an ordinary question into an examination", () => {
    expect(prompt).toMatch(/Only when questions are what they want/);
  });
});

describe("when the student asked for a page", () => {
  it("is not allowed to write questions of its own", () => {
    // "The practice questions on p. 122" is a request for what the book
    // prints. Invented ones in their place are indistinguishable from the
    // real exercise to the student revising from them.
    const prompt = systemPrompt(scope, {
      canAskQuestions: false,
      page: { asked: 122, retrieved: true },
    });
    expect(prompt).not.toContain(`${F}quiz`);
    expect(prompt).toContain("THE STUDENT ASKED FOR PAGE 122");
  });
});
