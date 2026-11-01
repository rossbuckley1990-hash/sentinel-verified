# Contributing

SENTINEL favours a small, reproducible verification surface over broad integration claims.

## Set up

Use Node.js 22.12+ and Git:

```sh
npm ci
npm run build
npm test
npm run benchmark
node dist/cli.js demo
```

Keep changes focused. Describe the concrete behaviour being changed, include a reproduction for a bug, and add a meaningful check that fails before the fix. Do not weaken a check merely to make a run green.

## Engineering expectations

- Preserve the difference between verified, contradicted, unknown, review-required and environment-failure outcomes.
- Keep developer-approved contracts separate from agent-writable implementation files.
- Use explicit subprocess argument arrays, bounded output and timeouts. Never concatenate untrusted values into a shell command.
- Validate versioned records and path boundaries before use. Treat stored files and agent output as untrusted data.
- Use deterministic fixtures for tests. Live model integrations are optional and must be labelled separately from offline adapter tests.
- Record benchmark expectations before running the candidate implementation. Keep held-out cases distinct from development fixtures.
- Document any change to the trust model, schema, supported input domain or continuation behaviour.
- Do not include secrets, personal data, private source or machine-specific logs in contributions.

The report is a static view of the receipt. It must remain self-contained, escape all user-supplied content and avoid network dependencies.

## Pull requests

Explain the problem, resulting behaviour, relevant tests and remaining limitations. Include actual command results; do not invent performance or integration claims. An example that passes locally is not proof of arbitrary semantic correctness.

CI builds and tests the project on macOS and Linux. A failing benchmark expectation is a regression to investigate, not permission to change the expectation without an independent rationale.

## Releases

1. Update `package.json`, the lockfile and relevant documentation with the intended version.
2. Run the build, tests, demo and benchmark from a clean checkout.
3. Inspect the package with `npm pack --dry-run`; exclude local evidence, secrets and dependencies.
4. Verify the release commit's CI and fresh-install path.
5. Create an annotated `vX.Y.Z` tag on that commit and push it.
6. The release workflow repeats validation, checks the package version against the tag and attaches the built package archive to a GitHub release.

The workflow does not publish to npm. Registry publication requires a separate explicit decision and availability check before documenting an npm install command.

Versioned records must remain inspectable. Breaking schema changes need a new schema version and a documented migration that preserves original evidence.
