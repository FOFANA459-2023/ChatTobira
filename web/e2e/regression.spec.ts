/** The things that must not quietly stop working.
 *
 * `auth.spec.ts` guards who may reach what. This file guards the parts a
 * student would notice within one second of opening the app and that no other
 * gate has an opinion about: that the page is STYLED, that the shell is
 * present, and that the tabs go where they say.
 *
 * It exists because of a specific failure. During the 2026-09-18 model work
 * the app served completely unstyled for a stretch — Times New Roman, no
 * layout, every control still on the page — and tsc, eslint, 582 unit tests,
 * the e2e suite and the production smoke test were all green throughout. A
 * 200 is not a rendered app, and nothing in the pipeline had ever looked at a
 * pixel or an asset.
 *
 * Two layers, because they fail differently:
 *
 *   - `smoke.mjs` asks whether the stylesheet EXISTS and LOADS, against the
 *     real production worker. That catches a broken build or a missing asset.
 *   - This file asks whether it APPLIES, in a real browser with the cascade
 *     running. That catches a stylesheet that loads and does nothing — the
 *     wrong file, an empty build, a selector change that misses everything.
 *
 * Deliberately not a screenshot comparison. Pixel baselines on a Japanese app
 * fail on font hinting between a developer's Windows and CI's Linux, and a
 * suite that cries wolf every second run is a suite people stop reading. These
 * assert computed values that a human would call "the design is broken".
 */
import { expect, test } from "@playwright/test";

/** Colours the browser falls back to when no stylesheet applied. */
const UNSTYLED_BACKGROUNDS = ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)", "transparent"];

test.describe("the app is styled", () => {
  test("the stylesheet loads and the cascade actually applies it", async ({ page }) => {
    const failed: string[] = [];
    page.on("response", (response) => {
      if (response.url().includes(".css") && response.status() >= 400) {
        failed.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto("/login");

    // Three distinct failure modes, and each one has actually happened or was
    // reachable, so each is asserted separately rather than rolled into one
    // "looks fine" check.

    // 1. The stylesheet 404s. This is the one observed on 2026-09-18: the link
    //    was in the document, the page returned 200, and the asset behind it
    //    was gone.
    expect(failed, "a stylesheet failed to load").toEqual([]);

    // 2. The build emitted no stylesheet at all. Counting CSS RULES cannot see
    //    this and was the first version of this test: with the globals.css
    //    import removed the document has zero <link rel="stylesheet"> and
    //    still reports four rules, because Next injects its own inline sheet
    //    for the dev overlay. The count passed on a completely unstyled page.
    //    Count the links instead.
    const sheets = await page.locator('link[rel="stylesheet"]').count();
    expect(sheets, "the document links no stylesheet — the CSS build produced nothing").toBeGreaterThan(0);

    // 3. It loads and does nothing. Tailwind's preflight sets margin:0 on
    //    body; the user agent's default is 8px, so this is the cheapest
    //    positive proof that OUR css is the one in force rather than merely
    //    present.
    const bodyMargin = await page.locator("body").evaluate((el) => getComputedStyle(el).margin);
    expect(bodyMargin, "body kept the user-agent margin — the stylesheet loaded but did not apply").toBe("0px");
  });

  test("the page is laid out, not a stack of default-styled tags", async ({ page }) => {
    await page.goto("/");

    // Tailwind's preflight sets margin:0 on body. An unstyled document keeps
    // the user-agent's 8px, which is the single cheapest tell that no CSS
    // applied at all.
    const bodyMargin = await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).margin);
    expect(bodyMargin, "body kept the user-agent margin — no CSS applied").toBe("0px");

    // The header is a real bar with a background, not a bare <div>.
    const header = page.locator("header").first();
    await expect(header).toBeVisible();
    const headerBackground = await header.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(
      UNSTYLED_BACKGROUNDS.includes(headerBackground),
      `header background is ${headerBackground} — the shell is unstyled`,
    ).toBe(false);

    // The app sets its own typeface. Falling back to a serif is what the
    // broken render looked like.
    const font = await page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font.toLowerCase(), "body fell back to the default serif").not.toMatch(
      /^(times|serif)/,
    );
  });

  test("the composer and its send button are on screen together", async ({ page }) => {
    await page.goto("/");
    const composer = page.getByPlaceholder(/ask in Japanese or English/);
    const send = page.getByRole("button", { name: /^send$/i });
    await expect(composer).toBeVisible();
    await expect(send).toBeVisible();

    // Both inside the viewport. A layout regression that pushes the send
    // button off-screen leaves every other assertion in this file green.
    const box = await send.boundingBox();
    const viewport = page.viewportSize();
    expect(box, "the send button has no box").not.toBeNull();
    expect(box!.x + box!.width, "the send button is off the right edge").toBeLessThanOrEqual(
      viewport!.width,
    );
    expect(box!.y, "the send button is below the fold").toBeLessThanOrEqual(viewport!.height);
  });
});

test.describe("the shell still navigates", () => {
  test("the three tabs are present and go where they say", async ({ page }) => {
    await page.goto("/");
    // Located by href inside the tab bar rather than by name. Each tab renders
    // its English label beside a Japanese one — "Chat チャット" — so an exact
    // name match is wrong, and a loose one collides with the "ChatTobira"
    // wordmark, which is also a link to "/".
    const tabs = page.locator("nav").first();
    await expect(tabs.locator('a[href="/"]')).toBeVisible();
    await expect(tabs.locator('a[href="/quiz?kind=grammar"]')).toBeVisible();
    await expect(tabs.locator('a[href="/quiz?kind=kanji"]')).toBeVisible();

    // The active tab marks itself for assistive technology, which is also how
    // the student can see which one they are on.
    await expect(tabs.locator('a[href="/"]')).toHaveAttribute("aria-current", "page");
  });

  test("the quiz picker offers a textbook and a way to start", async ({ page }) => {
    await page.goto("/quiz?kind=grammar");
    // The picker is the whole of the quiz UI before a paper exists; if it
    // stops rendering, the feature is gone and /quiz still returns 200.
    await expect(page.getByText(/^Textbook$/)).toBeVisible();
    await expect(page.getByRole("button", { name: /start the grammar practice test/i })).toBeVisible();
  });

  test("it works at phone width, where students actually use it", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await expect(page.getByPlaceholder(/ask in Japanese or English/)).toBeVisible();
    // No horizontal scroll: the most common responsive regression, and one
    // that no desktop-width assertion can see.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page scrolls sideways on a phone").toBeLessThanOrEqual(1);
  });
});
