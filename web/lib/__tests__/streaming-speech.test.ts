import { describe, expect, it } from "vitest";

import { readyToSpeak, sentences, speakableText } from "@/lib/speech";

/** Walk a reply through the pipeline the way a stream delivers it, and collect
 * what would have been spoken, in order. */
function speakAsItArrives(chunks: string[]): string[] {
  let text = "";
  let consumed = 0;
  const spoken: string[] = [];
  chunks.forEach((chunk, index) => {
    text += chunk;
    const done = index === chunks.length - 1;
    const ready = readyToSpeak(speakableText(text), consumed, done);
    if (!ready.region) return;
    consumed = ready.consumed;
    spoken.push(...sentences(ready.region));
  });
  return spoken;
}

describe("speaking a reply while it is still being written", () => {
  it("says the first sentence before the rest of the answer has arrived", () => {
    // The whole point. Speaking used to start after the LAST token, so the
    // student sat through the entire generation in silence.
    const first = readyToSpeak("京都はいいところですね。それで、", 0, false);
    expect(first.region).toBe("京都はいいところですね。");
  });

  it("never speaks half a sentence", () => {
    expect(readyToSpeak("京都では何を", 0, false).region).toBe("");
    expect(readyToSpeak("京都では何を見ましたか。", 0, false).region).toBe(
      "京都では何を見ましたか。",
    );
  });

  it("holds a fragment back rather than sending it alone", () => {
    // Measured: 「はい。」 on its own came back from the service with no audio,
    // and a six-character request costs nearly what a sentence costs.
    expect(readyToSpeak("はい。", 0, false).region).toBe("");
    // It goes out once there is enough beside it.
    expect(readyToSpeak("はい。とてもいいですね。", 0, false).region).toBe(
      "はい。とてもいいですね。",
    );
  });

  it("speaks every clause exactly once, in order, across a whole stream", () => {
    const spoken = speakAsItArrives([
      "いいですね",
      "。京都では何を",
      "見ましたか。お寺は",
      "きれいでしたか。",
    ]);
    // 「いいですね。」 is too short to send alone, so it rides out with the
    // sentence after it — `sentences` joins a merged pair with a space.
    expect(spoken).toEqual([
      "いいですね。 京都では何を見ましたか。",
      "お寺はきれいでしたか。",
    ]);
    // Said once each, nothing repeated, nothing dropped.
    expect(spoken.join("").replace(/\s/g, "")).toBe(
      "いいですね。京都では何を見ましたか。お寺はきれいでしたか。",
    );
  });

  it("flushes the tail when the stream ends without a full stop", () => {
    // A reply that stops mid-thought still has to be said, or the student
    // hears the answer cut off.
    const spoken = speakAsItArrives(["いいですね。京都では何を見ましたか", ""]);
    expect(spoken.join("")).toContain("京都では何を見ましたか");
  });

  it("does not re-speak text it has already handed over", () => {
    let consumed = 0;
    const a = readyToSpeak("いいですね。ありがとう。", consumed, false);
    consumed = a.consumed;
    const b = readyToSpeak("いいですね。ありがとう。", consumed, false);
    expect(b.region).toBe("");
  });

  it("works the same on an English reply", () => {
    const spoken = speakAsItArrives([
      "That sounds great! What did",
      " you enjoy most about it?",
    ]);
    expect(spoken[0]).toContain("That sounds great!");
  });

  it("strips the markup before deciding, so layout never reaches the voice", () => {
    // The answer is set like a textbook page; the voice must not read pipes.
    const ready = readyToSpeak(speakableText("## 語彙\n- 食べる: to eat\n"), 0, true);
    expect(ready.region).not.toContain("##");
    expect(ready.region).not.toContain("- ");
  });
});
