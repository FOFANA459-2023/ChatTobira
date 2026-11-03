/** A practice question inside a chat answer, pressed by a real browser.
 *
 * The one e2e that answers the model for it. Every other spec in this folder
 * drives the real app end to end, but the thing under test here is what the
 * student can DO with an answer, and an answer that has to be generated first
 * makes the test cost money, take ten seconds, and fail on a day the provider
 * is slow. So the route is stubbed with one fixed answer and the browser does
 * everything else for real: the stream, the parse, the render, the press.
 *
 * What it guards is a negative. Until a student presses something, the page
 * must not tell them which option is the answer — and the answer key travels
 * all the way from the model to the browser to make the marking possible. The
 * unit tests hold the parser and the component to that separately; this holds
 * the whole path at once, in the one place a student could actually read it.
 */
import { expect, test } from "@playwright/test";

const F = "```";

const ANSWER = [
  "Two to try.",
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

/** The answer as the chat route sends it: an AI SDK UI message stream, one
 * SSE frame per chunk. Delivered in several deltas rather than one, because
 * the parser's hardest case is a half-arrived block and the student's browser
 * is where that actually happens. */
function uiMessageStream(text: string): string {
  const chunks: unknown[] = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "0" },
  ];
  for (let at = 0; at < text.length; at += 40) {
    chunks.push({ type: "text-delta", id: "0", delta: text.slice(at, at + 40) });
  }
  chunks.push({ type: "text-end", id: "0" }, { type: "finish-step" }, { type: "finish" });
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function ask(page: import("@playwright/test").Page, question: string) {
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
        "cache-control": "no-cache",
      },
      body: uiMessageStream(ANSWER),
    }),
  );
  await page.goto("/");
  // The notice is fixed over the bottom of the window; it has its own test.
  await page.getByRole("button", { name: /I understand/ }).click().catch(() => {});
  const composer = page.getByPlaceholder(/ask in Japanese or English/);
  await composer.fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: /もらいました/ })).toBeVisible();
}

test.describe("practice questions in a chat answer", () => {
  test("the options are buttons, and the answer is not on the page until one is pressed", async ({
    page,
  }) => {
    await ask(page, "quiz me on 〜てもらう");

    // The markup carries the answer key. None of it may reach the student.
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("[x]");
    expect(body).not.toContain(F);
    expect(body).toContain("Two to try.");
    await expect(page.getByText("Correct")).toHaveCount(0);
    await expect(page.getByText("takes 〜に")).toHaveCount(0);

    await page.getByRole("button", { name: /あげました/ }).click();

    // Marked, explained, and the right answer shown — being told "wrong"
    // with no way to learn what right was teaches nothing.
    await expect(page.getByText("Not quite")).toBeVisible();
    await expect(page.getByText("takes 〜に")).toBeVisible();
    await expect(page.getByRole("button", { name: /もらいました/ })).toBeDisabled();

    // The second question is its own question and is still open.
    await expect(page.getByRole("button", { name: /食べました/ })).toBeEnabled();
    await page.getByRole("button", { name: /食べました/ }).click();
    await expect(page.getByText("1 / 2 correct")).toBeVisible();
  });

  test("the questions are pressable on a phone, where students actually use it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await ask(page, "quiz me on 〜てもらう");

    const option = page.getByRole("button", { name: /もらいました/ });
    const box = (await option.boundingBox())!;
    expect(box.width, "an option ran off the side of the screen").toBeLessThanOrEqual(375);

    // Pressed where a finger would land, rather than dispatched at the
    // element: an overlay between the two is invisible to element.click().
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByText("Correct")).toBeVisible();
  });
});
