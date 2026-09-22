import { describe, expect, it } from "vitest";

import { systemPrompt } from "@/lib/prompt";

describe("a file sent without a message", () => {
  it("tells the tutor there is no instruction, and to open the conversation about the file", () => {
    const prompt = systemPrompt({}, { hasUploads: true, fileWithoutInstruction: true });
    expect(prompt).toContain("THE STUDENT SENT A FILE AND WROTE NOTHING");
    // Say what it is, make a start that teaches, offer where to go next.
    expect(prompt).toMatch(/one line what the file is/);
    expect(prompt).toMatch(/make a start that teaches/);
    expect(prompt).toMatch(/two or three specific offers/);
    // Not a guessed request for every answer — but the student can ask for one.
    expect(prompt).toMatch(/do not answer as if they had asked for every answer/);
    expect(prompt).toMatch(/follow what they ask/);
  });

  it("leaves the rules out when the student wrote something", () => {
    // A model told how to handle a silent file with a question in front of it
    // would start ignoring the question.
    expect(systemPrompt({}, { hasUploads: true })).not.toContain("WROTE NOTHING");
    expect(systemPrompt({}, {})).not.toContain("WROTE NOTHING");
  });

  it("still names what is not a textbook only as class materials", () => {
    const prompt = systemPrompt({}, { hasUploads: true, fileWithoutInstruction: true });
    expect(prompt).toContain('"your class materials"');
  });
});
