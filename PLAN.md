# Implementation Plan

## Outcome

Produce source-traceable happy-path BDD from an unfamiliar React/Java application while separating deterministic facts, semantic proposals, environment data and runtime observations.

## Milestone 0 — Foundation

- [x] Local TypeScript CLI package
- [x] Configuration and schema boundaries
- [x] Artifact store, stable IDs and diagnostics
- [x] Project-local agent skill
- [x] Golden React/Java fixture

Acceptance: identical inputs create byte-stable canonical output apart from explicit generation metadata.

## Milestone 1 — Evidence and operations

- [x] Source snapshot
- [x] Graphify importer
- [x] React extractor
- [x] Java extractor
- [x] Cross-layer evidence graph
- [x] Operation candidate catalog

Acceptance: trace `UI control → handler → HTTP call → Java endpoint → terminal effect` with source evidence.

## Milestone 2 — Contracts

- [x] Page contracts
- [x] Actor requirements
- [x] Frontend/backend validation merge
- [x] Conditional fields and actions

Acceptance: every modeled field, action and permission has evidence or an explicit unresolved marker.

## Milestone 3 — Behavior and flow discovery

- [x] Screen-state and action graph
- [x] Guarded transitions
- [x] Successful path enumeration
- [x] Behavior signatures
- [x] Variant reduction

Acceptance: the fixture yields materially distinct personal and joint successful variants rather than a Cartesian product of values.

## Milestone 4 — Data and agent reasoning

- [x] Data-requirement classification
- [x] Missing-environment-data requests
- [x] File-mediated agent packets
- [x] Schema/evidence validation
- [x] Review decisions

Acceptance: the tool can generate valid primitives but refuses to invent UAT identities or existing entities.

## Milestone 5 — BDD and runtime grounding

- [x] Journey BDD renderer
- [x] Page-contract BDD renderer
- [x] Execution/rehearsal manifest
- [x] Runtime observation importer
- [x] Durable runtime-binding artifact

Acceptance: browser observations can confirm or block source-derived transitions without changing flow meaning.

## Milestone 6 — Verification and broader coverage

- [x] Unit tests
- [x] Golden artifact tests
- [x] Coverage manifest
- [x] Change fingerprints and stale detection
- [ ] Direct execution against a live corporate application
- [ ] Approved UAT resolver integration
- [ ] Additional React form/router conventions
- [ ] Read-only business terminal types
- [ ] Bug-finding contradiction passes

The unchecked items require a real target application, environment or future bug-finding scope; they do not weaken the local vertical slice.
