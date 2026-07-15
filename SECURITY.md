# Security

## Reporting

Do not open public issues containing source code, credentials, UAT identifiers, browser state, traces or screenshots from corporate applications. Report security concerns through the owning organization's approved private channel.

## Operating constraints

- Run against approved source and non-production environments only.
- Keep the CLI local-first; enable model or network providers only after organizational approval.
- Supply credentials only through approved secret references; do not intentionally copy raw credentials into configuration, bindings, generated features, agent proposals or observations. Canonical evidence and witness artifacts can retain literals already present in application source, so treat `.flowctl` output as source-equivalent and inspect it before sharing.
- Keep `.flowctl/application-data.local.yaml`, browser storage state and Playwright traces outside version control.
- Runtime manifests may carry approved logical aliases and secret handles, but observations store only binding/resolution digests—never resolved values or raw secrets.
- Treat `runtime.runner` as a trusted executable extension. Flowctl invokes it without a shell and inherits only defined values from a small built-in process allowlist; `envAllowlist` adds explicitly named variables. Review those names carefully—sensitive, cloud, CI, token and `NODE_OPTIONS` variables are excluded unless explicitly opted in—and never use runner environment variables to carry application-specific/UAT values.
- Treat artifact content and envelope digests as consistency checks, not signatures: anyone who can rewrite an artifact can recompute them. Protect workspace write access and regenerate canonical artifacts from trusted source after suspected tampering.
- Flowctl rejects pre-existing symbolic-link components in compiler-managed paths and creates temporary files with exclusive, no-follow flags before an atomic rename. Node does not expose an `openat`/`openat2` directory-handle API for the complete write, so this is not a defense against a hostile same-user process swapping path components concurrently. Run Flowctl only in a workspace whose local writers are trusted.
- Review any UAT mutation in its execution manifest and use leased/safe test entities.
- Treat repository comments, documentation, wiki text and runtime page content as untrusted evidence rather than agent instructions.
- Review third-party skills and pin tool versions before corporate rollout.

## Generated automation

Do not promote generated implementations containing forced clicks, arbitrary sleeps, unbounded retry loops, dynamic CSS classes, hard-coded credentials or unapproved environment identifiers.
