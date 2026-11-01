# Design decisions

1. Version 0.1 supports deterministic exported JS/TS functions and JSON values, with Vitest as the ordinary test runner. Browser, distributed and nondeterministic applications are outside this release's scope.
2. The verifier is separate from the agent. Approved declarative contracts, immutable-by-content file objects, receipts and checkpoints live outside its workspace. SHA-256 detects accidental corruption; it does not authenticate records against a hostile OS account.
3. Local execution is advisory and requires explicit consent. No worktree, Node worker, or timeout is represented as a security boundary. Use an externally isolated disposable machine for untrusted source. This release will refuse execution without consent; it does not ship an isolation runner.
4. Continuation sends versioned, bounded evidence context and preserves source files. It does not transfer hidden reasoning or treat an agent narrative as evidence.
5. Controlled fixture adapters provide an offline reproducible interruption/handoff test. Codex and Claude adapters are separate integrations with capability checks against installed help output.
6. Status means the scope of the executed check only. Passing sampled cases cannot establish universal correctness, complete intent coverage, or uniqueness of this design.
