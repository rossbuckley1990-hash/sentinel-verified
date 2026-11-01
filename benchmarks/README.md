# SENTINEL evaluation corpus

```sh
npm ci
npm run build
npm run benchmark
```

The benchmark executes **15 code-change cases** and **5 continuity/integrity scenarios**. Each code-change verification runs twice. Expected checks and outcomes are declared in [`cases.json`](./cases.json), independently of the candidate implementation. Three cases form a public held-out set from distinct price, array and string-validation domains. The source-rewriting attack was added to the development set after adversarial review and is not described as held out.

Outputs go to `benchmark-results/latest/`:

- `RESULTS.md`: readable measurements and limitations.
- `results.json`: machine-readable metrics, per-case outcomes and receipt hashes.
- `store/`: content-addressed source, contract and receipt objects.
- `continuity-store/`: actual interrupted and resumed sessions, including their checkpoints and evidence.

An expected-outcome mismatch, replay disagreement or failed continuity scenario produces exit code 1. Unexpected verifier infrastructure failure cannot count as a successful detection. Synthetic fixtures are not attributed to a third-party coding agent.

For the optional StrykerJS comparison, run `node benchmarks/stryker.mjs`. It installs exactly StrykerJS 10.1.1 and Vitest 5.0.5 into a disposable temporary directory and records the configuration, tool versions, output and dependency lockfile. This comparison requires network access for installation; the main benchmark needs none after `npm ci`.

See [methodology and measurements](../docs/BENCHMARKS.md), [recorded Stryker comparison](./measurements/stryker.json), and [recorded release evaluation](./measurements/release.json). The original measurement machine was Apple Silicon macOS. Re-run locally rather than treating those timings as a guarantee for your machine.
