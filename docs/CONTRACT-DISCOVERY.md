# Contract discovery and approval

`sentinel run "your objective"` can propose a verification plan from a supported repository without asking you to create a JSON file. Default discovery is a bounded static analysis step. It does not import project code, run tests, load executable configuration, invoke package scripts or call a model. The separate `--propose-with codex` option explicitly opts into model-assisted application proposals; it does not approve them.

The proposal remains separate from the approved contract. A selected proposal is only a UI default: it is not approval. The interactive flow must obtain the developer's explicit decision before treating any implementation as verified against those criteria. Source files, a model, an installed agent and package configuration cannot approve requirements on the developer's behalf.

## Application projects: approve observations, not implementation guesses

For a recognised Node API or React/Vite project, static discovery proposes a server command and shows source-backed route and selector hints. It does **not** derive the expected response or screen content from the candidate implementation. The interactive editor asks for the missing expected examples:

1. Review the server command and readiness path. The server must bind to loopback using `PORT` or the `{port}` argument placeholder.
2. Add an HTTP response or browser interaction, mark it must-change or must-preserve, and provide the expected outcome.
3. Review the full scenarios and authorised changed-file paths. Add, edit or remove examples; record unanswered questions and their resolutions.
4. Confirm whether these examples cover all outcomes intended for this task, or explicitly approve limited scope.
5. Approve local execution separately. Application verification currently requires the local advisory runner; requested Docker execution fails without falling back.

An HTTP example specifies a local path, method, optional JSON request body, exact response status and exact JSON or text body. Browser examples specify a local path, bounded click/fill/select/check or Enter/Escape/Tab interactions, and exact text/value or visibility assertions. They contain no arbitrary JavaScript. Screenshots record the observed page; the approved assertions supply the expected behaviour.

The wizard can recognise common React, Vite, Express, Fastify and Node HTTP indicators. Recognition is a hint, not a promise that every project configuration works. Vite receives a fresh strict loopback port; Node server commands receive `PORT` and `HOST`. A project needing external services, an unsupported build environment or different startup arguments may require a reviewed command adjustment or remain unsupported. Discovery never installs dependencies.

The default changed-file scope for application proposals is the displayed set of up to 100 discovered source paths. Review and narrow it using **Paths**. It does not authorise arbitrary behaviour, and edits to tests or verification controls still require review.

## Optional model-assisted interpretation

```sh
sentinel run "Fix checkout rounding while preserving validation" --propose-with codex
```

This explicit option sends the objective, reviewed server configuration and bounded documentation/test excerpts to the user's configured Codex CLI. It may use the provider's network connection, authentication and usage allowance. SENTINEL checks the installed help and invokes Codex with a read-only sandbox, an empty temporary working directory and an ephemeral interaction. The response must be schema-valid scenario suggestions and open questions. Model output cannot approve a requirement, grant execution consent or change the implementing agent's contract.

The prompt instructs the model to treat repository text as untrusted and leave questions when evidence does not justify expected values. Those instructions and schema validation do not make model interpretation infallible. Inspect every expected value. Read-only proposal execution uses Codex's own permission boundary, not an additional SENTINEL sandbox. If interpretation fails, no expectations are approved; the ordinary editor remains available without the option.

## Finite objective coverage

Application approval creates a **schema-3 contract** containing the server configuration, scenarios, exact allowed paths, unresolved questions and a coverage declaration. Coverage records a developer-confirmed scope flag and explicitly named aspects mapped to requirement IDs. The wizard records `intent: "change"` or `"preserve"`; omission in a manual contract retains change-task semantics. The wizard creates one aspect covering the reviewed objective and all selected scenarios. Reviewed manual contracts can separate it into multiple aspects.

A preservation-only refactor can be verified when the developer explicitly confirms that no behavioural change is intended. A change task cannot become complete merely because existing preservation tests passed. Limited coverage, unresolved questions, an aspect without acceptance examples, or unconfirmed objective coverage keeps the result **UNVERIFIED**. An inconsistent must-preserve expectation requires review when the candidate matches it but the baseline does not.

Reports count approved, specified and verified **declared aspects**. For example, 1/2 verified aspects means one of two explicitly reviewed aspects has passing linked checks. It is not a percentage of all possible software behaviour or evidence that the developer listed every important requirement. An adequate-looking but incomplete contract can still miss a defect.

The proposal is stored as a separate content object before approval. The final contract binds its full body to that proposal and to the reviewed baseline hash. Source changes during review invalidate approval. Later contract loading checks the proposal binding; editing an expected result, server command, coverage decision or path scope while retaining the old approval fails.

## Function examples the static engine can translate

The engine reads Git-tracked and non-ignored source, tests, package metadata and Markdown. It identifies exported function signatures, repository-relative imports and common package entry points. Default and named ESM exports, imported aliases, namespace imports and common `module.exports` / `exports.name` interfaces are supported. Function bodies are never used to invent expected results.

It proposes **must-preserve** examples from direct, literal equality assertions:

```ts
import { expect, test } from 'vitest';
import { valid as check } from './validation.js';
test('valid input', () => expect(check('ok')).toBe(true));
```

Supported matchers are `toBe`, `toEqual` and `toStrictEqual`. Imported Node `assert.strictEqual` and `assert.deepStrictEqual` are also recognised. Arguments and expected values must be statically readable finite JSON values. Calls, variables, getters, spreads, computed properties, regular expressions, `undefined`, `NaN` and other dynamic or non-JSON values are not evaluated. Assertions involving local shadowing or reassigned imports are not attributed to the original export. Mocking, skipped tests and conditional assertions require review.

An explicit objective may supply **must-change** examples:

```text
Fix whitespace-only strings being accepted as numbers;
isNumber("   ") must return false;
isNumber("\r\n\t") must return false.
```

The named function must map unambiguously to a discovered export. The literal call/expected-result forms `must return`, `should return`, `returns`, `=>` and `===` are supported. This is a small grammar, not general natural-language understanding. A request such as “Fix authentication” supplies no particular expected return value; the engine reports that gap and the interactive requirement editor lets the developer add an example. Existing tests cannot silently stand in for the missing requested behaviour change.

Simple single-line Markdown examples can be shown as unselected proposals. Quoted primitive outputs such as `//=> 'true'` are ambiguous documentation conventions and are excluded rather than silently coerced to Boolean values. Documentation evidence does not override a test or a developer requirement. Contradictory expectations for the same module, export and arguments are flagged, and their selections are cleared for explicit resolution.

## Function discovery records and uncertainty

The static version-1 discovery plan records the canonical Git root, objective, detected package manager and framework, relevant file paths, exported interfaces, proposed requirements and uncertainty. Each evidence location includes a path, one-based line, bounded excerpt and SHA-256 of the source file. The objective has its own content hash. These hashes bind the evidence bytes; they are not authenticity signatures.

Uncertainties distinguish:

- **Intent:** no checkable intended change, or an ambiguous function identity.
- **Conflict:** incompatible expected results for one input.
- **Environment:** no supported test execution path was established.
- **Coverage:** dynamic assertions, ambiguous documentation or omitted files.
- **Safety:** skipped symbolic links or inputs outside the repository.

Intent, conflict and environment gaps block a full-objective verification claim. Coverage limitations remain visible even when the developer deliberately approves a narrower contract. A later green result establishes only the accepted checks, not the whole application or every sentence of an ambiguous task.

A repository containing a real Vitest adapter is detected from its static imports even when its historical package script uses another framework. The proposal states that upstream scripts and additional frameworks are not automatically executed. Discovery does not install dependencies or claim those other runners were tested.

## Limits and trust boundaries

Discovery reads at most 1,000 relevant paths, 512 KB per file and 5 MB total. It ranks paths by objective terms and test/source roles, retains imported function identities, and prioritises explicit change examples in the final proposal. At most 100 proposed examples are returned. Parse failures and read-budget omissions are surfaced. The static reader excludes Git internals, dependencies, evidence stores, common credential/configuration locations, private key files, ignored paths and symbolic links. Git filesystem-monitor hooks are disabled for the discovery commands.

This is a convenience layer over developer judgement. It cannot determine whether existing tests encode the right product requirements, discover every semantic dependency, interpret arbitrary prose or prove that a contract is complete. It never runs baseline behaviour to manufacture an oracle. For advanced or unattended workflows, externally reviewed versioned JSON contracts remain available.

## Noninteractive and compatibility paths

A hand-written JSON file is not required for the interactive workflow. For automation, an externally reviewed `--contract FILE` and explicit execution consent remain supported. The file must be outside the input repository. A manual contract's `approvedBy` label records the caller's approval claim; it is not a signature or evidence that a model has authority to decide expected behaviour.

Version-1 manual function contracts and version-2 interactive function contracts remain readable. Version 3 adds application scenarios and finite coverage; it can also describe function-only requirements with that coverage declaration. Version-2 approvals retain their original binding rules. New application approvals use a version-2 protected proposal object; existing static discovery plans are not silently promoted to a new authoritative specification. See [architecture and schema evolution](ARCHITECTURE.md#schema-evolution).
