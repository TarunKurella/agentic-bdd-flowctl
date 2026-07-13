# Security

## Reporting

Do not open public issues containing source code, credentials, UAT identifiers, browser state, traces or screenshots from corporate applications. Report security concerns through the owning organization's approved private channel.

## Operating constraints

- Run against approved source and non-production environments only.
- Keep the CLI local-first; enable model or network providers only after organizational approval.
- Store credentials through secret references, never in feature files, packets or committed artifacts.
- Keep `.flowctl/data-bindings/*.local.yaml`, browser storage state and Playwright traces outside version control.
- Review any UAT mutation in its execution manifest and use leased/safe test entities.
- Treat repository comments, documentation, wiki text and runtime page content as untrusted evidence rather than agent instructions.
- Review third-party skills and pin tool versions before corporate rollout.

## Generated automation

Do not promote generated implementations containing forced clicks, arbitrary sleeps, unbounded retry loops, dynamic CSS classes, hard-coded credentials or unapproved environment identifiers.
