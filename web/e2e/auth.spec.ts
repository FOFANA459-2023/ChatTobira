import { expect, test } from "@playwright/test";

test("unauthenticated visitor is redirected to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: /ChatTobira/ })).toBeVisible();
});

test("login page explains the invite-only policy", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText(/limited to invited students/i)).toBeVisible();
  await expect(page.getByPlaceholder(/ritsumei/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /send sign-in link/i }),
  ).toBeVisible();
});

test("chat API rejects unauthenticated requests", async ({ request }) => {
  const response = await request.post("/api/chat", {
    data: { messages: [], scope: {} },
  });
  expect(response.status()).toBe(401);
});
