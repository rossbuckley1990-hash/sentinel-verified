# Release process

Versions follow SemVer while 0.x allows documented schema/API changes. Schema version 1 is validated explicitly; incompatible imports must fail or use an explicit migration that preserves historical hashes.

1. Run `npm ci && npm run build && npm test && npm run benchmark`.
2. Run `npm audit --omit=dev`. Review security findings rather than suppressing them.
3. Run `node scripts/capture-demo.mjs` to regenerate the real terminal transcript and SVG excerpt.
4. Push the candidate commit and require all macOS/Linux, Node 22/24 CI jobs to pass.
5. Run `node scripts/fresh-install.mjs /tmp/sentinel-fresh-install.json` against the public candidate. It uses a new clone and empty npm cache. Prerequisite installation is excluded and declared in the result.
6. Review documentation, package contents (`npm pack --dry-run`), benchmark results and known limitations. Update `package.json` and lockfile together for a new version.
7. Tag the verified commit `vX.Y.Z` and push the tag. The Release workflow validates version consistency, rebuilds, reruns checks and publishes a GitHub release with an installable npm tarball. It does not publish to the npm registry.

Do not move an existing release tag. Correct defects in a new patch version. Private vulnerability reporting is enabled on the public GitHub repository.
