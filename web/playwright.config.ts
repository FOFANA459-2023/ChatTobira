import { defineConfig } from "@playwright/test";

/** Point the suite at something already running instead of starting a dev
 * server.
 *
 * CI uses this to run the regression spec against the PRODUCTION bundle —
 * the OpenNext worker booted under workerd in the docker-web job — rather
 * than against `next dev`. The two builds emit CSS by different paths, and
 * the failure that made this file necessary was invisible to one of them.
 * Locally: PLAYWRIGHT_BASE_URL=http://127.0.0.1:8787 npx playwright test
 */
const external = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }]] : "list",
  use: {
    baseURL: external ?? "http://localhost:3100",
    trace: "on-first-retry",
  },
  // Only started when nothing was handed to us. Booting a dev server in front
  // of a worker that is already serving would test the wrong one.
  webServer: external
    ? undefined
    : {
      command: "npm run dev -- --port 3100",
      url: "http://localhost:3100/login",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        // E2E runs without a real backend: the middleware treats every visitor
        // as signed out, which is exactly what these tests assert.
        NEXT_PUBLIC_SUPABASE_URL:
          process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY:
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key",
      },
    },
});
