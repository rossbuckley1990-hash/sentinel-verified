# One real task: SENTINEL, direct Codex and an ordinary summary

Both SENTINEL and a direct Codex attempt completed the same approved Express feature. A well-written ordinary summary also carried the completed implementation into a fresh Codex context successfully. **This experiment does not demonstrate a SENTINEL productivity advantage.** It does demonstrate that SENTINEL's verification and recovery records correspond to working software, while retaining a meaningful successful baseline.

## Task and approval

The task adds `code: "INVALID_API_KEY"` to invalid-key JSON responses on `/api/users` and `/api/repos`, while preserving the missing-key 400 response and valid-key user list. The source is the MIT Express web-service example at commit `1c6f1b0fe4000977b9a7b4f34097e4d527dd9824`, adapted only for an installed Express package and a controlled loopback server. The original eleven Mocha/Supertest assertions are preserved, with an explicit callback-registration adaptation for Vitest.

One human approval answer was forwarded into two actual CLI decisions: approve the criteria and allow local execution. The operator populated four HTTP scenarios in the product interface. This is not a measurement of wholly automatic interpretation or developer effort. The direct controls reused those exact approved criteria and the same baseline, without seeing the SENTINEL candidate in their initial prompt.

Approved baseline hash: `e09a095e999c533f7894f5c330515dc32384e28c8e730e3f2b07c85947ccae90`.

Approved contract hash: `5f11c8f47894bcd591aca727857eb5dea144b084d8529eaf215946a1ed17ab00`.

## Executed observations

The authenticated executable was Codex CLI 0.163.0, under its existing configured model. Node 26.12.0 ran on Apple Silicon macOS. Every completed implementation/handoff below was checked externally against the same four real HTTP criteria and eleven ordinary test instances. Agent claims about extra in-process assertions are not included in those independent counts.

| Stage | CLI subprocess seconds | Completed shell-command events | Nonzero command exits | Independent verification seconds | Outcome |
|---|---:|---:|---:|---:|---|
| SENTINEL initial implementation | 51.983 | 9 | 3 | 3.052 | VERIFIED |
| SENTINEL controlled interruption | 33.903 | 8 | 2 | — | INTERRUPTED; prior source/evidence retained |
| SENTINEL continuation | 66.193 | 12 | 3 | 5.283 | VERIFIED; exact implementation hash retained |
| Direct Codex initial implementation | 35.424 | 13 | 3 | 4.232 | VERIFIED |
| Ordinary summary, initial protocol | 27.286 | 5 | 2 | 5.515 | VERIFIED; implementation unchanged |
| Ordinary summary, complete protocol | 29.529 | 8 | 0 | 6.313 | VERIFIED; implementation unchanged |

These are recorded subprocess durations, not end-to-end developer times. Shell events can batch many operations and are not a count of atomic work. The workflows were sequential, not randomized or blind. Host load, model/service scheduling, cache effects and prompt differences were uncontrolled. The SENTINEL path intentionally includes an extra interrupted stage; summing it against an uninterrupted direct attempt would be misleading.

The direct attempt and SENTINEL agents encountered real sandbox restrictions: loopback listeners returned `EPERM`, and one direct Vitest attempt could not write its cache through the dependency link. The independently authorized verifier ran outside the coding-agent sandbox and successfully executed real HTTP requests and tests. The agents' in-process checks were not substituted for those observations.

## A strong ordinary-summary control

The final ordinary summary is published [as actually supplied, with path redactions](../benchmarks/web/measurements/ordinary-summary.txt). It includes the exact task, all four criteria, current source identity, all passing/failing independent results, changed paths, dependencies, limitations, unverified-claim distinction and next actions. The implementation is available in the same preserved workspace. It explicitly warns that repeated loopback checks inside the agent sandbox had already failed with `EPERM`; it does not omit that fact to manufacture repeated work.

The first summary retained the criteria and evidence but omitted this known agent-environment limitation. That run remains in the table and machine-readable record. Before publication, the omission was identified and one stronger summary was run on the unchanged implementation. The complete summary succeeded with no nonzero command events. No further variants were tried to favor an outcome.

This handoff followed a completed direct attempt, not a fabricated process crash. The separate SENTINEL path used a real SIGINT during a continuation **after the initial implementation was already verified**. It therefore demonstrates recovery of verified progress, not recovery of a claimed half-written feature. Its final source hash matches its first verified source hash: `b5e2d673c128394e3476c6fe54f1792e95072d5f68290c2be69f464da1fa771c`.

## Interpretation and reproduction

The measured task-completion observation is one successful task per implementation path, not a population Verified Task Completion Rate. Both ordinary summaries succeeded. SENTINEL's demonstrated value here is integrated independent execution, an inspectable patch, durable source/evidence identities and a recoverable checkpoint. This run establishes neither faster implementation nor superior reasoning or handoff effectiveness over a complete ordinary summary.

[Machine-readable records](../benchmarks/web/measurements/agent-comparison.json) include every stage, exact receipt/source/contract identities, redacted visible commands, exit codes and raw-record hashes. Full transcripts remain local. No private model reasoning is represented.

The optional comparator is explicitly authenticated and scoped to the documented four-criterion Express experiment. It can be rerun against a reviewed session using:

```sh
node benchmarks/web/direct-agent.mjs --allow-agent --allow-local \
  --store=/path/to/reviewed-store --session=SESSION_ID \
  --out=/tmp/sentinel-direct-control.json
```

It invokes Codex directly without SENTINEL's session/repair orchestration, then independently evaluates each outcome. The summary is prepared from actual recorded results and includes prior command failures. Current repetitions are new observations; they need not reproduce these timings or the exact implementation bytes.

## Improvement after measurement

The comparison exposed a product gap: the previous agent's truncated summary could omit specific sandbox failures. After recording the runs above, continuation context was improved to include up to three recent visible nonzero Codex command events with environment diagnostics. It labels them unverified tool observations and warns that permissions may differ after handoff; it does not turn those failures into code-verification claims.

Two focused regressions passed. Reconstructing the actual saved live checkpoint produced a 13,342-character package containing all four complete criteria and three prior EPERM failures, within the 16,000-character bound. [Measured context record](v1/context-improvement.json). No further model run or productivity improvement is claimed for this refinement.
