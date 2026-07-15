# Implementation Plan

## Outcome

Produce source-traceable happy-path BDD from an unfamiliar React/Java application while separating deterministic facts, semantic proposals, project-specific application data and runtime-environment observations.

## Milestone 0 — Foundation

- [x] Local TypeScript CLI package
- [x] Configuration and schema boundaries
- [x] Artifact store, stable IDs and diagnostics
- [x] Project-local agent skill
- [x] Golden React/Java fixture

Acceptance: identical inputs create byte-stable canonical output apart from explicit generation metadata.

## Milestone 1 — Evidence and operations

- [x] Source snapshot
- [x] Graphify auxiliary-evidence importer (no retrieval narrowing or join authority in v0.2)
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
- [x] Reviewed `analysis.transparentComponents` allowlist for non-interactive wrappers

Acceptance: every modeled field, action and permission has evidence or an explicit unresolved marker.

## Milestone 3 — Behavior and flow discovery

- [x] Screen-state and action graph
- [x] Guarded transitions
- [x] Constructive predicates for supported top-level Java `if (...) throw` guards
- [x] Successful path enumeration
- [x] Behavior signatures
- [x] Variant reduction

Acceptance: the fixture yields materially distinct successful variants when behavior changes, rather than a Cartesian product of values.

## Milestone 4 — Data and agent reasoning

- [x] Data-requirement classification
- [x] Missing application-specific data requests in one environment-independent local file
- [x] File-mediated agent packets
- [x] Schema/evidence validation
- [x] Review decisions

Acceptance: the tool automatically accepts only source-derived concrete representatives and refuses to invent UAT identifiers, product codes, eligible identities or existing entities. All other application-specific values are bound once in `.flowctl/application-data.local.yaml` and require human confirmation.

## Milestone 5 — BDD and runtime grounding

- [x] Journey BDD renderer
- [x] Review-only page-contract specification renderer (`*.feature.txt`)
- [x] Statement-to-witness BDD traceability
- [x] Explicit `@implementation-required` boundary
- [x] Execution/rehearsal manifest
- [x] Runtime observation importer
- [x] Durable runtime-binding artifact
- [x] Witness-ordered manifest and observation validation
- [x] Application-specific adapter target plan/scaffold/verifier
- [x] Approved no-shell external runner protocol and `ground run`

Acceptance: browser observations can confirm or block source-derived transitions without changing flow meaning.

## Milestone 6 — Agentic CLI UX and proof visibility

- [x] One-command source discovery and graph summary
- [x] Target-aware `status`, `guide` and `next`
- [x] Flow catalog and variant proof inspection
- [x] Evidence/behavior graph summary and trace commands
- [x] State-derived coding-assistant guide and prompt
- [x] Stable `flowctl.cli.v1` JSON envelope
- [x] Typed lifecycle/security exit codes
- [x] Separate data binding and human confirmation

Acceptance: a developer or approved coding assistant can start with `flowctl discover`, select a variant, inspect its witness/source proof and follow exact state-derived commands through BDD, data and runtime gates without relying on conversation memory.

## Milestone 7 — Verification and broader coverage

- [x] Unit tests
- [x] Golden artifact tests
- [x] Coverage manifest
- [x] Per-operation coverage through client join, action join, success continuation, family, witness and variant
- [x] Change fingerprints and stale detection
- [ ] Direct execution against a live corporate application
- [ ] Approved UAT resolver integration
- [ ] Additional React form/router conventions
- [ ] Read-only business terminal types
- [ ] Bug-finding contradiction passes

The unchecked items require a real target application, environment or future bug-finding scope; they do not weaken the local vertical slice.

Current v0.2 boundaries: Graphify is imported only as auxiliary evidence; Wiki headings/aliases enrich glossary evidence and readable labels but do not connect implementation layers; complex Java rule control flow and ambiguous entity relationships remain review-only; dynamic repeated-row action templates are not implemented.
