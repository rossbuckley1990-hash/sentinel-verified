# v1 product engineering record

Baseline: main `c825d39e21efd739a42bf761dc7e2beb128d5ce0`, published v0.2.0. Work branch: `codex/v1-product`. Existing releases remain unchanged.

## Gap analysis and scope

The baseline already provides protected reviewed contracts, immutable source snapshots, finite function examples, preservation checks, suspicious test-change inspection, independent receipts, resumable managed workspaces, real agent protocols and optional Docker verification. Preserve these modules and schema-1/2 compatibility.

The product gaps are application-level HTTP/browser observations, practical acceptance authoring for applications, bounded repair from counterexamples, a reviewable patch export, application artifacts that survive export/import, and measured application evaluation.

## Decisions

- Extend contracts with schema 3, retaining function requirements and adding a reviewed server argv and declarative HTTP/browser scenarios. Expectations remain developer decisions. No arbitrary JavaScript evaluation in browser criteria.
- Execute actual Node servers in fresh snapshot directories. Select a loopback port, bound readiness/requests/browser operations and stop owned process groups. Local execution remains advisory; no implied host sandbox.
- Use Playwright Core with an existing Chrome or explicitly installed compatible browser. No hidden browser downloads, no custom browser engine. Block external page requests where supported, without pretending that this isolates server code.
- Record screenshots and interaction observations as bounded content objects referenced by receipts. Include those objects in portable bundles and self-contained reports.
- Retry contradicted approved requirements at most the configured budget (default one for real agents, maximum three). Never retry into a new contract, silently change agents, or present a previous receipt as current success.
- Export a source-bound binary-safe Git patch. Never overwrite the input project or merge changes automatically.
- Measure contract coverage only over explicit, reviewed objective aspects and their mapped checks. This is finite coverage accounting, not semantic completeness.

## Release gates

Baseline reproduction, original regression suite, live HTTP/browser evidence, deterministic interruption/repair, authenticated Codex application task, Claude protocol compatibility, public development/held-out evaluation, fresh public package installation, supported macOS/Linux CI and release artifact integrity must be recorded before a v1.0 release. Any mandatory failure blocks the final version label.
