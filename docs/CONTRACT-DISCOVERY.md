# Contract discovery and approval

`sentinel run "your objective"` can propose a verification plan from a supported repository without asking you to create a JSON file. Discovery is a bounded static analysis step. It does not import project code, run tests, load executable configuration, invoke package scripts or call a model.

The proposal remains separate from the approved contract. A selected proposal is only a UI default: it is not approval. The interactive flow must obtain the developer's explicit decision before treating any implementation as verified against those criteria. Source files, a model, an installed agent and package configuration cannot approve requirements on the developer's behalf.

## Evidence the engine can translate

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

## What discovery returns

The version-1 discovery plan records the canonical Git root, objective, detected package manager and framework, relevant file paths, exported interfaces, proposed requirements and uncertainty. Each evidence location includes a path, one-based line, bounded excerpt and SHA-256 of the source file. The objective has its own content hash. These hashes bind the evidence bytes; they are not authenticity signatures.

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
