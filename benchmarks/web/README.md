# Public API and browser evaluation

This corpus extends the function corpus in `benchmarks/public/`. It executes actual pinned Express and React TodoMVC source, through narrowly documented launch/test adapters. It is separate from the original controlled checkout demonstration.

## Reproduce

From a built SENTINEL checkout, with an installed Chromium-compatible browser:

```sh
npm ci
npm run build
npm ci --prefix benchmarks/web/runtime --ignore-scripts
node benchmarks/web/run.mjs --allow-local --out=/tmp/sentinel-web-results.json
```

The optional benchmark dependencies are explicit and lockfile-pinned. They are not installed by `sentinel demo`, and no browser is downloaded implicitly. Read the source before authorizing local execution. `--split=development` or `--split=held-out` selects the recorded partition. All application requests target temporary loopback servers.

## Independent labels and provenance

`cases.json` was written before running the corpus against the new verification kernel. Its initial SHA-256 is `7c8e83838840c89fa3f5d515a2400e043a38318e9e1cee39654001c7d3fbfc01`. Three development cases exercise basic API/browser execution; nine held-out cases were not used to build the application engine. This is an internal held-out partition, not an external blind study. Labels were specified by a separate engineering agent from the engine implementation; all are inspectable and finite.

Every original upstream file has an exact source URL, commit and SHA-256 in `provenance.json`. Original MIT licenses are retained. The React reducer also retains its embedded nanoid copyright/license. The full historical function evaluation remains available; the new web changes are explicitly **seeded evaluation changes**, not newly discovered upstream bugs.

- Express `examples/web-service` at `1c6f1b0fe4000977b9a7b4f34097e4d527dd9824` supplies a real Node API. Its original eleven Mocha/Supertest test bodies are retained. The source adapter changes its monorepo `require('../../')` to the installed pinned Express package. A separate loopback server adds readiness. Vitest registration wraps original callback tests in promises; assertion chains are unchanged. Original Mocha also runs independently for comparison.
- React TodoMVC at `ff43b02e59dfa604386bb382034b2cd07c2bcd8a` supplies real React components, reducer and router. The independent `app-spec.md` requires trimming new todo input. Browser steps fill the real input and press Enter, then inspect exact displayed text and the cleared input. Esbuild replaces only the upstream webpack build/serve pipeline; component sources are copied unchanged before the declared mutation. Two SENTINEL-authored Vitest reducer smoke tests provide a conventional green-test baseline. They are **not** the upstream Cypress suite. No claim that the full upstream suite misses these regressions is made.

## What the cases establish

The API corpus distinguishes exact JSON response regression from status-only success, rejects a key-validation bypass and accepts a correct repair and benign identifier refactor. The browser corpus distinguishes observable input trimming from a reducer-only test result, rejects an incomplete spaces-only repair, and accepts the actual upstream component and a benign callback rename.

An intentionally inadequate but confirmed contract checks only the heading while claiming the input-trimming objective. It is expected to pass the narrow check and miss the real defect. This records the unavoidable dependence on truthful human approval; it is not counted as a defect-detection success. A separate unconfirmed-coverage case must remain UNVERIFIED. An application-start failure must be ENVIRONMENT FAILURE even when the tests pass.

Results should be reported as counts for this finite corpus. The two real public applications are not a representative sample of all web frameworks. The cases do not measure hostile code containment, authentication flows, databases, browser timing distributions, or general model productivity. Existing trustbut/Stryker comparisons in `benchmarks/public/measurements` concern the earlier function corpus, not these web applications. The new runner must not silently reuse those numbers as web-tool comparisons.

## Changes to upstream source

`prepare.mjs` is the complete adapter and mutation recipe. It copies originals to temporary Git repositories and records source hashes before verification. The approved expectations are literal ground truth in `contractFor`; they are not inferred from a candidate. Correct-repair cases start with the seeded defect and restore original upstream implementation bytes. Refactor cases preserve behavior. A whole original source tree and dependency environment are not redistributed as a disguised independent project.

## Executed results

The [measured results](measurements/RESULTS.md) contain the first completed v1.0.0-rc.1 run, same-source trustbut/Mocha comparison, and two actual CLI replays after source-checkout removal. Measurements apply to the recorded runtime hashes; final release CI must validate the release candidate independently.

To reproduce the optional same-source comparison:

```sh
node benchmarks/web/compare.mjs --allow-local --out=/tmp/sentinel-web-comparison
```

To replay retained API/browser source after optionally removing only the benchmark's disposable original checkouts:

```sh
node benchmarks/web/replay.mjs --allow-local --results=/tmp/sentinel-web-results.json --remove-originals --out=/tmp/sentinel-web-replays.json
```

The [authenticated direct-agent and complete ordinary-summary control](../../docs/V1-AGENT-COMPARISON.md) is separate from this scripted corpus. It uses the same approved Express task and records successful baselines without inferring a productivity advantage.
