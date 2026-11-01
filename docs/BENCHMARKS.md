# Reproducing the evaluation

Run `npm ci && npm run build && npm run benchmark`. The command executes the implementations, ordinary Vitest tests, preserved tests and independent acceptance checks. It writes `benchmark-results/latest/results.json`, `RESULTS.md`, and a content-addressed evidence store. It exits nonzero if an expected classification fails or repeated verification disagrees.

The benchmark is entirely local and uses the clearly identified trusted fixtures in [`benchmarks/cases.json`](../benchmarks/cases.json). It does not invoke commercial agents. The original 14 expected outcomes were authored before running the implementation. A fifteenth development case was added after adversarial review identified execution-time source rewriting; it is explicitly excluded from the held-out set. Three cases use distinct held-out price, sorting and slug domains. They are public, not a blind external evaluation.

Each case creates a clean Git repository, commits a baseline, applies a candidate and supplies a separate contract. Candidate ordinary tests constitute the conventional test-only baseline. The exact runtime, Vitest version and corpus SHA-256 appear in the generated report. Execution time uses the monotonic duration recorded by the verifier. Each verification runs twice; reproduction compares statuses, inputs, outputs and reduced counterexamples while ignoring timestamps and temporary paths.

The corpus covers removed tests, equality weakened to substring matching, canned response replacements, hardcoded outputs, malformed inputs, a legitimate fix, unrelated behaviour drift, benign refactors, skipped tests, CI command bypass nontermination and a test that rewrites the implementation while it executes. Five additional measured scenarios exercise interruption, cross-adapter continuation, missing checkpoints, corrupted checkpoints and protected contract corruption. The same mechanisms also have integration tests in `test/session.test.ts`.

## Interpreting the numbers

A detected problem is a contradiction, environment failure or review signal. A changed test or CI definition may legitimately require review; it is not proof that an agent cheated. The false-positive denominator contains only the legitimate fix and refactor cases. The green-test count is the number of problem cases whose ordinary candidate tests pass but whose independent verification surfaces the problem.

The timing comparison is intentionally asymmetric: SENTINEL does additional work (baseline execution, preserved tests, independent behavioural checks and targeted mutations). Ordinary timing counts only candidate Vitest execution. Double execution for reproducibility is extra and excluded from the one-pass total.

This is a small synthetic corpus. A good result demonstrates the listed capabilities; it does not establish universal correctness, benchmark leadership, production safety or generalisable detection rates. No result from a named coding agent is inferred.

## Existing tools

[Vitest](https://vitest.dev/guide/cli) is the directly measured conventional test baseline. [StrykerJS](https://stryker-mutator.io/docs/stryker-js/usage/) mutates implementations and measures how well the selected tests detect those mutants. That evaluates test strength rather than authorisation of behavioural changes or portable continuation. SENTINEL's bounded targeted mutations are much narrower than Stryker's engine. Neither product proves arbitrary program correctness. A comparative Stryker experiment, when run, is documented with its exact configuration separately; no unmeasured superiority claim is made here.

## Measurements

The generated `RESULTS.md` is the authoritative local result. Release measurements are copied into this document only after execution; no performance or accuracy target is asserted from design alone.

### Measured StrykerJS comparison

On 1 November 2026, Apple Silicon macOS with Node 26.12.0, StrykerJS **10.1.1** and Vitest **5.0.5**, the controlled coercive age function (`return age >= 18`) passed its two numeric visible tests in **0.553 seconds**. Stryker killed all **5/5 generated mutants**, for a **100% mutation score**, in **2.203 seconds**. A direct independent call still returned `true` for the string `"18"`, contrary to the separate requirement that ages must be integer numbers.

This is a concrete example of a coverage gap in the selected test oracle; a high mutation score is not a specification-completeness claim. Stryker could expose different defects or score differently with more tests or another configuration. SENTINEL receives an additional approved type requirement, so this is not an equal-information accuracy contest. It demonstrates complementary capabilities, not superiority.

Reproduce with `node benchmarks/stryker.mjs`. That optional experiment needs network access to install pinned tools into a temporary directory, then removes the directory. Configuration uses the command runner, `src/access.js` as the mutation target, concurrency 1, coverage analysis off and a 10-second timeout. The recorded summary is [`benchmarks/measurements/stryker.json`](../benchmarks/measurements/stryker.json); reruns retain the complete mutation report, stdout and dependency lockfile under `benchmark-results/stryker/`.

### Measured SENTINEL evaluation

On 1 November 2026, Apple Silicon macOS, Node v26.12.0, Vitest 5.0.5: **15/15 expected code-case outcomes matched**, with **12/12 problem cases detected**, **0/3 false-positive flags on legitimate fixes/refactors**, and **15/15 semantic replay agreement**. All 15 candidate ordinary suites exited successfully; the conventional test-only baseline detected 0/12 problem cases. SENTINEL surfaced 12 of those green-test problems.

One verification pass across all 15 cases took **26.60 seconds**, versus **6.46 seconds** for the ordinary candidate Vitest executions alone. Replaying all cases for evidence agreement approximately doubles verification work and is excluded from that one-pass total.

All **5/5 continuity/integrity scenarios passed**. The deterministic interruption checkpoint was preserved in **205 ms**, and the second adapter resumed, fixed and independently verified it in **2482 ms**. Corrupted checkpoints, missing checkpoints and changed protected contract objects were each rejected. These are controlled adapter runs, not live model continuity measurements.

The detailed [result table](../benchmarks/measurements/RESULTS.md) and [machine-readable record](../benchmarks/measurements/release.json) include exact per-case classifications, timings, source-corpus hash and receipt hashes. Receipt objects and source snapshots live in the local benchmark output store and are regenerated by running the command; the public summary does not publish machine-specific paths or test stdout.
