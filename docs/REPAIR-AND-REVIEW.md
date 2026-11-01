# From a contradicted requirement to reviewable code

`sentinel run "objective"` and `sentinel continue` allow one automatic repair by a real coding agent after independent checks produce a reproducible requirement contradiction. Use `--repairs 0` to disable repairs or `--repairs 2` / `--repairs 3` to set a larger bounded budget. The budget applies to that invocation, after its initial agent stage.

A repair receives the requirement identifier, expected and observed results, the failing input where supported, any valid reduction and the original receipt identity. It receives the same protected contract. Every attempted implementation and verification receipt remains in the session history; a later successful repair does not erase the original failure.

Automatic repair stops when the agent is interrupted or fails, the evidence is stale, verification is incomplete, an environment fails, review is required, the agent makes no source changes, or the attempt limit is reached. An unresolved task remains inspectable and resumable. This is not an autonomous unlimited retry policy, and approval criteria never change as part of repair.

Controlled demonstration adapters default to zero automatic retries. Demonstrations can explicitly select and label a deterministic repair adapter; they are never represented as model executions.

## Review and transfer the implementation

```sh
sentinel export --patch --out change.patch
```

This creates a Git patch from the exact captured baseline and candidate, including binary content, additions, deletions and executable-file modes. It checks that the patch applies to a disposable copy of the captured baseline and reports whether the original checkout still has that source. It does not modify the original checkout, stage files or merge code. An existing output file is never overwritten.

Inspect the patch, then explicitly apply it in the intended repository when satisfied:

```sh
git apply --check /path/to/change.patch
git apply /path/to/change.patch
git diff
```

If the original checkout changed, use the recorded baseline or resolve conflicts through the normal Git workflow. Passing the baseline apply check does not establish that a later checkout remains compatible. An interrupted or partially verified implementation can still be exported, but its verification status is reported as unverified.

Patch construction uses raw source objects with external diff tools, filters, hooks and global Git configuration disabled. It does not run candidate code. Exports are bounded to 20 MB and use Git's executable-bit semantics; arbitrary Unix permission changes are not represented by Git patches.

## Receiving-agent context

The bounded context package carries source and contract identities, changed-file hashes, dependency manifest identities, runtime and runner details, approved functions and application scenarios, unresolved scope, current versus historical check results, retained counterexamples, and next actions. It points to the complete protected contract when inline text is truncated. The saved package is exactly the visible input sent to the receiving CLI. An acknowledgement establishes only that the agent emitted the requested line; it is not independent verification, and no private model reasoning is transferred.
