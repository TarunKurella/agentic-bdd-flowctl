# Architecture

## System boundary

`flowctl` is a staged compiler, proof ledger and guided CLI. It is not a free-roaming browser agent.

```text
React/TypeScript source ────────────┐
Java/Spring source ─────────────────┼─→ Evidence Graph
Graphify auxiliary evidence ────────┤        ↓
LLM Wiki glossary/labels ───────────┘   Contracts + operations
                                             ↓
                                    Behavior Graph
                                             ↓
                                    Path witnesses
                                             ↓
                                      Flow variants
                                      ↙          ↘
                             data obligations    BDD + traceability
                                      ↘          ↙
                                  runtime grounding
```

The compiler separates four kinds of knowledge:

1. **Source facts** describe routes, controls, handlers, API calls, endpoints, guards, validation and effects.
2. **Auxiliary evidence** from Graphify is imported into the evidence graph. In v0.2 it does not narrow source retrieval or drive framework joins.
3. **Semantic label evidence** from an LLM Wiki supplies glossary concepts and may enrich readable operation labels. In v0.2 it does not normalize or join names across layers.
4. **Runtime observations** confirm how a source-derived action is located and what it does in one environment.

Only source-supported facts can create executable behavior. Graphify, Wiki text and browser content are evidence inputs, not instructions to an assistant.

## Why two graphs exist

The evidence graph and behavior graph solve different problems.

### Evidence graph: what the implementation says

The evidence graph preserves cross-layer facts and provenance. Current source adapters emit source files, routes, pages, controls, fields, handlers, request payloads/HTTP calls, Java endpoints, navigation, validations, permissions and terminal effects, plus imported Wiki concepts/Graphify evidence. The broader schema also reserves component, predicate, DTO-field and visible-outcome nodes for adapters that can prove them. Current source edges cover rendering/containment, triggering/calls/requests, endpoint handling, validation/authorization, navigation and terminal effects; other schema edge kinds remain available without being fabricated.

An evidence edge answers a question such as:

```text
Which JSX control triggers this handler?
Which handler calls this API client?
Which Java endpoint handles that method and normalized path?
Which successful effect and UI state follow the endpoint?
```

Each nontrivial node and edge retains source references. The graph is therefore an index of claims with locations, not an AI summary detached from code.

### Behavior graph: what a user can successfully do

The behavior graph is an executable abstraction. Its nodes are screen states, actions, operations and outcomes. Its directed edges contain:

```text
guard predicate
state/data effects
outcome category
evidence references
```

A v0.2 `screen-state` node identifies a page and stores its route patterns/completeness. Within a witness, the accumulated path condition and active page contract make that occurrence more precise than the URL alone:

```text
page/route pattern
+ accumulated branch/discriminator predicates
+ actor and entity prerequisites
+ active field/action contract
```

The compiler does not clone a separate graph node for every discriminator value; occurrence meaning comes from the node plus the witness path.

This graph excludes semantic evidence that cannot represent a user transition. For example, a Wiki alias may support a readable label, but it cannot join a client to an endpoint or make a disabled button executable.

## Graph creation pipeline

### 1. Snapshot the source

The source pass inventories configured frontend and backend roots and fingerprints every configured evidence input, including Graphify output and LLM Wiki files. Every downstream artifact records that digest. A code, graph or Wiki change makes dependent output stale rather than silently preserving an outdated proof.

### 2. Import auxiliary evidence

Graphify contributes imported files, symbols and relationships to `evidence-graph.json`. In v0.2 those nodes and edges are retained for inspection and provenance only: source snapshotting and React/Java extraction still scan the configured roots, and executable joins do not consult Graphify. An inferred Graphify edge cannot become a behavior transition.

The LLM Wiki importer reads Markdown/text headings plus nearby `Aliases:` lines as glossary concepts. An exact normalized match between a concept/alias and an extracted effect entity may enrich the readable operation label. Wiki data does not connect React, HTTP and Java symbols, group flow families, or supply an executable predicate, actor permission, validation rule or successful effect.

This boundary avoids circular confidence: a model-generated Wiki derived from the code cannot independently prove that the code is correct.

### 3. Extract framework facts

React/TypeScript adapters extract routes, pages, fields, JSX actions, visibility and enablement conditions, handler chains, navigation and HTTP calls. Java/Spring adapters extract request mappings, DTOs, Bean Validation, authorization, bounded domain guards, domain calls and success effects. A supported top-level `if (condition) throw ...` becomes `not(condition)` on the successful branch. Other control flow, named rule calls and expressions the predicate compiler cannot reduce remain opaque and make the affected operation/flow conditional.

The extractors are deliberately conservative. Unsupported dynamic dispatch, reflection, server-driven UI or opaque predicates become diagnostics instead of invented edges. An unresolved custom React child component makes its page incomplete. `analysis.transparentComponents` may suppress that blocker only for a reviewed presentation/container component known to add, hide or transform no user interaction; it does not extract the child's internals.

### 4. Join the layers

The linker joins frontend HTTP operations to Java endpoints using normalized method and path templates. It then connects the complete chain:

```text
route → page → control → handler → HTTP operation
      → Java endpoint → permission/validation → terminal effect → visible outcome
```

This chain is the primary evidence for business intent. Button text alone does not define a business command. The combination of endpoint, authorization, domain effect and visible success is much stronger evidence.

Actors are derived the same way. Extracted backend authorization is primary actor evidence and frontend guards can corroborate authorities. The v0.2 actor artifact models authentication, roles/authorities and opaque authorization predicates; it does not derive relationship contracts. Actor-rooted assignments from a successful witness are carried separately as variant/data requirements. Opaque domain rules remain conditional. UI wording supplies only a readable label.

### 5. Build contracts and operations

Page contracts collect fields, conditional requiredness, validations, dependencies, option sources and actions. Actor contracts collect authentication, roles, authorities and unresolved authorization predicates; witness-specific actor attributes become data requirements. Relationship extraction is not implemented in v0.2. The operation catalog records successful backend commands, their frontend caller IDs, backend endpoint/effect IDs and request-payload contract IDs; endpoint request/response types remain in evidence.

### 6. Build the behavior graph

The builder turns source-supported controls and navigation into guarded state transitions. Business operations appear explicitly between their triggering action and authoritative success state. The edge schema distinguishes neutral, success, error and cancel outcomes, and path search excludes error/cancel edges. The v0.2 source builder currently emits supported neutral/success transitions; explicit error/cancel transition extraction is not implemented and must not be inferred from UI text.

### 7. Search for witnesses

For terminal operation `o`:

```text
Relevant(o) = ForwardReachable(entries) ∩ BackwardReachable(success(o))

HappyPaths(o) = {
  p in Relevant(o)
  | p traverses operation o
  | p ends on the success transition for o
  | conjunction(guards(p)) is satisfiable
  | p contains no error or cancel outcome
}
```

Every surviving path becomes a witness containing the exact node path, edge path, accumulated condition, representative assignments, evidence references and feasibility status. Entry, operation and success nodes are recovered from that ordered path rather than duplicated as fields.

The solver uses three feasibility states:

- `satisfiable`: supported constraints have a model;
- `unsatisfiable`: contradictory guards discard the path;
- `conditional`: an opaque or unsupported predicate remains, so the route is inspectable but not completely verified.

Graph traversal is bounded by path depth and state-visit limits. The witness and coverage artifacts report exact prune counts plus deterministic family/node/edge details, so a bound-limited search is distinguishable from a disconnected graph. Dynamic repeated-row action templates and row/entity-scoped locator parameterization are not implemented in v0.2; those controls require explicit extractor/runtime support and must not be guessed. Search bounds and unresolved predicates remain visible in coverage.

### 8. Reduce paths into flow variants

Witnesses for the same business command are grouped by behavior signature:

```text
actor requirements
+ ordered page/state sequence
+ ordered business actions
+ active fields and validations
+ request/payload shape
+ backend operations and domain transition
+ visible success outcome
```

Different values with the same signature become data cases, not duplicated journeys. A branch creates a new variant only when it changes behavior that matters to the contract. This is controlled equivalence-class generation, not a Cartesian product of every field value.

## Source-to-BDD proof

BDD generation consumes flow variants and their representative witnesses; it does not ask an LLM to invent a journey from page names.

```text
data requirements         → Given readiness step
actor requirements        → Given actor contract step
representative assignment → Given flow-choice step
active interaction field  → When source-valid input + constraint steps
interaction page/action   → When complete-page/action steps
operation/effect          → Then business outcome step
terminal success page     → Then displayed step
page contract             → review-only field/validation specification
```

The compiler emits runnable journey features under `.flowctl/generated/features/journeys/` only for `satisfiable` variants. It emits conditional journey candidates and page-contract specifications as `.feature.txt` under `.flowctl/generated/review/`, intentionally outside Playwright-BDD discovery. It also emits a reusable step plan, generated step-definition delegates and `bdd-traceability.json`. The traceability artifact maps each generated or review Gherkin statement to witness, behavior node/edge and evidence IDs.

Runnable journey features are tagged `@source-derived @journey @implementation-required`. Conditional journey and page-contract `.feature.txt` files are tagged `@review-only` and are not runnable features. This is an honesty boundary: source-grounded Gherkin and generated delegates do not prove that the application-specific Playwright `FlowRuntime` adapter has been implemented or grounded.

Use these inspection commands before trusting a generated scenario:

```bash
flowctl flows list
flowctl graph summary
flowctl graph trace <variant-id>
flowctl bdd generate --flow <family-id>
```

## Agentic CLI state machine

The CLI derives guidance from artifact freshness, the selected variant, one project-specific application-data file, and runtime-environment bindings:

```text
ANALYSIS_REQUIRED
        ↓ discover/analyze
FLOW_SELECTION_REQUIRED
        ↓ flows list + select variant
BDD_GENERATION_REQUIRED
        ↓ bdd generate
REVIEW_REQUIRED (conditional variants only)
        ↓ resolve source/evidence gap + rediscover
DATA_REQUIRED
        ↓ application data bind + human confirmation
RUNTIME_GROUNDING_REQUIRED
        ↓ adapter plan/verify + runner config + ground prepare/run
EXECUTION_PLAN_REQUIRED
        ↓ execution-plan
READY (ready for a Playwright run; no pass claim)
```

`flowctl guide` shows the complete state, blockers and ordered actions. `flowctl next` returns one primary action. `flowctl agent prompt` converts the same state into a bounded, copy-ready assistant prompt. The prompt is therefore a view of compiler state, not a second workflow engine.

Packets are orthogonal review work. Label packets request labels, aliases, family hints or explanations and cannot change executable graph meaning. Rule packets are created only for compiler-detected conditional authorization or successful-acceptance gaps. They can select a bounded authorization shape or a predicate in the existing exact grammar, but only for packet-listed endpoints, evidence IDs and request paths. Validation rejects new paths and silent omissions; named human approval plus deterministic recompilation is required before the accepted fact reaches evidence, actors, behavior, witnesses, variants, data requirements or BDD. Neither packet type can add graph edges, validation values, runtime success or application data. A family hint remains reviewed metadata and does not override operation-based family construction.

## Runtime grounding boundary

Runtime preparation is allowed only after required application data has been bound and explicitly confirmed. Application data lives once in `.flowctl/application-data.local.yaml` and is not selected or duplicated by `--env`. It includes application-specific facts such as a valid UAT account/customer ID, a product code, an existing entity in a required state, or an eligible actor/actor attribute. Runtime environment separately selects the base URL, session context and durable control bindings. A grounding manifest contains the selected variant, runtime environment, source digest and a complete witness-ordered interaction contract: authenticated actor setup when required, entry/intermediate/success screen probes, every active editable field on interaction screens through the final action with its requirement/value-binding digests, and every action. The terminal success-screen occurrence is probe-only and creates no fill/data obligation. Read-only fields do not create fill targets or occurrence data; a conditionally writable field blocks for source review. A field also carries a bounded resolution handoff (logical alias, approved strategy, lookup file/key and optional secret handle) without a raw value. Each target must name a registered adapter whose implementation is statically present and whose digest is current.

Entity-state predicates become an `existing-entity` obligation only when the predicate's entity root maps to exactly one active selector/ID field. The data requirement records the expected attribute, but Flowctl does not query the target system to prove the bound entity satisfies it; the approved resolver and named human confirmation own that assertion. Ambiguous selector matches and relationship predicates remain conditional.

Runtime may confirm or repair:

- durable locator strategy;
- component adapter;
- adapter-internal readiness/wait logic (not a persisted observation field);
- screen signature;
- observed network operation and next state.

Runtime may not change:

- actor eligibility;
- path meaning;
- source-derived validation;
- expected backend effect;
- success outcome.

Flowctl does not embed a browser engine. `runtime.runner` names an organization-approved executable and an argv array containing `{manifest}` and `{observation}`. `ground run` binds those placeholders to absolute work paths and launches the process with `shell: false`, verifies a fresh bounded regular observation file, then applies the recording contract. The runner is a trusted extension boundary: its child process receives only defined values from Flowctl's minimal built-in process allowlist plus names explicitly added through `runtime.runner.envAllowlist` (empty by default). Application-specific values do not cross that process-environment boundary; they remain in the ignored application-data store and digest-bound manifest handoffs. Version 0.2 permits one named runtime target per config: `--env` must equal `runtime.environment`, and another target/base URL needs a separate config file. Runtime manifests and execution plans use `runtimeConfigDigest`; changing runner, its environment allowlist, base URL, environment or adapters invalidates runtime work without making the static source model stale.

The Playwright run plan becomes `ready-for-playwright-run` only when confirmed data and every required actor-session, screen-state, interaction-field and action occurrence have exact current bindings. The terminal success screen needs only its probe binding. Recorded observations are auditable assertions from the registered adapter runner; hand-authored JSON is not independent execution proof, and readiness does not claim that a Playwright run happened or passed.

The current data IR keys fields by variant + page + field, not by witness visit. A witness that revisits the same active field is therefore runtime-blocked with `RUNTIME_REVISIT_VALUE_CONTRACT_UNSUPPORTED`; reusing the first visit's value would be an unsupported assumption. A journey with multiple authenticated actor contracts is also blocked until the witness orders actor-switch transitions. Likewise, a success with no source-supported post-action screen stays runtime-blocked until an operation-response/outcome probe contract exists.

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
variants/witnesses      → bdd:generate → features + step plan + traceability
variants/data/witness/browser → runtime:ground → runtime-bindings.json
all artifacts           → coverage:build → coverage.json
```

`coverage.json.operationCoverage` reports every non-excluded backend operation as `covered`, `conditional` or `uncovered`. An uncovered row identifies the first missing stage: frontend-client join, action-operation join, success continuation, flow family, entry-to-success witness or behavior variant. The guide returns to `ANALYSIS_REQUIRED` while any in-scope operation is uncovered, preventing a partial set of happy paths from being presented as complete coverage.

## Trust and freshness model

Every nontrivial canonical claim carries origin, source references, confidence, producer/version, source digest, input artifact digests and unresolved items. Generated artifacts are immutable outputs. Human decisions and the ignored project-specific application-data file are separate inputs; runtime observations remain environment-specific.

The CLI machine contract is separate from artifact envelopes. `--json` wraps command results in `flowctl.cli.v1`, including project/target context, next actions and diagnostics. See [CLI and agentic UX](cli-ux.md) and [artifact contracts](artifact-contracts.md).
