import { describe, expect, it } from "vitest";

import { readStreamFrame } from "../use-classic-voice";

/** The speaking page's fallback reads the chat route's answer as it streams,
 * without the chat's own client. These are the frames that route actually
 * sends (see app/api/chat/route.ts and the AI SDK's UI message stream). */
const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}`;

describe("readStreamFrame", () => {
  it("takes the words of the answer", () => {
    expect(readStreamFrame(frame({ type: "text-delta", id: "0", delta: "こんにちは" }))).toEqual({
      delta: "こんにちは",
    });
  });

  it("takes the chat the turn was saved under, so the call stays in one chat", () => {
    expect(
      readStreamFrame(frame({ type: "start", messageMetadata: { conversationId: 81 } })),
    ).toEqual({ conversationId: 81 });
  });

  it("takes a refusal that arrives inside a successful response", () => {
    // Every answer model refused: a 200 with an error part, not a 502.
    expect(readStreamFrame(frame({ type: "error", errorText: "unavailable" }))).toEqual({
      error: "unavailable",
    });
  });

  it("ignores the framing the loop has no use for", () => {
    for (const type of ["start-step", "text-start", "text-end", "finish-step", "finish"]) {
      expect(readStreamFrame(frame({ type }))).toBeNull();
    }
    expect(readStreamFrame("data: [DONE]")).toBeNull();
  });

  it("ignores what is not a frame at all, rather than ending the call", () => {
    expect(readStreamFrame("")).toBeNull();
    expect(readStreamFrame(": keep-alive")).toBeNull();
    expect(readStreamFrame("data: {not json")).toBeNull();
  });
});
