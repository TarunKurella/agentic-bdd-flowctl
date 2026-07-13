# Architecture

## System boundary

`flowctl` is a staged compiler and evidence ledger. It is not a free-roaming browser agent.

```text
Graphify structural graph ─┐
React/Java source ─────────┼─→ Evidence Graph
LLM Wiki aliases ──────────┘          ↓
                              Contracts and operations
                                       ↓
                              Symbolic Behavior Graph
                                       ↓
                      Successful witnesses and variants
                            ↙                    ↘
                   Data obligations             BDD
                            ↘                    ↙
                             Runtime grounding
```

Graphify narrows source retrieval and supplies structural relationships. Language adapters add framework-specific evidence that a general graph cannot safely infer: JSX event bindings, React navigation, Spring request mappings, Bean Validation and authorization.

The LLM Wiki is an implementation-derived vocabulary cache. It may connect names such as `coApplicant`, `jointApplicant` and “second holder”; it is never authoritative for executable predicates.

## Core algorithm

For terminal operation `o`:

```text
Relevant(o) = ForwardReachable(entries) ∩ BackwardReachable(success(o))

HappyPaths(o) = {
  p in Relevant(o)
  | conjunction(guards(p)) is satisfiable
  | p reaches authoritative success
  | p contains no error/cancel outcome
}

Variants(o) = group HappyPaths(o) by behavior signature
```

Behavior signature:

```text
actor requirements
+ ordered page/state sequence
+ ordered business actions
+ active field and validation sets
+ payload shape
+ backend operations
+ domain transition
+ visible success outcome
```

Different values with the same signature become data cases, not separate journeys.

## Pass dependency graph

```text
source:snapshot
├── graphify:import
├── react:extract
├── java:extract
└── wiki:import

imports/extracts → evidence:link → evidence-graph.json
evidence          → operations:discover → operation-catalog.yaml
evidence          → pages:build → page-contracts.json
evidence          → actors:build → actor-requirements.json
operations/pages/actors → behavior:build → behavior-graph.json
behavior/operations     → families:discover → flow-families.json
behavior/families       → paths:search → path-witnesses.json
witnesses               → variants:reduce → flow-variants.json
variants/pages/actors   → data:plan → data-requirements/
variants/data/browser   → runtime:ground → runtime-bindings.json
all artifacts           → coverage:build → coverage.json
```

## Pass categories

### Deterministic

Owns extraction, linking, predicate normalization, symbolic search, signatures, validation and rendering.

### Semantic

Proposes labels, aliases, bounded-context names and readable BDD wording. Semantic output must cite existing evidence IDs and cannot introduce predicates or edges.

### Review

Approves important terminal operations, ambiguous concept grouping, opaque hard predicates and environment mutation policies.

### Runtime

Confirms current screen state, durable locator contracts and observed transition effects. It cannot rewrite source-derived flow meaning.

## State model

A screen state is not merely a route:

```text
route pattern
+ wizard step
+ relevant tab/dialog
+ business discriminator values
+ actor capabilities
+ entity state
+ active field/action set
```

Only state that can influence the behavior signature is retained. This controls path explosion.

## Conservative analysis

The engine uses tri-state feasibility:

- `satisfiable`: supported constraints have a model.
- `unsatisfiable`: the path is discarded with a reason.
- `conditional`: opaque predicates or unresolved dispatch remain; the path is retained but cannot be called completely verified.

Loops are bounded and summarized. Repeated row actions become parameterized action templates. A loop creates a separate variant only when cardinality changes pages, validations, payload or outcome.

## Trust model

Every nontrivial claim carries:

```text
origin
source references
confidence
producer pass/version
source digest
input artifact digests
unresolved items
```

Generated artifacts are immutable outputs. Human decisions and environment bindings are separate inputs. Source changes mark dependent outputs stale rather than overwriting reviewed meaning silently.
