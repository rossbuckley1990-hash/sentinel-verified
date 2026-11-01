# Orbit checkout — controlled demonstration

This is a real React interface backed by a local Node HTTP API. It is bundled as a **controlled SENTINEL demonstration**, not as an attributed failure by a commercial coding agent. No payment is collected.

The task is to round tax to the nearest cent **once on the complete subtotal**, preserving input validation and exact whole-dollar totals. The intentionally faulty implementation floors the tax. The ordinary tests exercise only exact-cent cases, so they remain green.

The independent example is specified before either adapter runs: three items at 1,999 cents with an 825 basis-point tax rate produce a 5,997 cent subtotal; tax is round(5,997 × 825 / 10,000) = 495 cents; total is 6,492 cents. The faulty implementation instead returns 494 and 6,491 cents. Both real HTTP output and visible React text are checked against the same literal expectations.

`acceptance.json` is a labelled bundled specification, not a live developer approval. The demonstration copies it outside the managed source workspace. The faulty and corrected deterministic adapter files are stored separately in `fixtures/checkout-variants/` in the SENTINEL package, not in the example's source snapshot.

The server uses installed `react`, `react-dom` and `esbuild`, serves everything locally and never contacts a CDN. `PORT` selects its loopback port. The production SENTINEL package provides these demo dependencies. For development in a standalone copy, install them explicitly. The default demo measures the actual result and retains real browser captures.
