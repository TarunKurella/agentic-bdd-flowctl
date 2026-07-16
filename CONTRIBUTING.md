# Contributing

Flowctl is conservative by design. A new extractor or graph join must cite source evidence, preserve ambiguity as an unresolved diagnostic, and include a focused regression test.

## Development checks

Use Node.js 22 or 24.

```bash
npm ci --ignore-scripts
npm run check
npm run check:package
```

When changing discovery or reduction semantics, add both a focused unit case and a vertical fixture assertion. When changing generated BDD, verify Playwright-BDD discovery and traceability.

Do not commit `.flowctl` state, application-specific values, UAT identifiers, credentials, secrets, model conversations, or runtime observations.

Open a pull request against `main`. The code owner and required CI checks must approve it before merge.
