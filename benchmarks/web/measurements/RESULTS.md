# Measured public web outcomes

Measured 2026-11-01T19:40:00.668Z on darwin/arm64, Node v26.12.0. Definitions and limitations: [methodology](../README.md). Label manifest SHA-256: `7c8e83838840c89fa3f5d515a2400e043a38318e9e1cee39654001c7d3fbfc01`. Runtime fingerprints were stable across this run.

| Case | Partition | Declared outcome | Observed outcome | Seconds |
|---|---|---|---|---:|
| express-unchanged-correct | development | VERIFIED | VERIFIED | 6.977 |
| express-error-message-drift | development | CONTRADICTED | CONTRADICTED | 6.218 |
| express-key-validation-bypass | held-out | CONTRADICTED | CONTRADICTED | 6.162 |
| express-correct-repair | held-out | VERIFIED | VERIFIED | 6.757 |
| express-benign-refactor | held-out | VERIFIED | VERIFIED | 8.661 |
| react-trim-regression | development | CONTRADICTED | CONTRADICTED | 27.178 |
| react-incomplete-trim-repair | held-out | CONTRADICTED | CONTRADICTED | 29.334 |
| react-correct-repair | held-out | VERIFIED | VERIFIED | 29.856 |
| react-benign-refactor | held-out | VERIFIED | VERIFIED | 15.677 |
| react-inadequate-approved-contract | held-out | VERIFIED | VERIFIED | 9.075 |
| react-unconfirmed-coverage | held-out | UNVERIFIED | UNVERIFIED | 5.340 |
| express-environment-failure | held-out | ENVIRONMENT FAILURE | ENVIRONMENT FAILURE | 2.816 |

Declared outcomes matched **12/12**. 4/5 defective candidate/contract combinations were signalled; 1 intentionally inadequate-contract miss remains visible. 5/5 correct candidates were accepted. These small counts are not population reliability estimates.

The new web changes are seeded and labelled. The genuine historical defect cases are in the retained function corpus; these results do not discover new upstream bugs. React ordinary checks are two authored reducer smoke tests, not the complete upstream Cypress suite.

## Same-source Express comparison

Versions: trustbut 0.7.0, mocha 12.0.3, supertest 7.3.1, express 5.3.0. Each Mocha run uses the same original eleven upstream assertions; trustbut receives no new response-body oracle.

| Case | Original Mocha | trustbut | Mocha seconds | trustbut seconds |
|---|---|---|---:|---:|
| express-unchanged-correct | 11/11; exit 0 | No-change refusal (exit 2) | 0.739 | 0.562 |
| express-error-message-drift | 11/11; exit 0 | warn | 0.659 | 1.623 |
| express-key-validation-bypass | 8/11; exit 3 | fail | 0.405 | 3.081 |
| express-correct-repair | 11/11; exit 0 | warn | 0.441 | 0.806 |
| express-benign-refactor | 11/11; exit 0 | warn | 0.274 | 0.791 |

The original suite catches the key-validation bypass. trustbut independently identifies its three test regressions without requiring an additional behavioural contract. Both retain a blind spot for the changed error message because the original tests check status only. Generic change-not-proven warnings also occur on correct and benign changes and are not counted as concrete defect detection. The unchanged source has no diff for trustbut to analyze and produces its documented no-change refusal; this is not counted as a semantic failure.

The lighter conventional suite/comparator workloads were faster in this observation. SENTINEL runs preserved tests, repeated external observations, snapshots and evidence capture. No speed ranking or general superiority is established. The recorded comparisons do not include React/Cypress or model productivity.

Full machine-readable measurements are alongside this file. Absolute temporary/checkout paths were redacted for publication; raw measurement hashes are retained.

## Retained-source replay

Two actual CLI replays succeeded after their disposable original source directories were removed: the corrected Express case remained VERIFIED, and the React trimming regression remained CONTRADICTED. Both preserved the exact baseline, candidate and approved-contract hashes. The pinned dependency runtime was supplied explicitly; dependencies are not claimed to be hermetically captured. See `replay.json`.
