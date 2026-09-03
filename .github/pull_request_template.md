## What changes, and why

<!-- One or two sentences. The reason matters more than the list of files. -->

## How it was verified

<!-- What you actually ran, not what you intended to run. -->

- [ ] `npm test` and `pytest` pass
- [ ] Production build succeeds (`npx opennextjs-cloudflare build`) — `tsc` alone does not catch route-export errors
- [ ] Smoke test passes against the worker (`npm run smoke`)

## Things worth a closer look

Tick anything this PR touches — each one has bitten this project before.

- [ ] **A database migration.** It runs against the live database students
      are using. Is it additive, and is it safe to apply twice?
- [ ] **Retrieval, chunking, or the topic mapping.** A silent regression here
      answers confidently from the wrong pages. Was it checked against the
      real corpus, not just synthetic fixtures?
- [ ] **Quota, caching, or the provider cascade.** The whole deployment runs
      on free tiers; a change here can exhaust a daily budget in an hour.
- [ ] **Anything students can write** (uploads, feedback). Could one student's
      content reach another student, or reach the shared corpus unreviewed?
- [ ] **Auth, RLS, or the allowlist.** Who can now see or do something they
      could not before?
- [ ] **Copyright surface.** Does this serve or store more source material
      than before?

## Notes for the reviewer

<!-- Anything you are unsure about, or deliberately left out of scope. -->
