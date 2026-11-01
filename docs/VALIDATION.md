# v0.1 release validation

These historical measurements remain unchanged. See [v0.2 validation](V0.2-VALIDATION.md) for the current release candidate.

Measured on 1 November 2026. These are observed results, with their scope stated explicitly.

| Check | Result |
| --- | --- |
| TypeScript strict build | Passed |
| Automated tests | 36 passed across 7 files |
| Adversarial code cases | 15/15 expected outcomes; 12/12 problems flagged despite green ordinary suites |
| Legitimate changes | 3/3 accepted; zero false-positive flags in this small subset |
| Evidence reproduction | 15/15 semantic outcomes agreed on repeat execution |
| Continuity / integrity benchmark | 5/5 scenarios passed |
| Dependency audit | Zero reported production advisories |
| Public fresh clone + empty npm cache | First meaningful result in 6.002 seconds; entire install/build/demo in 8.583 seconds |
| Live Codex adapter | Authenticated Codex 0.163.0 repaired the controlled project; independent checks passed |
| Live Claude adapter | Unverified: CLI 2.1.301 installed but no authentication on release machine |
| HTML report | Generated; escaping, CSP, content and atomic-write tests passed. Browser visual inspection was unavailable in this environment. |

The fresh-install measurement starts before cloning the public repository, then runs `npm ci`, `npm run build` and the demo. It used Apple Silicon macOS, Node 26.12.0, npm 11.20.0 and Git already installed. The npm cache was empty. It is one measured trial, not a reliability estimate or an installation-speed guarantee. Prerequisite installation and obtaining a network connection are excluded. The under-90-second target was met for this tested setup. [Exact commands, timings and tested commit](fresh-install.json).

The fresh-clone test used candidate commit `7425e64f7139bb539714800a3238bebe36156199`; the subsequent measurement-documentation commit changes no implementation. GitHub CI tests the final commit on macOS/Linux with Node 22 and 24. See [live CI results](https://github.com/rossbuckley1990-hash/sentinel-verified/actions/workflows/ci.yml) for the authoritative status rather than assuming that local success establishes CI success.

The actual terminal excerpt is [demo.svg](demo.svg), generated from [demo.txt](demo.txt) by `node scripts/capture-demo.mjs`. Absolute store paths are redacted; observed results and timings are retained. The captured demo took 6.004 seconds; a separate first result appeared at 3.205 seconds from demo start. Installation is excluded from that capture.

[Benchmark measurements](../benchmarks/measurements/RESULTS.md) include conventional Vitest execution and a separate, measured StrykerJS 10.1.1 comparison. [Live adapter evidence summary](live-agent-validation.json) distinguishes actual model execution from protocol tests and deterministic fixtures. Portability tests export, delete the original source/store, import elsewhere, reset consent and continue successfully. Tampered or missing evidence fails closed.

This release supports bounded local advisory verification of existing deterministic exported JS/TS functions. It does not provide hostile-code isolation, complete semantic correctness, inaccessible model-context transfer, browser application verification, hermetic dependency archives or a remote merge gate. Authentication is required for commercial agents. The core demo and deterministic continuation require none.
