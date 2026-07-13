# Agentic BDD Flowctl

`flowctl` is a local, source-grounded compiler that sits between a code knowledge graph and executable BDD:

```text
React + Java source
        +
Graphify structural graph
        +
implementation-derived LLM Wiki
        ↓
      flowctl
        ↓
evidence → page/actor contracts → behavior graph
        → happy-path witnesses → distinct flow variants
        → data requirements → BDD → Playwright grounding
```

The current goal is happy-path discovery and BDD generation from source. Bug finding is intentionally a later consumer of the same evidence and behavior models.

## Why this exists

A browser-only agent sees only the current page, actor and data state. It cannot reliably discover hidden branches, backend validation, permission requirements, custom component behavior or unavailable UAT entities.

`flowctl` combines static evidence with bounded semantic reasoning and runtime confirmation:

- Deterministic code extraction owns routes, handlers, predicates, validations and endpoint joins.
- The LLM proposes vocabulary, aliases and readable business names; it cannot invent executable rules.
- Humans approve important operations, ambiguous semantic groupings and environment-specific data access.
- Playwright confirms controls and transitions only after a source-derived path witness exists.

## Status

This repository contains the initial vertical-slice implementation and an account-opening fixture. It supports:

- Graphify graph import with extracted/inferred provenance preservation
- React route, field, action, handler, navigation and HTTP-call extraction
- Java Spring-style endpoint, authorization and Bean Validation extraction
- Cross-layer endpoint joining
- Page and actor contracts
- Symbolic behavior graph construction
- Successful path witnesses and behavior-signature variant reduction
- Test-data requirement classification
- Agent reasoning packets for Copilot/Roo/Cline without a direct LLM API
- Journey BDD generation
- Composable parameterized step-definition generation through a `FlowRuntime` adapter contract
- Runtime grounding preparation and observation import
- Coverage and unresolved-scope reporting

Unsupported dynamic behavior remains explicit and unresolved; it is never silently guessed.

## Quick start

```bash
npm install
npm run build
npm test

# Run the included React/Java source fixture.
npm run demo
npm run demo:bdd
```

Inspect the result:

```bash
node --import tsx src/cli.ts status --config examples/account-opening/flowctl.config.yaml
node --import tsx src/cli.ts explain flow application.submit.joint --config examples/account-opening/flowctl.config.yaml
```

For a real application:

```bash
cp flowctl.config.example.yaml flowctl.config.yaml
# Edit source roots and optional Graphify/LLM Wiki paths.
node --import tsx src/cli.ts analyze --through variants
```

## Primary commands

```text
flowctl init
flowctl doctor
flowctl analyze [--through <stage>]
flowctl status
flowctl next

flowctl packet inspect <packet-id>
flowctl packet validate <packet-id>
flowctl review approve <packet-id>

flowctl data plan --flow <variant> --env <environment>
flowctl data bind --requirement <id> --alias <alias> --resolver <provider> --env <environment>
flowctl data verify --flow <variant> --env <environment>
flowctl ground prepare --variant <variant> --env <environment>
flowctl ground record --run <run-id> --observation <file>

flowctl bdd generate [--flow <family>]
flowctl execution-plan --variant <variant> --env <environment>
flowctl coverage
flowctl explain <kind> <id>
```

All commands support structured artifacts; agent-facing commands also support `--json` where useful.

## Canonical artifacts

```text
.flowctl/artifacts/
  evidence-graph.json
  operation-catalog.yaml
  page-contracts.json
  actor-requirements.json
  behavior-graph.json
  flow-families.json
  path-witnesses.json
  flow-variants.json
  data-requirements/
  runtime-bindings.json
  coverage.json
```

Canonical artifacts are generated. Human decisions live separately under `.flowctl/decisions/`, and concrete environment bindings live in ignored `*.local.yaml` files.

## Corporate deployment model

The CLI makes no model call by default. When semantic reasoning is useful, it writes a bounded packet containing allowed evidence IDs, allowed output fields and a response schema. A VS Code assistant reads the packet, writes a proposal, and `flowctl` validates it before continuing.

This permits Copilot, Roo/Cline or another approved assistant to be swapped without making the conversation the system of record.

Secrets, credentials, session state and raw UAT identifiers must not appear in features, packets or committed artifacts. Environment bindings use aliases and approved secret/data providers.

## Documentation

- [Architecture](docs/architecture.md)
- [Artifact contracts](docs/artifact-contracts.md)
- [Agent workflow](docs/agent-workflow.md)
- [Implementation plan](PLAN.md)

## Deliberate boundaries

- The first release targets React/TypeScript frontends and Spring-style Java backends.
- Built-in extractors are conservative. Dynamic dispatch, reflection, server-driven UI and opaque validators are reported rather than guessed.
- Mutation-seeded discovery does not yet represent every read-only journey. Additional terminal types are part of the roadmap.
- Playwright CLI is a runtime grounding tool, not the source of business semantics.
