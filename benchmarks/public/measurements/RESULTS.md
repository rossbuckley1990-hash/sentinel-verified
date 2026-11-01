# Public-project measured results

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
