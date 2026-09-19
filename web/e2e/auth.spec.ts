import { expect, test } from "@playwright/test";

test("unauthenticated visitor gets the trial chat, not a redirect", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByPlaceholder(/ask in Japanese or English/)).toBeVisible();
  await expect(page.getByText(/3 questions free/)).toBeVisible();
});

test("quiz page is open to trial visitors, like the chat", async ({ page }) => {
  await page.goto("/quiz");
  await expect(page).toHaveURL(/\/quiz/);
  await expect(page.getByText(/1 practice test free/)).toBeVisible();
});

test("login page signs in with an APU email and password", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("APU email")).toBeVisible();
  await expect(page.getByPlaceholder(/@apu\.ac\.jp/)).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /forgot password/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /create an account/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /admin sign-in/i })).toBeVisible();
});

test("signup page asks for full name, APU email and password", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByLabel("Full name")).toBeVisible();
  await expect(page.getByText(/as it appears on your APU student ID/i)).toBeVisible();
  await expect(page.getByLabel("APU email")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Confirm password")).toBeVisible();
});

test("signup refuses a personal email before sending anything", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("FOFANA VARLEE");
  await page.getByLabel("APU email").fill("someone@gmail.com");
  await page.getByLabel("Password", { exact: true }).fill("correct horse");
  await page.getByLabel("Confirm password").fill("correct horse");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(/ends in @apu\.ac\.jp/)).toBeVisible();
});

test("the welcome questions require a session", async ({ page }) => {
  await page.goto("/welcome");
  await expect(page).toHaveURL(/\/login/);
});

test("admin page offers the password sign-in when signed out", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(page.getByPlaceholder(/password/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
});

test("admin students API rejects unauthenticated requests", async ({ request }) => {
  const response = await request.get("/api/admin/students");
  expect(response.status()).toBe(401);
});

test("chat API admits anonymous trial requests past the auth gate", async ({
  request,
}) => {
  // Not 401: the trial cookie meters anonymous use inside the route. (This
  // environment has no model keys, so the request fails later with 4xx/5xx —
  // the point is the gate, not the answer.)
  const response = await request.post("/api/chat", {
    data: { messages: [], scope: {} },
  });
  expect(response.status()).not.toBe(401);
});

test("quiz API admits an anonymous visitor's first test", async ({ request }) => {
  // Not 401: the quiz trial cookie meters anonymous use inside the route, the
  // same way the chat trial does. (No model keys in this environment, so the
  // request fails later — the point is the gate, not the paper.)
  const response = await request.post("/api/quiz", {
    data: { documentId: 1, kind: "grammar", count: 9 },
  });
  expect(response.status()).not.toBe(401);
});

test("quiz API requires sign-in once the free test is spent", async ({ request }) => {
  // Its own test so the cookie jar starts empty and this header is the only
  // trial state in play.
  const response = await request.post("/api/quiz", {
    headers: { cookie: "tobira_quiz_trial=1" },
    data: { documentId: 1, kind: "grammar", count: 9 },
  });
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ error: "trial_exhausted" });
});

test("the chat trial does not consume the quiz trial", async ({ request }) => {
  // Separate cookies on purpose: sampling one part of the product must not
  // silently spend the other.
  const response = await request.post("/api/quiz", {
    headers: { cookie: "tobira_trial=3" },
    data: { documentId: 1, kind: "grammar", count: 9 },
  });
  expect(response.status()).not.toBe(401);
});

test("transcribe API rejects unauthenticated requests", async ({ request }) => {
  const response = await request.post("/api/transcribe", {
    multipart: { audio: { name: "a.webm", mimeType: "audio/webm", buffer: Buffer.from("x") } },
  });
  expect(response.status()).toBe(401);
});
