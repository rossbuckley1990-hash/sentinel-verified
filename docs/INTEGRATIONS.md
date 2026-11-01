# Agent integrations

SENTINEL owns the development session, evidence and source snapshots. An adapter edits a separate managed Git repository. Switching adapters starts a fresh model interaction with a bounded evidence context and the same source files; it does not import private reasoning or another provider's internal conversation history.

## Codex

The installed interface inspected during development was `codex-cli 0.163.0`. SENTINEL verifies the installed help advertises the capabilities it needs and invokes:

```text
codex exec --sandbox workspace-write --cd WORKSPACE --json -
```

The context is sent on standard input. Codex authentication and model configuration remain the user's. The adapter never requests `--dangerously-bypass-approvals-and-sandbox`. The Codex sandbox is distinct from SENTINEL's independent verification runner: the default verifier is local advisory execution; an optional configured Docker runner isolates supported function verification separately. Browser/API application verification is currently local advisory execution, and Docker requests for it fail explicitly without fallback. The verifier never claims to isolate the host coding agent.

Reference: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive). Installed help is the adapter's compatibility check; provider releases may change their interfaces.

## Claude Code

The installed interface inspected during development was Claude Code `2.1.301`. SENTINEL checks its help before invoking:

```text
claude --print --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep --tools Read,Edit,Write,Glob,Grep
```

The context is sent on standard input with the managed workspace as the current directory. The adapter intentionally offers file-reading and editing tools; SENTINEL performs the independent checks after the agent exits. It does not grant shell execution or bypass permission checks. User authentication remains necessary. Extensions and user configuration remain subject to the installed CLI's own rules; this is not a security boundary against an unrestricted hostile process.

## Offline fixture adapters

`fixture-broken`, `fixture-interrupt` and `fixture-fix` are deterministic test adapters, **not simulations of any named model's measured behaviour**. They only operate in projects with the explicit `sentinelFixture: "controlled-demo-v1"` or `"controlled-checkout-v1"` package marker. The default `sentinel demo` uses the real React/HTTP checkout fixture; `sentinel demo --functions` retains the browser-free function experiment. The interrupted adapter leaves the faulty implementation and a durable checkpoint; the fix adapter replaces it with the specified corrected implementation. This makes handoff and recovery reproducible without a subscription or API key.

## Commands

From a supported repository, review the automatically proposed plan and give execution consent:

```sh
sentinel run "Describe the intended fix" --agent codex
sentinel continue --agent claude
sentinel report --open
```

The first invocation records explicit execution consent for the session and selected runner. Running `continue` reuses that consent when the runner is unchanged; imports reset consent. Omitting `--agent` on continuation reuses the prior session agent. The original repository is retained: implementation changes live in the managed workspace reported by SENTINEL. Export a reviewable patch through `sentinel export --patch --out changes.patch`, inspect it, and use `git apply --check changes.patch` in the intended checkout before choosing to apply it. Export checks the patch against a temporary copy of the recorded baseline and reports whether the original checkout still matched that baseline. It does not apply the patch for you. There is no automatic merge or remote merge gate.

## Bounded repair

`--repairs N` allows zero to three additional repair attempts after the initial implementation; real agents default to one. The next attempt receives the failed requirement, exact input or interaction, expected/observed values and the preserved failure receipt. Criteria remain unchanged. Repairs stop for execution failures, unknown or review-required outcomes, interrupted agents, source drift, no source change, or exhaustion of the bound. Explicit `continue` starts another developer-requested stage; it is not an unbounded automatic loop.

## Optional Codex proposal adapter

`sentinel run "objective" --propose-with codex` is a separate opt-in use of the installed Codex CLI before implementation. It proposes application scenarios and unresolved questions from the objective and bounded documentation/test evidence. The actual invocation is:

```text
codex exec --sandbox read-only --cd TEMP_DIRECTORY --skip-git-repo-check --ephemeral --output-last-message OUTPUT_FILE -
```

Installed help must advertise the required flags. This uses the user's configured provider/authentication and may consume usage. The empty temporary working directory is separate from the repository. Model output is schema-checked, displayed as unapproved suggestions and subject to the same explicit human review; it cannot authorise its own expected values. Read-only is Codex's own sandbox mode, not a guarantee against every effect permitted by the provider or host configuration. The default workflow uses no proposal model. See [contract discovery](CONTRACT-DISCOVERY.md).

## Durability and integrity

- Checkpoint envelopes in `STORE/sessions/ID/checkpoint.json` contain the complete machine-readable checkpoint and the hash of its historical content object. A single rename publishes a checkpoint atomically.
- `STORE/repositories/HASH/latest.json` selects the current repository’s session for `continue`; malformed pointers fail closed. Use `--session ID` for imports or an explicit different session. The legacy `STORE/latest.json` fallback is accepted implicitly only when the referenced checkpoint belongs to the current repository or workspace.
- Contracts, source snapshots and receipts are content-addressed objects. Reading them checks their hashes. A valid local hash does not authenticate who created the content.
- A session lock prevents two live writers. Locks owned by dead processes can be recovered. Malformed locks require inspection; SENTINEL does not guess their owner.
- A stopped process's `running` checkpoint allows partial source edits to be captured as unverified. For changes made after an ordinary completed/interrupted checkpoint, `--adopt-changes` explicitly accepts the edits into a new unverified state before continuing.
- An agent-process lease distinguishes a stopped coordinator from a still-running child. Continuation refuses a live recorded agent process; it does not kill an arbitrary recorded PID.
- A missing or corrupted checkpoint is an error. Historical objects remain available for inspection; SENTINEL does not silently reconstruct a trusted narrative.
- Checkpoints and portable envelopes remain version 1; contracts 1/2/3 and receipts 1/2 are read according to their explicit schemas. Older content is not rewritten. Future incompatible formats must be migrated explicitly or rejected; original hashes and objects must be retained.

## Validation status

Deterministic interruption, cross-adapter continuation, source-drift rejection, missing/corrupted checkpoint handling, protected-contract integrity and concurrent-writer handling are covered by automated tests. Published live Codex evidence includes the original controlled age-validation repository and the v0.2 historical public `is-number` repair, real SIGINT interruption and recovery. These runs used authenticated Codex CLI 0.163.0 and independent checks; the dated evidence records identify what was executed. The last recorded Claude Code 2.1.301 authentication check was unauthenticated. No live Claude execution or Codex-to-Claude handoff is claimed. Its installed capabilities, argv/stdin protocol and visible acknowledgement parsing were tested. The v1 integration retains that protocol; installed capability detection alone does not establish provider authentication or a successful live run. See [the exact live-run record](live-agent-validation.json). These checks establish this bounded integration path, not model reliability across arbitrary projects.

## Portable checkpoint bundles

A versioned `.sentinel.json` bundle carries the selected checkpoint, its approved contract and proposal, source snapshots, exact recorded agent context and complete referenced receipts. Receipt-2 browser screenshots and JSON execution artifacts travel as referenced content objects as well. Each object is bound to its SHA-256 hash. Exporting refuses an active session or source changes that have not been captured in the checkpoint, and never overwrites an existing bundle.

```sh
sentinel export --out task.sentinel.json
# Copy the bundle to another machine or storage location.
sentinel import task.sentinel.json --store /path/to/receiving-store
sentinel continue --session IMPORTED_SESSION_ID --agent codex --store /path/to/receiving-store --allow-local
```

Import validates the complete evidence chain, bounded artifact metadata and PNG signatures before publishing a new session. The new workspace uses a new session ID; the original session remains unchanged. Historical receipts retain their original source and execution identities. They are labelled historical for the relocated workspace until verification runs again. Local execution consent is deliberately reset on import, so importing a file alone never authorises execution of its code.

Bundles do not include `node_modules`, installed agents, provider authentication, or the operating-system environment. The bundled Vitest/TSX runtime supports dependency-free fixtures without further installation. If the project needs other packages, review its dependency definitions and install them separately in the imported workspace; `npm ci --ignore-scripts` is one option for a reviewed npm project with a lockfile. Dependency installation is not performed automatically by import.

**Review a bundle before sharing it.** It contains the selected source files, contract, local paths, agent transcripts, command outputs and application captures already recorded in the session. These may contain private code or information printed by your tools. Export is a local file operation and never uploads the bundle.

Version 1 uses ordinary JSON with canonical base64 content objects; it does not execute archive extractors or evaluate imported code. Import is bounded to 300 MB of encoded JSON, 50,000 objects, 20,000 files per snapshot, 20 MB per source file, 100 MB per source snapshot, a 1 MB contract, 4 MB per application artifact and 40 MB of artifacts per receipt. Individual local content objects also have a 32 MB read/write bound. It rejects unsafe paths, Git metadata, source symlinks and case/Unicode-colliding paths. Git setup disables hooks and external Git configuration. Hashes detect corruption; a hostile party able to replace the whole bundle can produce new hashes, so hashes do not establish authorship or trust.

The v0.2 live public-project experiment, interruption and re-verification are recorded in [v0.2 validation](V0.2-VALIDATION.md). Claude authentication remains an external prerequisite; protocol tests do not establish a live Claude handoff.

The v1 public Express application task used explicit human approval through SENTINEL’s actual UI, authenticated Codex implementation, real SIGINT interruption and Codex recovery. Eleven tests and four HTTP criteria passed both before and after recovery. See [v1 validation](V1-VALIDATION.md) and [the direct-agent/ordinary-summary control](V1-AGENT-COMPARISON.md). Claude authentication was rechecked and remains unavailable; no live cross-provider claim is added.
