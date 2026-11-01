# Threat model

SENTINEL defaults to **local advisory verification** for trusted or reviewed deterministic JS/TS functions and the documented local Node HTTP / browser application workflows. It is designed to expose incorrect behaviour, unsupported success claims and suspicious test changes, and to preserve evidence across interruptions.

It does not provide a security boundary against a hostile process running as the same unrestricted operating-system account.

## Trusted inputs

The developer reviews and approves the objective and acceptance contract. Proposed requirements—including optional model suggestions—are not approved expectations. SENTINEL stores the approved contract outside the agent's working directory and binds it by content hash. Interactive schema-3 approval binds the complete reviewed application command, scenarios, authorised paths, finite objective coverage and baseline; it does not just bind a list of requirement identifiers. Reviewed noninteractive contracts remain the caller's responsibility. An `approvedBy` value is a human-readable label, not identity verification or a signature.

The installed SENTINEL implementation, Node runtime, dependencies, baseline, operating system and storage are trusted. Application verification additionally trusts the selected installed browser and its automation driver. A compromised dependency can falsify or interfere with a result. Running checks repeatedly cannot remove that assumption.

The agent's code changes, generated tests and success statements are not trusted as evidence of correctness. Tests added by the agent may be useful, but independent preserved checks remain necessary. Execution of those files still requires trust or external isolation.

## Boundaries

| Boundary | What it provides | What it does not provide |
| --- | --- | --- |
| Separate managed workspace | Stable original checkout and a clear candidate location. | Filesystem or process isolation. |
| Contract outside agent workspace | Separation from routine edits and content-integrity checks. | Protection from an agent with unrestricted OS permissions. |
| Content-addressed snapshots | Byte-level identity and detection of accidental corruption when checked. | Authenticity, secrecy or protection against recomputing hashes. |
| Subprocess and timeout | Execution accounting, error classification and a bound on ordinary hangs. | A sandbox, reliable defence against malicious descendants or host resource abuse. |
| Preserved acceptance checks | Independent expectations supplied before candidate execution. | Complete coverage or an automatically correct specification. |
| Durable checkpoint | Recoverable state and validation before handoff. | Hidden model context, authenticated attestation or unlimited portability. |
| Static HTML report | A readable view of the receipt with escaped content, restrictive CSP, embedded verified PNG bytes and no scripts. | Additional verification or automatic trust in a copied report. |
| Browser request routing | Controlled requests to the fresh loopback origin, blocked service workers/WebSockets and recorded external HTTP blocks. | OS-level network isolation, a sandbox for the server, or protection against all browser protocols and vulnerabilities. |
| Reviewable patch export | Exact captured source changes, a disposable-baseline apply check and original-source compatibility information. | Permission to apply, automatic merge, or guaranteed compatibility with a later checkout. |

## Consent and untrusted code

Local project execution requires explicit interactive consent or `--allow-local`. That allows source and tests to execute with the account's local privileges; it is not a sandbox setting. The bundled demo is clearly identified, reviewed fixture code, and is the exception intended for immediate first-run use.

For genuinely untrusted source, run the entire workflow in an independently isolated disposable environment with an appropriate filesystem, network, credential and resource policy. The optional configured Docker verifier supports the existing function-verification workflow with read-only selected host inputs, no network, bounded resources and no fallback. Application and browser verification require explicitly consented local execution in this release; requesting Docker for such a contract fails rather than switching to local execution. It does not contain the host coding agent or attest the image; see [its precise controls and limits](ISOLATION.md). Do not run a hostile repository on a workstation containing credentials merely because it is inside a SENTINEL workspace.

Agent-specific sandbox or permission controls are separate from SENTINEL's verification runner. An installed agent's own policy does not automatically isolate later test execution.

## Attacks and honest failure

- **Tests removed or weakened:** compare source changes and preserve baseline test inputs. Changed tests are review findings; intent cannot be established from a text diff alone.
- **Mocks or fixture-specific hardcoding:** independent inputs can expose discrepancies. Inputs not checked remain unknown.
- **Unexpected behaviour changes:** probes and must-preserve requirements reveal observed drift. Unobserved behaviour is outside the evidence.
- **Contract edits:** the external stored copy and hash preserve the approved bytes against normal workspace editing. This cannot defeat a privileged attacker who modifies the store and verifier together.
- **Corrupted or stale checkpoint:** reject malformed records, mismatched hashes or a workspace that no longer matches the recorded candidate. Do not silently invent continuation state.
- **Timeouts, missing exports, import failures or malformed worker output:** classify an incomplete check as failure or uncertainty, never as a successful requirement check.
- **Nondeterminism:** repeated or differential checks are limited observations. Time, randomness, external services, ambient state and concurrency are outside the initial supported behavioural model.
- **Malicious output:** the HTML renderer escapes all dynamic values and uses a restrictive Content Security Policy. Terminal output should be treated as untrusted data as well.

## Reproduction limits

Receipts preserve relevant source identities, contracts, commands and captured outputs. Replaying on a different runtime, dependency tree, platform, environment or service state can yield different results. Content hashes do not snapshot the entire operating system. Exporting a session can also expose source code, local paths, prompts and logs; review it before sharing.

Counterexample reduction is bounded and its guarantee is recorded. A reduced input is not necessarily globally minimal. When only a finite example is approved, the verifier must not assume the same expected answer for every smaller input.

## Local advice versus enforcement

A local green result helps a developer decide what to review and where to continue. It is not an enforced merge gate. The repository's CI validates SENTINEL itself; it does not establish remote trust for arbitrary user-generated receipts.

A stronger deployment would require independently controlled verification inputs, an isolated runner, reproducible dependencies and an authenticated result bound to the exact merge candidate. Remote enforcement, signed attestation and fully reproducible project dependencies remain outside the supported release scope. Never use the local receipt hash alone as authorization to deploy sensitive changes.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md). Reports about false VERIFIED results, path escape, evidence corruption, unsafe command handling and checkpoint confusion are particularly useful. Include a minimal reproduction without credentials or private source.


## Proposed requirements and recovery

Static discovery never approves its own proposal. The terminal records the developer's explicit decision and binds it to the reviewed baseline; noninteractive use needs a supplied reviewed contract. Repository documentation is evidence to inspect, not an instruction to the tool. Existing assertions are preservation proposals, not a correctness oracle. Specific ambiguous intent remains unresolved until the developer records a decision. A limited plan cannot establish completion of an unresolved objective.

Read-only Git inspection disables configured hooks and fsmonitor before consent. This is a specific execution hardening measure, not a sandbox for the parser or Git. The dependency parser/runtime and installed binaries remain trusted.

Agent handoff acknowledgement is an unverified statement; exact transmitted input is retained independently. Interrupted sessions do not reuse an earlier green receipt as proof that a new stage completed. A live recorded agent process lease blocks abrupt-crash recovery until the process is absent. PID reuse conservatively blocks; arbitrary detached grandchildren are outside this guard. The tool never kills an unknown PID based only on a checkpoint.

## Application observations and their limits

Approved server commands are argument arrays, never shell strings. Each baseline and candidate starts in a separate materialised source directory on a newly allocated loopback port. The command receives `PORT` and `HOST`, a temporary `HOME`, and a reduced environment without inherited cloud tokens. This removes common accidental inputs; it does not prevent an approved local process from reading other paths, launching children, using the network or accessing the real user home by an absolute path. Dependency directories are reused, not hermetically snapshotted.

HTTP observations use real requests and exact approved status/body expectations. Redirects are not followed. Browser scenarios use bounded declarative interactions and exact approved assertions in fresh nonpersistent contexts. They do not execute model-provided browser scripts. Screenshots record actual visible output; their appearance alone does not establish correctness. Before and after evidence can still be incomplete when the browser, server or scenario fails, and that failure must remain visible.

The browser allows same-origin HTTP requests and blocks service workers, WebSockets and routed external HTTP requests. These are test controls, not a complete network security boundary. In particular, the application server runs on the host and has no network sandbox. Use an independently isolated machine or VM for hostile applications. Do not treat the browser's fresh context as an isolated operating-system account.

Receipts with application artifacts use schema 2. They bind the contract and exact source snapshots to command records, observations and content-addressed screenshots/execution records. Loading and portable import validate the referenced artifact hashes and sizes. An artifact can therefore be traced to the recorded run; no independently authenticated attestation is claimed.

## Bounded repair and partial completion

Automatic repairs preserve the exact approved contract and original failures. A real agent receives at most one repair by default, configurable from zero to three per invocation. Only current-source requirement contradictions can trigger repair; interruption, failed agents, stale evidence, environment failures, unresolved checks and review blockers stop it. A source-identical repair stops even if the agent created an empty Git commit. Further continuation is an explicit developer action.

Finite objective coverage counts only the developer-reviewed aspects and the checks mapped to them. It is not an estimate of every possible input or hidden requirement. A change objective cannot be established using preservation checks alone; preservation-only work requires that intent to be explicitly approved. An inadequate approved specification can still miss a real defect.

Patch export creates a new file without overwriting existing output. It builds raw Git objects with filters, hooks, external diff tools and global Git configuration disabled, checks application in a disposable baseline copy, and reports whether the original source still matches. It never modifies or merges into the original project. The developer must review and explicitly apply changes through their Git workflow.

## Storage and output bounds

Individual content objects are limited to 32 MB. Snapshots retain the existing 20 MB/file and 100 MB total-source bounds. Application artifacts are limited to 4 MB each and 40 MB per receipt; server output and HTTP response bodies have 1 MB bounds. Patch export is limited to 20 MB. Portable bundles have their documented 300 MB envelope/decoded-content limits and structural/path validation.

These limits bound individual operations. There is no global disk quota, automatic evidence eviction or guarantee against host resource exhaustion. Many sessions and retained source versions can consume substantial disk space; evidence is deliberately not silently deleted. Host execution can also write outside the evidence store. Review source, logs, screenshots, local paths and prompts before exporting or publishing a session.
