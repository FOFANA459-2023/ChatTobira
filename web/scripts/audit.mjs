#!/usr/bin/env node
/**
 * Dependency audit for the web app, with accepted findings written down.
 *
 * `npm audit` has no ignore file, which leaves two bad options: gate on its
 * raw exit code and watch CI go red on a transitive dev-dependency advisory
 * nobody can act on, or not gate at all. The Python side has had `pip-audit`
 * since the pipeline was written and this side had neither.
 *
 * So this is the same shape as `web/.trivyignore.yaml`, which already solves
 * this problem for container CVEs: every accepted finding carries a REASON and
 * a REVIEW DATE, and the date is enforced. An exception that nobody revisits is
 * a vulnerability with extra steps.
 *
 * What it gates on:
 *
 *   - PRODUCTION dependencies only (`--omit=dev`). The question a deploy gate
 *     should ask is whether the code we ship to students has a known hole in
 *     it. vitest and vite are not shipped; they are a different and much less
 *     urgent conversation than a flaw in what runs in the worker.
 *   - HIGH and CRITICAL only. Moderate and low are reported and do not fail.
 *     A gate that fires on everything is one people learn to re-run rather
 *     than read — the same reasoning the deploy gate's own comment gives.
 *   - Anything NOT on the accepted list fails the build. That is the point:
 *     the list is small and deliberate, so a new advisory stands out.
 *
 *   node scripts/audit.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCEPTED_PATH = resolve(WEB, ".npm-audit-accepted.json");

/** npm audit exits non-zero when it finds anything, so the output is what
 * matters and the status is not. */
function audit() {
  try {
    return execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      cwd: WEB,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === "win32",
    });
  } catch (error) {
    if (error.stdout) return error.stdout;
    throw error;
  }
}

const report = JSON.parse(audit());
const vulnerabilities = report.vulnerabilities ?? {};
const accepted = Object.fromEntries(
  // Keys beginning with an underscore are prose for whoever opens the file,
  // not advisories.
  Object.entries(JSON.parse(readFileSync(ACCEPTED_PATH, "utf8"))).filter(
    ([key]) => !key.startsWith("_"),
  ),
);

const today = new Date().toISOString().slice(0, 10);
const problems = [];
const stale = [];

for (const [name, entry] of Object.entries(vulnerabilities)) {
  if (entry.severity !== "high" && entry.severity !== "critical") continue;
  const exception = accepted[name];
  if (!exception) {
    const titles = (entry.via ?? [])
      .map((via) => (typeof via === "object" ? via.title : via))
      .filter(Boolean);
    problems.push(
      `  ${entry.severity.toUpperCase()} ${name}\n` +
        `      ${titles[0] ?? "see npm audit"}\n` +
        `      fix: ${
          entry.fixAvailable === false
            ? "none published"
            : typeof entry.fixAvailable === "object"
              ? `${entry.fixAvailable.name}@${entry.fixAvailable.version}${
                  entry.fixAvailable.isSemVerMajor ? " (breaking)" : ""
                }`
              : "npm audit fix"
        }`,
    );
    continue;
  }
  if (exception.review < today) {
    stale.push(`  ${name} — accepted until ${exception.review}, which has passed`);
  }
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(
  `npm audit (production dependencies): ${counts.critical ?? 0} critical, ` +
    `${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low`,
);

if (stale.length > 0) {
  console.error(
    `\nAccepted findings whose review date has passed. Re-check whether the ` +
      `reason still holds, then move the date or fix the dependency:\n${stale.join("\n")}`,
  );
}
if (problems.length > 0) {
  console.error(
    `\nUnaccepted high/critical vulnerabilities in shipped dependencies:\n${problems.join("\n")}\n\n` +
      `Fix it, or add it to web/.npm-audit-accepted.json with a reason and a ` +
      `review date — the same bargain web/.trivyignore.yaml makes.`,
  );
}
if (problems.length > 0 || stale.length > 0) process.exit(1);

const names = Object.keys(accepted);
console.log(
  names.length > 0
    ? `${names.length} accepted finding(s), all within their review date: ${names.join(", ")}`
    : "no accepted findings",
);
