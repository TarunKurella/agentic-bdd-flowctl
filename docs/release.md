# Release guide

## Release gates

Every release must pass:

```bash
npm ci --ignore-scripts
npm audit --omit=dev
npm run check
npm run check:package
```

`check:package` packs the declared files, rejects development-only content, installs the archive in an empty project, launches the installed binary, and verifies that the CLI and package versions match.

CI runs on Node.js 22 and 24 with the locked dependency graph and GitHub Actions pinned to immutable commits.

## Versioning

Update `package.json` and the CLI version together. The package smoke test rejects drift. Merge the release commit to `main` before creating a tag.

Use an annotated tag:

```bash
git tag -a v0.2.0 -m "Agentic BDD Flowctl v0.2.0"
git push origin v0.2.0
```

The release workflow requires the tag to match `package.json`, requires the tagged commit to be on `main`, repeats all verification, creates an npm package archive, generates a CycloneDX SBOM and checksum, and publishes an immutable GitHub Release.

Existing release assets are never overwritten. Publish a new version for every change.

## Distribution

The repository is currently marked `private: true`; the workflow publishes a GitHub Release archive but does not publish to npm. Decide the company ownership, license, support policy, and allowed distribution scope before broad internal or public adoption.

## Repository controls

For company use, protect `main` with pull-request review and required CI, keep secret scanning and push protection enabled, enable Dependabot alerts/updates, and restrict release/tag creation to maintainers.
