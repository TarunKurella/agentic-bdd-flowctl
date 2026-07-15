# Artifact Contracts

`flowctl` keeps deterministic source models, semantic decisions, generated BDD, project-specific application data and runtime observations separate. The separation is a safety and provenance boundary, not just a directory convention.

## Canonical artifact envelope

Every canonical JSON artifact uses:

```json
{
  "meta": {
    "artifactType": "flow-variants",
    "schemaVersion": "1.0",
    "producer": "variants:reduce",
    "producerVersion": "0.2.0",
    "sourceDigest": "sha256:...",
    "configDigest": "sha256:...",
    "inputDigests": {},
    "contentDigest": "sha256:...",
    "envelopeDigest": "sha256:...",
    "status": "generated",
    "unresolved": []
  },
  "data": {}
}
```

YAML artifacts use the same `meta` and `data` sections. `sourceDigest`, the analysis-only `configDigest` and `inputDigests` allow the guided CLI to detect stale outputs. `contentDigest` checks the canonical `data` payload. Producer version 0.2.0 writes and requires `envelopeDigest`, computed over metadata (excluding that field) plus data, so accidental edits to lineage/status metadata are detected. A missing or mismatched envelope digest is stale/invalid and must be regenerated; it is not accepted as a legacy-readable envelope. These hashes are consistency checks, not signatures or a tamper-security boundary. `status` expresses artifact lifecycle; `unresolved` records claims that could not be safely established.

Configuration freshness is split by concern. Canonical source artifacts use `analysisConfigDigest` (exposed as `configDigest` for their envelope); application-data readiness also incorporates `dataConfigDigest`; grounding manifests/bindings and execution plans incorporate `runtimeConfigDigest` plus the adapter-manifest digest and selected environment. Adding a runner or changing a base URL therefore invalidates runtime work without falsely making the static source model stale.

Do not edit canonical artifacts by hand. Regenerate them from source and reviewed inputs.

Secret-classified data requirements redact representative values plus constraint values, validation messages and source excerpts while retaining constraint identity, kind, domain, source location and evidence references. This protects the application-data and runnable-BDD path; it is not a general source-secret scrubber. Evidence, page, behavior and witness artifacts model application source and can therefore retain source branch literals. Handle the whole output directory as source-equivalent.

## CLI JSON envelope

The CLI machine contract is intentionally different from the stored artifact contract. Every successful `--json` command emits a `flowctl.cli.v1` envelope:

```json
{
  "schemaVersion": "flowctl.cli.v1",
  "command": "guide",
  "ok": true,
  "code": "DATA_REQUIRED",
  "project": {
    "name": "sample-application",
    "configPath": "/workspace/flowctl.config.yaml",
    "sourceDigest": "sha256:..."
  },
  "target": {
    "variantId": "flow.variant.id",
    "environment": "uat"
  },
  "result": {},
  "nextActions": [],
  "diagnostics": []
}
```

Failures use the same envelope with `ok: false`, a typed `code`, no result and an error diagnostic. Consumers must use `schemaVersion`, `code`, `result`, `nextActions`, `diagnostics` and the process exit code; they must not scrape human output. The schema is `schemas/v1/cli-envelope.schema.json`.

See [CLI and agentic UX](cli-ux.md) for exit codes and command behavior.

## Evidence graph

`evidence-graph.json` contains normalized source claims and cross-layer relationships.

The evidence-node schema supports:

```text
source-file, route, page, component, control, field, handler, predicate,
http-client-operation, java-endpoint, dto-field, validation,
permission, navigation, request-payload, terminal-effect, visible-outcome, concept
```

The edge schema supports:

```text
renders, contains, triggers, calls, requests, handled-by,
guards, validates, requires, navigates-to, establishes,
binds-response, displays
```

Not every schema category is populated by every adapter. The v0.2 source builder emits source files, routes/pages, controls/fields/handlers, request payloads/HTTP calls, Java endpoints, navigation, permissions, validations, terminal effects and Wiki concepts; `predicate`, `dto-field` and `visible-outcome` evidence-node kinds remain reserved where no adapter emits them. Nodes and nontrivial edges retain source references. In v0.2, Graphify nodes/edges are auxiliary evidence only: they do not narrow retrieval, create framework joins or become executable behavior transitions. Wiki headings/aliases add glossary evidence and may enrich readable operation labels through an exact normalized entity-name match; they do not connect aliases across React, HTTP and Java or create predicates, permissions, validations or effects.

## Operation catalog

`operation-catalog.yaml` records candidate terminal business commands. Each operation contains:

```text
stable machine ID
HTTP method and normalized path
frontend caller IDs
backend endpoint ID (whose evidence retains request/response types)
request-payload contract IDs
authorization references
terminal effect IDs
inclusion/review status
semantic business-command label
evidence references
```

The operation/effect pair is authoritative for flow-family discovery. Success/error continuations are constructed separately in the behavior graph. A button label alone is not a business command.

## Page contracts

`page-contracts.json` contains route patterns, page completeness/entry conditions, fields and actions. Fields retain visibility, conditional requiredness, value binding/input mode, validations, option sources and evidence. Actions retain visibility, enablement, resolved/conditional handler identity, navigation IDs and evidence. Backend operation/effect joins and runtime locators live in their separate operation/behavior/runtime contracts; the page artifact does not invent them.

Page contracts supply detailed BDD, but do not independently define an end-to-end journey.

## Actor requirements

`actor-requirements.json` represents authentication, roles/authorities and opaque authorization predicates. In v0.2 its relationship list remains unpopulated. Actor-rooted attribute assignments discovered on a successful witness are stored on the variant and become `actor-attribute` data requirements rather than being rewritten into the actor artifact. A readable semantic label such as “eligible operator” is separate from exact source-derived requirements.

Extracted backend authorization is primary actor evidence. Reducible source predicates may establish exact actor attributes and frontend guards may corroborate them. Opaque domain rules remain conditional; UI text cannot weaken a backend requirement.

## Behavior graph

`behavior-graph.json` contains screen-state, action, operation and outcome nodes. Each edge carries:

```text
structured guard predicate
effects (navigation, operation invocation and entity transition in v0.2)
outcome category
evidence references
```

Entry and success node IDs are explicit. The outcome schema supports neutral, success, error and cancel, and successful path search excludes error/cancel edges. The v0.2 builder currently produces source-supported neutral/success edges; explicit error/cancel extraction is not yet implemented.

## Flow families

`flow-families.json` groups successful behavior around the same terminal business command. A family retains its operation IDs, success-state IDs, label and evidence references.

## Path witnesses

`path-witnesses.json` records concrete symbolic proof for a successful route:

```text
ordered node path
ordered edge path
accumulated path condition
representative assignments
feasibility status
evidence references
```

The entry, operation and success nodes are read from the ordered node/edge path rather than duplicated as witness fields. A valid witness must traverse an operation belonging to its family and finish through that operation's successful continuation. Merely reaching a shared confirmation page is not sufficient proof.

New path-witness artifacts also contain `search`: the configured bounds, enqueued/dequeued state counts, exact prune counts for `maxPathDepth` and `maxStateVisits`, and deterministic aggregate details with a stable sample rejected path. The field is optional for compatibility with older artifacts. A prune report means coverage is bound-limited; zero witnesses must not be interpreted as proof that the behavior graph is disconnected.

## Flow variants

`flow-variants.json` contains equivalence classes of witnesses sharing a behavior signature. A variant has at least one witness and references ordered pages/actions, operations, actor requirements, data requirements and evidence. Two variants may not have the same signature.

Use `flowctl graph trace <variant-id>` to inspect the representative witness and source proof behind a variant.

## Data requirements

Per-variant files under `data-requirements/` classify each needed input:

```text
flow-literal
synthetic-constrained
derived
runtime-option
existing-entity
authenticated-identity
actor-attribute
secret-reference
external-manual
```

A requirement is automatically ready only when its canonical entry is marked `generated`, contains a concrete `representativeValue`, and that value satisfies the source-derived constraint evaluator. Field requirements are created only for active editable fields on interaction screens through the final action; the terminal success-screen occurrence is probe-only. The current builder can produce representatives for supported path literals, satisfiable supported constraint sets and statically enumerated option sets. A classification name alone—especially `runtime-option` or `derived`—does not make a value ready. Dynamic options, existing entities, identities, actor attributes, product/catalog codes without a source representative and secrets require an approved binding; none may be invented.

Identifier/entity classification takes precedence over a witness assignment: a source condition such as `customerId == CUST-42` records `expectedValue: CUST-42` but never makes that ID generated, because source cannot prove the entity exists in UAT. A product/runtime option with an exact assignment follows the same external-binding rule unless a complete static option source contains the value; only then may the canonical requirement carry a representative.

Application bindings live in one ignored `.flowctl/application-data.local.yaml` file. They are project-specific, not duplicated by runtime environment. Binding and confirmation are separate operations:

```yaml
version: 1
application: sample-application
bindings:
  requirement.id:
    alias: <human-supplied-logical-alias>
    resolver: <choose-an-approved-strategy>
    value: <human-supplied-approved-non-sensitive-value>
    verified: false
```

This is deliberately schematic: every `<...>` marker is invalid until a human replaces it. Prefer `data bind`, which also writes the current `requirementDigest`. A later authorized-human `data confirm` changes `verified` to `true` and adds `confirmation.reviewer` plus `confirmation.confirmedAt`; no fabricated usable value belongs in documentation.

`data bind` always creates an unverified binding. `data confirm` adds a reviewer label and timestamp as a human attestation. Flowctl does not authenticate that label or enforce separation of duties; organizations must control who can perform confirmation. No data command accepts `--env`; the runtime environment is reserved for base URL, session and adapter/locator bindings. Runtime preparation remains blocked while any external requirement is missing or unconfirmed.

Typical application-specific bindings are a valid UAT customer/account ID, an application product code, an existing entity in a required state, an eligible actor identity or a required actor attribute. Non-sensitive values may use `value` when corporate policy permits; identities and secrets use approved `secretRef` schemes. The stable requirement ID—not an environment name—is the key.

`data plan --json` detects these obligations and returns `bindingRequests`, `confirmationRequests` and an `applicationDataConfigTemplate`. Each binding request carries the stable requirement ID, classification, any source-required expected value/attributes, allowed strategies and exact bind-command templates. The `<...>` entries in the config template are deliberately invalid until a human replaces them.

An entity-state assignment is converted to an `existing-entity` requirement only when its entity root maps to exactly one active selector/ID field. Its `expectedAttributes` records the source-required state. Flowctl validates the supplied scalar against field constraints, but it does not query UAT to verify those entity attributes; the resolver and human confirmation provide that assertion. Ambiguous selector mappings and complex relationships remain conditional rather than becoming fabricated fixture requirements.

The machine-readable shape is [application-data.schema.json](../schemas/v1/application-data.schema.json). Flowctl additionally enforces project-name matching, approved resolver strategies, requirement digests, source-derived value constraints and configured secret-reference schemes.

## Generated BDD contracts

BDD generation writes:

```text
.flowctl/generated/
  features/journeys/*.feature
  review/page-contracts/*.feature.txt
  review/conditional-journeys/*.feature.txt
  bdd-traceability.json
  step-plan.json
  steps/flowctl.steps.generated.ts
```

Runnable journey scenarios represent complete witness-backed `satisfiable` variants and carry `@source-derived @journey @implementation-required`. Page-contract scenarios and conditional journey candidates are review specifications named `.feature.txt`, carry `@review-only`, and are intentionally outside Playwright-BDD discovery. They do not claim that runtime automation already exists.

Runnable journeys identify each active editable input on interaction screens through the final action by data-requirement, field and page IDs. They emit every active merged constraint as its own step with constraint ID, kind, domain and source value when available. For a secret-bearing requirement, representative/source values are omitted and its sanitized constraint carries only traceable non-secret shape and provenance. A terminal success-screen occurrence is assertion/probe-only and contributes no input step. Read-only inputs are omitted from fill steps; a conditionally writable input blocks runtime execution instead of being assumed editable.

`step-plan.json` preserves variant, family, witness, node path, edge path, path condition, assignments, ordered pages/actions, data requirements and evidence references.

`bdd-traceability.json` maps:

- a journey feature to its family;
- each scenario tag to a variant and witness;
- the behavior node and edge path used by that witness;
- each Gherkin statement to supporting reference IDs;
- each review-only page-contract scenario to its field and constraint IDs.

Generated step definitions delegate to a `FlowRuntime` interface. An application-specific Playwright implementation is required before those steps are executable.

## Runtime grounding manifest

`ground prepare` writes a work manifest rather than a canonical artifact. It records:

```text
run, variant and representative witness IDs
environment, source/runtime-config/data and adapter digests
base URL
witness-ordered actor-session, screen-state, field and action steps
entry/intermediate/success screen probes
active interaction-field requirement, value-binding, value-resolution and adapter contracts
expected source screen, action and next screen
permitted target and adapter IDs
expected operation IDs
behavior edge and evidence references
runtime safety rules
```

For each field, `valueResolution` identifies the stable requirement ID, logical alias, approved strategy, lookup file/key and optional secret handle. Actor-session steps carry the same handoff for every `authenticated-identity` and `actor-attribute` requirement, keyed by `actorRequirementId`; an unscoped actor-data requirement blocks grounding. Raw values and raw secrets do not appear in the manifest or observation. The registered runner resolves them only in memory and echoes binding/resolution digests. `runtime.runner.envAllowlist` governs only inherited process configuration; it is not another value-resolution channel and must not carry application-specific/UAT data.

The manifest is rejected if source-derived artifacts disagree, runtime configuration changed, application data is not confirmed, an active editable interaction field through the final action lacks its required value binding, a field's writability is conditional, actor data is unscoped, or a required adapter is absent/unimplemented. The terminal success-screen occurrence is probe-only, and read-only fields do not produce fill steps. Guided execution uses `ground run`, which verifies the manifest, launches the configured no-shell argv process, requires a fresh observation and then applies the `ground record` validation boundary. Recording requires a complete ordered observation matching current source/data/adapter digests and value-binding/resolution digests. It establishes reusable runtime bindings, not proof that a later Playwright test run passed.

## Runtime bindings

`runtime-bindings.json` joins each required runtime target occurrence to a durable environment-specific adapter contract:

```text
representative witness ID, exact sequence and target kind
grounding run/manifest digest and declared adapter-runner producer
actor contract plus actor-data requirement, binding and resolution digests (when authenticated)
entry/intermediate/success screen ID and phase
field requirement/value-binding digests and availability
screen, field or action locator plus registered component adapter
unique/actionable probes, observed operation and next state
observation/source evidence references
```

Ephemeral browser snapshot references are never durable locators. Runtime bindings ground the witness; they cannot rewrite its actor contract, validations, expected operation or success meaning.

## Coverage

`coverage.json` reports scope and proof rather than a single percentage. Its current counts include:

```text
source-declared actions
handler-resolved actions
terminal operations found and included
page and actor contracts
behavior nodes and edges
families, witnesses, variants and conditional variants
data requirements and unresolved data requirements
runtime binding count
request-payload contract coverage
unresolved syntax, predicates, rejected candidates, data and controls
configured search bounds
```

Coverage identifies the first missing proof stage. When no successful variant is discovered, `flowctl repair plan` projects those rows into a bounded, source-cited assistant task; the plan does not add evidence or graph edges.

The report repeats the path-search report, exposes prune counts in `counts`, and emits `PATH_SEARCH_MAX_DEPTH_TRUNCATED` or `PATH_SEARCH_MAX_STATE_VISITS_TRUNCATED` diagnostics when a bound is reached. The `operationCoverage` table separately records each non-excluded operation's `covered`, `conditional` or `uncovered` status, family/witness/variant IDs, applicable `searchTruncationReasons`, and the first missing stage when uncovered: `frontend-client-join`, `action-operation-join`, `success-continuation`, `flow-family`, `entry-success-witness` or `behavior-variant`.
