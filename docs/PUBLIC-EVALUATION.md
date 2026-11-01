# Public-project evaluation

This evaluation asks whether additional, independently specified behaviour catches defects that the project's tests omit. It also deliberately includes a contract that misses a known defect. These are nine labelled cases from two small public projects, not a representative sample of production repositories or an estimate of general detection accuracy.

## Provenance and independence

The original 15-case corpus in `benchmarks/cases.json` remains unchanged, with its existing development/held-out labels. The separate public corpus is [`benchmarks/public/cases.json`](../benchmarks/public/cases.json). Its expected outcomes, candidate transformations and classifications were fixed before execution; [`provenance.json`](../benchmarks/public/provenance.json) records that definition's SHA-256 and hashes every vendored upstream file. The runner refuses changed sources or case labels. This guards accidental drift, not a hostile maintainer rewriting both source and manifest.

| Project | Pinned source | Requirement basis | Candidate provenance |
|---|---|---|---|
| is-number 2.1.0 | `204c885659b8ee1946534c61db91603b9a16d661` | [Historical issue #3](https://github.com/jonschlinkert/is-number/issues/3) and [upstream fix](https://github.com/jonschlinkert/is-number/commit/12749e3c411750f754d50f093471234c7ab270b0) | Historical buggy implementation, exact corrected `index.js`, a comment-only non-fix and a labelled incomplete repair |
| normalize-path 3.0.0 | `52c3a95ebebc2d98c1ad7606cbafa7e658656899` | [Pinned documentation](https://github.com/jonschlinkert/normalize-path/blob/52c3a95ebebc2d98c1ad7606cbafa7e658656899/README.md) and [upstream assertions](https://github.com/jonschlinkert/normalize-path/blob/52c3a95ebebc2d98c1ad7606cbafa7e658656899/test.js) | Seeded regressions and a benign local-variable rename; no claim these are upstream bugs |

Both projects use MIT licences. Their complete licence texts, original implementation, tests, package metadata and README are retained under `benchmarks/public/projects/`. Minimal archived runtime/test dependencies `kind-of` 3.0.2, `is-buffer` 1.1.6 and `minimist` 1.2.8 are retained with their MIT licences under `dependencies/`. The case study needs no network access after SENTINEL installation.

Both original projects use Mocha. SENTINEL's supported execution framework is Vitest, so the evaluation adds an explicitly labelled registration adapter: it imports Vitest's `describe`/`it`, establishes CommonJS `require`/`__dirname`, and removes the Mocha bootstrap import. Original assertion bodies and fixtures are unchanged. The untouched original `test.js` is retained and independently executed with Mocha in the comparison. This is not a claim that historical upstream CI ran on Vitest, Node 26, or today's Mocha.

The upstream issue supplies the expected results independently of the candidate. Whitespace-only strings must be rejected, numeric strings with surrounding whitespace must remain accepted, and ordinary numeric inputs must be preserved. A one-space input is a compact counterexample; this evaluation does not claim universal input minimisation. Original tests include current dates in names, so replay agreement means equal semantic check outcomes and counterexamples, not byte-identical timestamps or receipt hashes.

## Reproduce

From a source checkout after `npm ci`:

```bash
npm run build
node dist/public-benchmark.js
```

The normal deadline is 30 seconds per verification command. The recorded run on an overloaded host uses `node dist/public-benchmark.js --timeout-ms 120000`; this changes execution bounds only. The exact deadline, load averages and stable runtime hashes are recorded in the result. CI can repeat the same unchanged cases at the default deadline.

Each case runs twice. Output is `benchmark-results/public/results.json`, a readable `RESULTS.md`, and the content-addressed evidence store. Receipts bind source snapshots, contracts, executed commands and outputs. Temporary evaluation repositories are removed after execution. To replay a retained receipt after removal, use `node benchmarks/public/replay.mjs <receipt-hash> --allow-local` (take the hash from your generated `results.json`). This helper restores the pinned fixture dependencies and invokes the actual `sentinel replay` command; a contradicted result correctly exits 1, with an HTML report under `benchmark-results/public/store/reports/`. The benchmark deliberately executes the included, reviewed public project code locally; it is not hostile-code isolation.

For optional comparisons, install the exact tools into a separate directory:

```bash
npm install --prefix benchmark-results/public-tools --ignore-scripts --save-exact --no-audit --no-fund trustbut@0.7.0 mocha@11.7.5 kind-of@3.0.2 minimist@1.2.8 @stryker-mutator/core@10.1.1
node benchmarks/public/compare.mjs benchmark-results/public-tools/node_modules
node benchmarks/public/stryker.mjs benchmark-results/public-tools/node_modules
```

The comparison retains raw command records and trustbut receipts under `benchmark-results/public-comparison/`; Stryker retains its full mutation report and log under `benchmark-results/public-stryker/`. The exact tool package manifest and lock are included alongside the summaries; copy `comparison-package.json` to a separate tools directory as `package.json`, copy `comparison-package-lock.json` as `package-lock.json`, and use `npm ci --prefix <tools-directory> --ignore-scripts` for exact transitive dependency replay. These optional tool installations require network access and are not part of the offline core.

## Measured outcomes

Public summaries retain exact source/contract/receipt hashes and tool configuration; raw local receipts remain in the generated store. Absolute execution paths are omitted from published summaries. The publication-ready measurement files live in [`benchmarks/public/measurements/`](../benchmarks/public/measurements/). The table and totals below are generated from actual runs, not expected labels.

<!-- MEASURED_RESULTS -->

Measured 2026-11-01T14:52:43.545Z on darwin/arm64, Node v26.12.0, Vitest 5.0.5. Per-command SENTINEL timeout: 120000 ms. Final host load averages: 98.60 / 162.75 / 147.85. Runtime fingerprints were stable across the run.

| Case | Original Mocha tests | trustbut 0.7.0 | Specified SENTINEL check | SENTINEL overall |
|---|---|---|---|---|
| is-number-historical-nonfix | PASS | WARN — dependency warning | CONTRADICTED | CONTRADICTED |
| is-number-upstream-fix | PASS | WARN — change-not-proven | VERIFIED | VERIFIED |
| is-number-incomplete-repair | PASS | WARN — change-not-proven | CONTRADICTED | CONTRADICTED |
| is-number-narrow-contract-miss | PASS | WARN — dependency warning | VERIFIED | VERIFIED |
| normalize-path-benign-refactor | PASS | WARN — change-not-proven | VERIFIED | VERIFIED |
| normalize-path-trailing-regression | FAIL (5) | FAIL — change-not-proven, suite-failing, test-regressed | CONTRADICTED | CONTRADICTED |
| normalize-path-weakened-tests | PASS | WARN — tests-removed, assertions-removed, proofs-unmatched | CONTRADICTED | CONTRADICTED |
| normalize-path-unrelated-drift | FAIL (4) | FAIL — change-not-proven, suite-failing, test-regressed | REVIEW REQUIRED | CONTRADICTED |
| normalize-path-insufficient-intent | PASS | WARN — dependency warning | UNVERIFIED | REVIEW REQUIRED |

All **9/9 predeclared outcomes** matched and **9/9 semantic outcomes** agreed on replay. SENTINEL signalled **5/6 defective candidate/contract combinations**, with **1 deliberate specification miss**. It accepted **2/2 correct candidates** without a contradiction; this tiny count is not a population false-positive estimate. Original Mocha tests failed on two defective candidates. trustbut independently reproduced those two regressions and issued a specific removed-assertion warning for the weakened-test candidate.

The three additional green-ordinary-test contradictions are the unchanged historical whitespace defect, the incomplete whitespace repair and the regression concealed by removing trailing-slash assertions. The first two share one historical root bug; the third shares the trailing-slash regression already exercised in another case. Thus this establishes **one additional historical defect class**, not three new upstream bugs. The namespace difference is separately classified for review and also fails existing tests.

One-pass execution totals across nine cases: SENTINEL **161.778 s**; original Mocha **28.430 s**; trustbut **158.581 s**. These are observations under severe workload contention and different verification workloads, not a speed ranking.

StrykerJS 10.1.1: **{"Killed":22,"Survived":2}**, mutation score **91.67%**, **123.400 s**. Its original tests passed; the unchanged historical function still returned `true` for one space, where the issue requires `false`. The surviving changes (`+num` to `-num` and `>= 0` to `> 0` in `n - n + 1`) appear equivalent for the supported primitive numeric-classification domain. They are not counted as defects or assumed repairable coverage gaps. Stryker does not identify the issue-required whitespace result from those mutants.

<!-- END_MEASURED_RESULTS -->

The [post-cleanup replay measurement](../benchmarks/public/measurements/replay.json) also ran the actual CLI after the original temporary source checkout was absent. It preserved the source and contract hashes, reran 138 green ordinary test instances, and reproduced `isNumber(" ") === true` against the required `false`. The expected contradiction exited 1.

## What the comparison establishes

The full original is-number suite executes 138 test instances and misses the historical whitespace defect. SENTINEL receives a separately specified requirement from the historical issue. That extra oracle is why it can identify the defect; this is not an equal-information contest. Giving the same whitespace assertions to ordinary tests would also expose it. The useful mechanism is preserving an approved independent oracle and carrying the resulting counterexample forward.

The intentionally narrow-contract case receives only valid-value examples and omits whitespace. Its green scoped result demonstrates a real limit: requirements and finite examples can be incomplete. The runner records this as a known specification miss, not a success at detecting the objective's defect. A different missing-contract case explicitly leaves intent unverified. Neither the corpus match rate nor the correct-case acceptance count establishes general correctness.

[trustbut](https://github.com/isAlmogK/trustbut) 0.7.0 was executed on the same candidates with `verify --base <baseline> --head <candidate> --runner mocha --config <external-config> --json --receipt-json <receipt>`. The external config is `{ "runner": "mocha", "args": ["test.js"], "timeoutSec": 30 }`. It reruns original Mocha tests and reports removed assertions, regressions and missing change evidence. Its framework/language support is substantially broader than SENTINEL's present scope, and it does not require an approved behaviour contract to produce useful findings.

trustbut reports 77 distinct result IDs for is-number: the upstream generated test names repeat across values, whereas Mocha reports 138 executed instances. This counting difference is not a lost-test claim.

The archived package metadata also declares unused development tools (`benchmarked`, `gulp-format-md`) that the minimal comparison installation omits. trustbut correctly emits dependency warnings for them. These are neither defect discoveries nor false accusations. Its `change-not-proven` warnings for the correct fix/refactor likewise describe absent fail-before/pass-after tests, not a claim that the implementation is wrong. Generic WARN, an observed failing test, and a reproduced requirement contradiction are reported separately. The root name `test.js` is outside trustbut's default changed-test classifier; the Vitest adapter is classified, producing a `proofs-unmatched` warning in the removal case when the selected runner is Mocha. That limitation of this configuration is explicit, and no unexecuted stronger outcome is inferred.

[StrykerJS](https://stryker-mutator.io/docs/stryker-js/usage/) 10.1.1 mutates the same historical `index.js` and runs the original 138 Mocha test instances through its command runner, concurrency 1, coverage analysis off, timeout 10 seconds plus twice the initial runtime, and an outer 600-second bound. It measures test strength; a surviving mutant identifies a possible coverage gap, not the issue's expected behaviour. SENTINEL's constant-export negative controls are much narrower than Stryker's mutation analysis. The separate [v0.1 fixture measurement](BENCHMARKS.md#measured-strykerjs-comparison) remains available and is not relabelled public-project evidence.

[Treft's verification documentation](https://treft.dev/verification/) was inspected on 1 November 2026. It describes a hosted fresh-checkout verifier, restoration of original tests and network-disabled execution, with broader language and monorepo coverage. Its documented independently synthesized acceptance layer currently operates in its measurement lab. No authenticated Treft run was available in this environment; its public start route requires service access/GitHub connection. No defect count, speed, false-positive rate or direct performance ranking is assigned to Treft. A separate hosted verification environment can offer a stronger control boundary than local same-account advisory verification; its operational properties were not independently tested here.

## Limitations and failed attempts

This is an author-constructed, prelabelled public-project case study. It is independent of the bundled age-validation development fixture, not an external blind evaluation. Both projects are small CommonJS libraries maintained by the same upstream author. Several cases share a root defect, so six defective candidate/contract combinations are not six unique real-world bugs. The selected historical whitespace bug and seeded path regressions establish bounded examples only.

An initial harness run put archived dependencies in a directory named `dependencies` behind a `node_modules` symlink. Node resolves real paths, so `kind-of` could not find sibling `is-buffer`. SENTINEL reported environment failures for the independent calls; those results were excluded from performance/detection totals. The harness was corrected to use a real `node_modules` directory and the unchanged labels were rerun. This failure is retained here rather than silently presented as a successful first attempt.

The later run encountered host load averages above 200. A 30-second preserved-test deadline expired, and a separate Stryker attempt reached its original 180-second outer bound after the initial tests. Those incomplete attempts are retained in [`failed-attempts.json`](../benchmarks/public/measurements/failed-attempts.json). The final measurements increase execution deadlines only, leaving cases and behavioural expectations unchanged. A shell sandbox initially blocked Stryker’s local logging server; the authorised retry ran outside that shell restriction.

Timing is wall-clock time on one development machine, with warm installed dependencies. SENTINEL runs baseline, candidate and preserved tests, independent behaviour calls and negative controls; ordinary time is one candidate Mocha run, and trustbut/Stryker execute different work. Replay doubles SENTINEL verification work but the one-pass total excludes that second run. Installation time and manual contract-authoring effort are not in these execution totals. Small denominators and configuration differences make general percentage superiority claims inappropriate.
