#!/usr/bin/env node
/**
 * Write the corpus fixture the quiz harness runs against.
 *
 * The harness needs a real corpus — real chunk text, real page numbers, real
 * past-paper metadata — and must never need a database connection to get one.
 * A test suite that talks to Postgres is a test suite that talks to whatever
 * Postgres the shell happened to have configured, and the one thing this work
 * must not do is reach production. So the local copy is exported ONCE, to a
 * file, and everything downstream reads the file.
 *
 *   scripts/local-db.sh up          make the local copy
 *   node web/scripts/export-fixture.mjs   write .work/quiz-fixture.json
 *   npx vitest run quiz-corpus      run the harness against it
 *
 * The fixture is course material and page numbers. It carries no student
 * rows, because the local copy has none — see scripts/local-db.sh.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, ".work", "quiz-fixture.json");
const CONTAINER = "chattobira-devdb";

/** Run one query on the local copy and parse the single JSON value back.
 *
 * `docker exec` rather than a Postgres client library: the web app has no
 * database driver in its dependencies and does not need one — it talks to
 * Supabase over HTTP — and adding `pg` to ship a fixture exporter would put a
 * driver in the deployed bundle's lockfile for the sake of a script.
 */
function query(sql) {
  const out = execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out.trim() || "null");
}

function main() {
  const documents = query(`
    select coalesce(json_agg(row_to_json(d) order by d.id), '[]'::json)
      from (select id, title, level, doc_type, is_citable, page_count
              from documents) d`);

  // Textbook chunks, capped the way the route caps them (500 a book, page
  // order) so the fixture is the pool the app actually works from rather than
  // an idealised one.
  const textbooks = documents.filter((d) => d.doc_type === "textbook");
  const pools = {};
  for (const book of textbooks) {
    pools[book.id] = query(`
      select coalesce(json_agg(row_to_json(c) order by c.pdf_page), '[]'::json)
        from (select content, metadata, book_page, pdf_page
                from chunks where document_id = ${book.id}
               order by pdf_page, ord limit 800) c`);
  }

  const papers = query(`
    select coalesce(json_agg(row_to_json(c)), '[]'::json)
      from (select c.content, c.metadata, d.level
              from chunks c join documents d on d.id = c.document_id
             where d.doc_type = 'past_paper'
             limit 400) c`);

  mkdirSync(dirname(OUT), { recursive: true });
  const fixture = {
    exportedAt: new Date().toISOString(),
    source: "local copy of production (scripts/local-db.sh)",
    documents,
    pools,
    papers,
  };
  writeFileSync(OUT, JSON.stringify(fixture));

  const chunks = Object.values(pools).reduce((n, list) => n + list.length, 0);
  console.log(`fixture → ${OUT}`);
  console.log(
    `  ${documents.length} documents, ${textbooks.length} textbook pools, ` +
      `${chunks} textbook chunks, ${papers.length} past-paper chunks`,
  );
}

main();
