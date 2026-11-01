# Agent integrations

SENTINEL owns the development session, evidence and source snapshots. An adapter edits a separate managed Git repository. Switching adapters starts a fresh model interaction with a bounded evidence context and the same source files; it does not import private reasoning or another provider's internal conversation history.

## Codex

The installed interface inspected during development was `codex-cli 0.163.0`. SENTINEL verifies the installed help advertises the capabilities it needs and invokes:

```text
codex exec --sandbox workspace-write --cd WORKSPACE --json -
```

The context is sent on standard input. Codex authentication and model configuration remain the user's. The adapter never requests `--dangerously-bypass-approvals-and-sandbox`. The Codex sandbox is distinct from SENTINEL's independent verification runner: this release's verifier is local advisory execution, not an isolation boundary.

Reference: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive). Installed help is the adapter's compatibility check; provider releases may change their interfaces.

## Claude Code

The installed interface inspected during development was Claude Code `2.1.301`. SENTINEL checks its help before invoking:

```text
claude --print --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep --tools Read,Edit,Write,Glob,Grep
```

The context is sent on standard input with the managed workspace as the current directory. The adapter intentionally offers file-reading and editing tools; SENTINEL performs the independent checks after the agent exits. It does not grant shell execution or bypass permission checks. User authentication remains necessary. Extensions and user configuration remain subject to the installed CLI's own rules; this is not a security boundary against an unrestricted hostile process.

## Offline fixture adapters

`fixture-broken`, `fixture-interrupt` and `fixture-fix` are deterministic test adapters, **not simulations of any named model's measured behaviour**. They only operate in a project with the explicit `sentinelFixture: "controlled-demo-v1"` package marker. The interrupted adapter leaves the faulty implementation and a durable checkpoint; the fix adapter replaces it with the specified corrected implementation. This makes handoff and recovery reproducible without a subscription or API key.

## Commands

With a reviewed acceptance contract outside the input repository:

```sh
sentinel run "YOUR EXACT APPROVED OBJECTIVE" --repo /path/to/project --contract /path/to/approved-contract.json --agent codex --allow-local
sentinel continue --agent claude
```

The first invocation records the explicit local execution consent for the session. Running `continue` reuses it. The original repository is retained: implementation changes live in the managed workspace reported by SENTINEL. Review and copy the changes back through your normal Git workflow. There is no automatic merge or remote merge gate.

## Durability and integrity

- Checkpoint envelopes in `STORE/sessions/ID/checkpoint.json` contain the complete machine-readable checkpoint and the hash of its historical content object. A single rename publishes a checkpoint atomically.
- `STORE/latest.json` selects the default session. Pass the session ID to select a different one.
- Contracts, source snapshots and receipts are content-addressed objects. Reading them checks their hashes. A valid local hash does not authenticate who created the content.
- A session lock prevents two live writers. Locks owned by dead processes can be recovered. Malformed locks require inspection; SENTINEL does not guess their owner.
- A stopped process's `running` checkpoint allows partial source edits to be captured as unverified. For changes made after an ordinary completed/interrupted checkpoint, `--adopt-changes` explicitly accepts the edits into a new unverified state before continuing.
- A missing or corrupted checkpoint is an error. Historical objects remain available for inspection; SENTINEL does not silently reconstruct a trusted narrative.
- Schema version 1 is explicit. Future incompatible formats must use a migration or reject the version. Hashes and original objects must be retained during migration.

## Validation status

Deterministic interruption, cross-adapter continuation, source-drift rejection, missing/corrupted checkpoint handling, protected-contract integrity and concurrent-writer handling are covered by automated tests. A real authenticated Codex CLI 0.163.0 run repaired the controlled age-validation repository and passed independent verification. Claude Code 2.1.301 was installed but not authenticated; live Claude execution remains unverified. Its installed capabilities and argv/stdin protocol were tested. See [the exact live-run record](live-agent-validation.json). These checks establish this bounded integration path, not model reliability across arbitrary projects.

## Portable checkpoint bundles

A versioned `.sentinel.json` bundle carries the selected checkpoint, its approved contract, source snapshots and complete referenced receipts. Each object is bound to its SHA-256 hash. Exporting refuses an active session or source changes that have not been captured in the checkpoint, and never overwrites an existing bundle.

```sh
sentinel export --out task.sentinel.json
# Copy the bundle to another machine or storage location.
sentinel import task.sentinel.json --store /path/to/receiving-store
sentinel continue --agent codex --store /path/to/receiving-store --allow-local
```

Import validates the complete evidence chain before publishing a new session. The new workspace uses a new session ID; the original session remains unchanged. Historical receipts retain their original source and execution identities. They are labelled historical for the relocated workspace until verification runs again. Local execution consent is deliberately reset on import, so importing a file alone never authorises execution of its code.

Bundles do not include `node_modules`, installed agents, provider authentication, or the operating-system environment. The bundled Vitest/TSX runtime supports dependency-free fixtures without further installation. If the project needs other packages, review its dependency definitions and install them separately in the imported workspace; `npm ci --ignore-scripts` is one option for a reviewed npm project with a lockfile. Dependency installation is not performed automatically by import.

**Review a bundle before sharing it.** It contains the selected source files, contract, local paths, agent transcripts and command outputs already recorded in the session. These may contain private code or information printed by your tools. Export is a local file operation and never uploads the bundle.

Version 1 uses ordinary JSON with canonical base64 content objects; it does not execute archive extractors or evaluate imported code. Import is bounded to 300 MB of encoded JSON, 50,000 objects, 20,000 files per snapshot, 20 MB per source file, 100 MB per source snapshot, and a 1 MB contract. It rejects unsafe paths, Git metadata, source symlinks and case/Unicode-colliding paths. Git setup disables hooks and external Git configuration. Hashes detect corruption; a hostile party able to replace the whole bundle can produce new hashes, so hashes do not establish authorship or trust.
