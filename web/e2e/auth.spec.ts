import { expect, test } from "@playwright/test";

test("unauthenticated visitor gets the trial chat, not a redirect", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByPlaceholder(/ask in Japanese or English/)).toBeVisible();
  await expect(page.getByText(/3 questions free/)).toBeVisible();
});

test("quiz still requires sign-in", async ({ page }) => {
  await page.goto("/quiz");
  await expect(page).toHaveURL(/\/login/);
});

test("login page explains the invite-only policy", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText(/limited to invited students/i)).toBeVisible();
  await expect(page.getByPlaceholder(/ritsumei/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /send sign-in link/i }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /admin sign-in/i })).toBeVisible();
});

test("admin page offers the password sign-in when signed out", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(page.getByPlaceholder(/password/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
});

test("invite API rejects unauthenticated requests", async ({ request }) => {
  const response = await request.post("/api/invite", {
    data: { email: "someone@example.com" },
  });
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

test("quiz API rejects unauthenticated requests", async ({ request }) => {
  const response = await request.post("/api/quiz", {
    data: { scope: {}, count: 5 },
  });
  expect(response.status()).toBe(401);
});

test("transcribe API rejects unauthenticated requests", async ({ request }) => {
  const response = await request.post("/api/transcribe", {
    multipart: { audio: { name: "a.webm", mimeType: "audio/webm", buffer: Buffer.from("x") } },
  });
  expect(response.status()).toBe(401);
});
