# Release process

Versions follow SemVer. Contract schemas 1–3, receipt schemas 1–2 and checkpoint schema 1 are validated explicitly. New code reads earlier supported formats; older releases need not understand newer artifacts. Incompatible imports must fail or use an explicit migration that preserves historical hashes.

1. Run `npm ci && npm run build`, explicitly install a test browser with `npx playwright-core install chromium`, then run `SENTINEL_TEST_BROWSER=1 npm test`, `npm run benchmark`, and `npm run benchmark:public`. Install the separate web evaluation dependencies with `npm ci --prefix benchmarks/web/runtime --ignore-scripts` and run `npm run benchmark:web`.
2. Run `npm audit --omit=dev`. Review security findings rather than suppressing them.
3. Run `node scripts/capture-demo.mjs` to regenerate the real terminal transcript and SVG excerpt.
4. Push the candidate commit and require all macOS/Linux, Node 22/24 CI jobs to pass.
5. Run `node scripts/fresh-install.mjs /tmp/sentinel-fresh-install.json` against the public candidate. It uses a new clone and empty npm cache. Prerequisite installation is excluded and declared in the result.
6. Review documentation, package contents (`npm pack --dry-run`), benchmark results and known limitations. Update `package.json` and lockfile together for a new version.
7. Tag the verified commit `vX.Y.Z` and push the tag. The Release workflow validates version consistency, rebuilds, reruns checks and publishes a GitHub release with an installable npm tarball. It does not publish to the npm registry.

Do not move an existing release tag. Correct defects in a new patch version. Private vulnerability reporting is enabled on the public GitHub repository.


For v0.2, preserve the pinned public evaluation labels, report specification misses and unsuccessful infrastructure attempts, and record live agent authentication separately from protocol tests. Run the configured Docker probes when a reviewed local image is available. The offline core must not require Docker.

Registry publication is a separate authority check (`npm whoami`). A failed authentication check blocks npm publication, not the GitHub release archive. Do not advertise `npx sentinel-verified` until that exact version is published and tested. Validate the GitHub `.tgz` in a fresh install prefix and cache, and include its exact URL in the release instructions.

For v1, require the real browser/API demo, reviewed live coding-agent application task, interruption recovery, public application evaluation with retained misses, and a new Docker function-boundary probe. Final macOS/Linux CI must pass on the exact candidate. Test the public archive after release publication; if its installation fails, do not claim the release complete. Keep the version a release candidate while a mandatory gate remains unestablished.
