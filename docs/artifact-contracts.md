# Artifact Contracts

## Common envelope

Every canonical JSON artifact uses:

```json
{
  "meta": {
    "artifactType": "flow-variants",
    "schemaVersion": "1.0",
    "producer": "variants:reduce",
    "producerVersion": "0.1.0",
    "sourceDigest": "sha256:...",
    "configDigest": "sha256:...",
    "inputDigests": {},
    "status": "generated",
    "unresolved": []
  },
  "data": {}
}
```

YAML artifacts use the same `meta` and `data` sections.

## Evidence graph

Contains normalized nodes and edges.

Required node categories:

```text
route, page, component, control, field, handler, predicate,
http-client-operation, java-endpoint, dto-field, validation,
permission, navigation, terminal-effect, visible-outcome
```

Important edges:

```text
renders, contains, triggers, calls, requests, handled-by,
guards, validates, requires, navigates-to, establishes,
binds-response, displays
```

An inferred Graphify edge may guide retrieval but cannot alone become an executable behavior transition.

## Operation catalog

Each operation includes:

```text
stable machine ID
HTTP method/path
frontend callers
backend handler
request/response types
authorization references
terminal effect
success/failure continuations
inclusion status
semantic business-command proposal
```

## Page contracts

Each page contains route aliases, state definitions, fields and actions. Fields retain visibility, conditional requiredness, validations, dependencies and option sources. Actions retain visibility, enablement, handler, possible effect and locator hints.

## Actor requirements

Executable actor identity is represented as authentication, roles, authorities, attributes and relationships. A semantic label such as “eligible applicant” is separate from those exact requirements.

## Behavior graph

Nodes are screen states, actions, operations and outcomes. Edges carry a structured guard, effects, outcome category and evidence references.

## Path witnesses

A witness records one successful symbolic route through the behavior graph:

```text
entry state
selected edges
accumulated path condition
representative assignments
derived response bindings
success node
feasibility status
```

## Flow variants

Variants are equivalence classes of witnesses sharing a behavior signature. A variant must have at least one witness. Two variants must not have the same signature.

## Data requirements

Classifications:

```text
flow-literal
synthetic-constrained
derived
runtime-option
existing-entity
authenticated-identity
secret-reference
external-manual
```

Only the first three may be generated without an approved resolver. Existing entities, identities and secrets cannot be invented.

## Runtime bindings

A durable binding joins a source action to a runtime control contract:

```text
screen signature
role/label/test ID locator contract
component adapter
unique/actionable result
observed network operation
observed next state
observation evidence
```

Ephemeral browser snapshot references are never committed as durable locators.

## Coverage

Coverage reports scope and proof, not a single percentage:

```text
source-declared actions
handler/effect-linked actions
terminal operations found and included
satisfiable/conditional/impossible combinations
generated variants
data-ready variants
runtime-grounded variants
unresolved syntax, predicates, data and controls
search bounds
```
