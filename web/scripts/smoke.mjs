#!/usr/bin/env node
/**
 * Production-parity smoke test.
 *
 * Run against the worker booted under workerd (wrangler), which is the engine
 * Cloudflare actually runs. Everything else in CI — tsc, vitest, even
 * `next build` — checks the code. This checks that the thing we are about to
 * deploy STARTS and SERVES.
 *
 * It is deliberately runnable with no secrets configured, because that is the
 * state CI is in and because "fails closed and still renders" is itself the
 * contract: middleware.ts treats missing Supabase config as signed-out rather
 * than throwing, and a 500 there would be a real regression.
 *
 *   node scripts/smoke.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? process.env.SMOKE_URL ?? "http://127.0.0.1:8787";
const BOOT_TIMEOUT_MS = 120_000;

/** Each check names what would be broken in production if it failed. */
const CHECKS = [
  {
    name: "login page renders",
    why: "students who are signed out land here; a 500 locks everyone out",
    async run() {
      const response = await fetch(`${BASE}/login`, { redirect: "manual" });
      assert(response.status === 200, `expected 200, got ${response.status}`);
      const body = await response.text();
      assert(body.includes("<html"), "response was not an HTML document");
      // A worker that boots but renders the Next.js error page still 200s.
      assert(
        !/Application error|Internal Server Error/i.test(body),
        "page rendered an error boundary",
      );
    },
  },
  {
    name: "chat page renders for a signed-out visitor",
    why: "the 3-question trial lives here; it is the app's front door",
    async run() {
      const response = await fetch(`${BASE}/`, { redirect: "manual" });
      assert(
        response.status === 200 || response.status === 307,
        `expected 200 or a redirect, got ${response.status}`,
      );
    },
  },
  {
    name: "admin page renders",
    why: "it is its own sign-in page, so it must be reachable while signed out",
    async run() {
      const response = await fetch(`${BASE}/admin`, { redirect: "manual" });
      assert(response.status === 200, `expected 200, got ${response.status}`);
    },
  },
  {
    name: "chat API rejects a malformed body without a 500",
    why: "a crash here is an unhandled exception reaching every student",
    async run() {
      const response = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonsense: true }),
      });
      // 400 bad request, 401 signed out, 503 unconfigured are all correct
      // answers. 500 means it threw.
      assert(
        [400, 401, 503].includes(response.status),
        `expected 400/401/503, got ${response.status}`,
      );
    },
  },
  {
    name: "upload API refuses an anonymous caller",
    why: "uploads cost vision quota and are stored against an account",
    async run() {
      const response = await fetch(`${BASE}/api/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert(
        [400, 401, 503].includes(response.status),
        `expected 400/401/503, got ${response.status}`,
      );
    },
  },
  {
    name: "admin-only API refuses an anonymous caller",
    why: "the invite list must never be readable without an admin session",
    async run() {
      const response = await fetch(`${BASE}/api/invite`, { redirect: "manual" });
      assert(
        [401, 403, 503].includes(response.status),
        `expected 401/403/503, got ${response.status}`,
      );
    },
  },
  {
    name: "unknown route 404s rather than crashing",
    why: "scanners hit random paths constantly",
    async run() {
      const response = await fetch(`${BASE}/definitely-not-a-page`, { redirect: "manual" });
      assert(
        response.status === 404 || response.status === 307,
        `expected 404 or a redirect, got ${response.status}`,
      );
    },
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/login`, { redirect: "manual" });
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `worker did not accept connections at ${BASE} within ` +
      `${BOOT_TIMEOUT_MS / 1000}s (last error: ${last})`,
  );
}

const start = Date.now();
console.log(`smoke: waiting for ${BASE}`);
await waitForBoot();
console.log(`smoke: worker up after ${((Date.now() - start) / 1000).toFixed(1)}s\n`);

let failed = 0;
for (const check of CHECKS) {
  try {
    await check.run();
    console.log(`  PASS  ${check.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${check.name}`);
    console.error(`        ${error instanceof Error ? error.message : error}`);
    console.error(`        why it matters: ${check.why}`);
  }
}

console.log(`\n${CHECKS.length - failed}/${CHECKS.length} smoke checks passed`);
process.exit(failed === 0 ? 0 : 1);
