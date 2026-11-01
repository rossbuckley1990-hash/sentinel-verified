# What survives a handoff?

This is a small **controlled information-retention experiment**, not a comparison of coding models or a claim about developer productivity. It asks how many repository function executions a prescribed receiver performs when an already discovered counterexample survives—or is omitted from—a handoff.

The source is the pinned historical `is-number` implementation at commit `204c885659b8ee1946534c61db91603b9a16d661`, with the declared comment-only non-fix from the [public case study](../benchmarks/public/provenance.json). Its ordinary tests pass while the approved whitespace check fails. The experiment consumes an actual saved SENTINEL receipt, validates its content hash, source snapshots and approved contract, then reproduces the recorded failure. It refuses incomplete verification, a different source, unapproved expectations, or a failed replay.

## Declared protocol

All receivers have the same source and approved expectations. No model runs. The receiver follows prescribed inputs and does not interpret the natural-language objective.

| Handoff | Input selection |
|---|---|
| Saved evidence | Replay the recorded counterexample directly. |
| Summary omitting the counterexample | Check the declared preserved examples first, then the whitespace example. |
| Summary including the counterexample | Read the same example from a JSON line in the text summary and replay it. |
| Summary with reversed search order | Search the same examples backwards. |

The forward search is fixed in source: `0`, `37`, `"5e3"`, `"   56\r\n  "`, `"3a"`, `""`, `null`, `" "`. Every expected result must match the approved historical contract. An execution means one fresh Node process invoking the public function once. Previously verified examples repeated by a receiver are counted separately. Each arm runs three times. Timings are recorded for transparency; this is not a speed benchmark.

The repeated-exploration count specifically means previously passing acceptance examples checked again. Replaying the already known failing input counts as one repository execution but not as repeated exploration.

The baseline deliberately omits useful information. Its repeated search cost follows from that omission and the chosen ordering. An informed summary can contain the same example and eliminate the difference; searching whitespace first does the same. The experiment illustrates retention of concrete evidence, not a universal advantage over summaries. It excludes the original verification cost, ordinary-suite reruns, token consumption and human effort. Three identical deterministic trials are repeatability checks, not a statistical sample.

## Recorded result

The [published measurement](../benchmarks/public/measurements/handoff/results.json) was executed on 2026-11-01 using Node v26.12.0 on macOS arm64. It consumed the real historical failure receipt `918e45616612c3d06eca619c9baeaf1625f2b0799d35130ac290f9114baa9f2a`. All four arms reproduced `isNumber(" ") → true` against the approved expectation `false` in each trial.

| Handoff | Trial 1 executions | Trial 2 | Trial 3 | Previously passing examples repeated per trial |
|---|---:|---:|---:|---:|
| Saved evidence | 1 | 1 | 1 | 0 |
| Summary omitting counterexample | 8 | 8 | 8 | 7 |
| Summary including counterexample | 1 | 1 | 1 | 0 |
| Summary with reversed search | 1 | 1 | 1 | 0 |

There were 33 repository executions and 21 repeated passing-example checks in total. These results validate the stated protocol; the two controls demonstrate why they cannot establish general superiority over summaries. The host reported a one-minute load average above 180, so the recorded durations must not be used as evidence of a speed advantage.

The measurement ran the source entrypoint with `node --import tsx src/handoff-benchmark.ts`, `--allow-local`, the receipt and store shown above, and output directory `benchmarks/public/measurements/handoff`. The JSON contains the implementation hash, each invocation, its observed output and output hash, plus the exact approved contract bytes. Its SHA-256 is `51c1069ea7c236a8523dc2ace5661303100ecf98985578aea5b267d369fe4140`.

## Reproduce

After installation and `npm run build`, generate the historical receipt using the public benchmark:

```sh
node dist/public-benchmark.js --timeout-ms 90000
node dist/handoff-benchmark.js --allow-local
```

The second command uses `benchmark-results/public/results.json` to find the historical failure receipt. An existing content store can be selected explicitly:

```sh
node dist/handoff-benchmark.js --store /path/to/store --receipt RECEIPT_SHA256 --out benchmark-results/handoff --allow-local
```

This executes the reviewed, pinned public function and archived dependencies locally. Temporary directories are not a security boundary. No package installation, test configuration or model runs in the comparison itself. The earlier public benchmark has its own documented execution scope.

`benchmark-results/handoff/results.json` contains three trial traces, exact execution counts, observed values, commands and output hashes; the originating receipt, source and contract hashes; dependency identities; and explicit limitations. `approvedContractObjectBytes` preserves the exact original contract JSON string so its SHA-256 can be checked independently. Published measurements omit local filesystem paths. The original receipt remains independently inspectable in the local content store. Fresh receipts can have different snapshot and receipt hashes because repository identities and execution records include local paths and timestamps; the pinned implementation and approved contract identities are the portable comparison anchors.

The focused tests distinguish a simulated unit executor from the real public-function smoke test. Neither is described as a commercial-agent test. The published results above were generated by the real receipt-backed execution, separately from the unit simulation.
