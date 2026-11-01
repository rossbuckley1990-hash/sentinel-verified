# Threat model

SENTINEL 0.1 provides **local advisory verification** for trusted or reviewed deterministic JS/TS source. It is designed to expose incorrect behaviour, unsupported success claims and suspicious test changes, and to preserve evidence across interruptions.

It does not provide a security boundary against a hostile process running as the same unrestricted operating-system account.

## Trusted inputs

The developer reviews and approves the objective and acceptance contract. SENTINEL stores the contract outside the agent's working directory and binds it by content hash. An `approvedBy` value is a human-readable label, not identity verification or a signature.

The installed SENTINEL implementation, Node runtime, dependencies, baseline, operating system and storage are trusted. A compromised dependency can falsify or interfere with a result. Running checks repeatedly cannot remove that assumption.

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
| Static HTML report | A readable view of the receipt with escaped content and no scripts. | Additional verification or automatic trust in a copied report. |

## Consent and untrusted code

Arbitrary project execution requires explicit `--allow-local` consent. That allows source and tests to execute with the account's local privileges; it is not a sandbox setting. The bundled demo is clearly identified, reviewed fixture code, and is the exception intended for immediate first-run use.

For genuinely untrusted source, run the entire workflow in an independently isolated disposable environment with an appropriate filesystem, network, credential and resource policy. Version 0.1 does not provision or attest such a runner. Do not run a hostile repository on a workstation containing credentials merely because it is inside a SENTINEL workspace.

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

A stronger deployment would require independently controlled verification inputs, an isolated runner, reproducible dependencies and an authenticated result bound to the exact merge candidate. That infrastructure is outside version 0.1. Never use the local receipt hash alone as authorization to deploy sensitive changes.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md). Reports about false VERIFIED results, path escape, evidence corruption, unsafe command handling and checkpoint confusion are particularly useful. Include a minimal reproduction without credentials or private source.
