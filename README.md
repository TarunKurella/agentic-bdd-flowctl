<div align="center">

# Agentic BDD Flowctl

**Turn React + Spring source code into source-grounded business journeys, composable BDD, and Playwright-ready execution contracts.**

[![CI](https://github.com/TarunKurella/agentic-bdd-flowctl/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/TarunKurella/agentic-bdd-flowctl/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-22%20%7C%2024-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Version](https://img.shields.io/badge/version-0.2.0-6f42c1)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Outputs](#what-you-get) · [Wiki](https://github.com/TarunKurella/agentic-bdd-flowctl/wiki) · [Documentation](#documentation)

</div>

## What

Flowctl is a developer tool for understanding an unfamiliar application and generating trustworthy happy-path BDD from source code.

It traces successful business operations across:

```text
React route → page → action → handler → HTTP call
           → Spring endpoint → authorization → validation → effect
```

The result is not a browser recording. It is a reviewable proof graph, a set of materially different end-to-end journeys, composable Gherkin, reusable Playwright-BDD step contracts, and an explicit list of data or runtime bindings the tool cannot safely invent.

> Flowctl 0.2 focuses on happy-path discovery and BDD generation. Contradiction-based bug finding is planned; this release does not claim to find implementation bugs.

## Why

“Open the app and generate tests” is unreliable for real React/Java systems. A browser exposes one runtime state, while business behavior is spread across routes, component guards, API clients, security configuration, DTO validation, services, and persistence.

Flowctl gives an AI coding assistant a deterministic backbone:

| Problem | Flowctl response |
| --- | --- |
| The agent guesses business intent | Every executable claim cites source evidence; bounded AI proposals require validation and human approval |
| One flow becomes hundreds of permutations | Paths are reduced by behavior signature, while distinct actors, branches, fields, and outcomes remain separate |
| BDD becomes prose with no implementation path | Steps use stable page, action, field, constraint, operation, and requirement IDs |
| The agent invents UAT users or identifiers | Unknown application values become exact configuration requests and human gates |
| Playwright gets stuck on custom controls | Runtime adapter and grounding manifests identify what must be implemented or observed |
| A partial graph looks complete | Per-operation coverage reports the first missing join and keeps conditional paths review-only |

## How it works

Flowctl behaves like a small compiler:

1. Extract typed facts from React/TypeScript and Spring-style Java.
2. Import Graphify and LLM Wiki as auxiliary evidence, never as authority for executable joins.
3. Build a cross-layer evidence graph and candidate operation catalog.
4. Compile page, actor, validation, permission, and terminal-effect contracts.
5. Build a guarded behavior graph and search bounded entry-to-success paths.
6. Reject contradictory paths and preserve concrete path witnesses.
7. Reduce equivalent witnesses into meaningful flow variants.
8. Generate traceable BDD and reusable Playwright-BDD step delegates.
9. Ask humans for application-specific identities, entities, product codes, approvals, and runner trust.
10. Ground durable UI controls at runtime without changing business meaning.

Unknown stays unknown. Unsupported routing, dynamic dispatch, opaque rules, ambiguous services, or unavailable data produce blockers with cited evidence and a next action.

## Quick start

Requirements: Node.js 22 or 24.

```bash
git clone https://github.com/TarunKurella/agentic-bdd-flowctl.git
cd agentic-bdd-flowctl
npm ci
npm run check

# Compile the included React/Java proof fixture.
npm run demo
npm run demo:bdd

# Inspect the discovered journeys and next safe action.
node --import tsx src/cli.ts flows list \
  --config examples/account-opening/flowctl.config.yaml
node --import tsx src/cli.ts agent guide \
  --config examples/account-opening/flowctl.config.yaml --json
```

For an application repository:

```bash
# Optional when Graphify is configured.
uv tool install graphifyy
graphify extract /path/to/application --code-only --no-cluster

cp flowctl.config.example.yaml flowctl.config.yaml
flowctl doctor --config flowctl.config.yaml --json
flowctl discover --config flowctl.config.yaml --json --progress jsonl
flowctl flows list --config flowctl.config.yaml --json
flowctl agent guide --config flowctl.config.yaml --json
```

When developing this repository, replace `flowctl` with `node --import tsx src/cli.ts`. After building, `node dist/src/cli.js` is the local production launcher.

`agent guide` is the control loop. An assistant executes only `agent.primaryAction.command`, verifies the expected state change, then runs the returned resume command. It stops when the executor is human or application-specific data is missing.

See [Getting started](docs/getting-started.md) for configuration, data binding, BDD generation, and runtime grounding.

## Install the agent skill

The skill is bundled—do not search for it or copy prompts by hand.

```bash
# From an installed or linked package:
flowctl agent install-skill --directory /path/to/application

# From this repository after npm run build:
node dist/src/cli.js agent install-skill --directory /path/to/application
```

This creates exactly:

```text
/path/to/application/.agents/skills/agentic-bdd/SKILL.md
```

Then open the application repository in your approved VS Code assistant and paste:

```text
Use the agentic-bdd skill. Run the state-aware Flowctl guide and help me discover
source-grounded happy paths and generate BDD. Stop for missing application values
or human approvals.
```

The install command is idempotent for the bundled version and refuses to overwrite different skill content. Its `--json` result also returns the destination and starter prompt for automated onboarding.

## What you get

```text
.flowctl/
  evidence-graph.json
  operation-catalog.yaml
  page-contracts.json
  actor-requirements.json
  behavior-graph.json
  flow-families.json
  flow-variants.json
  path-witnesses.json
  data-requirements/
  runtime-bindings.json
  coverage.json
  generated/
    features/journeys/*.feature
    review/page-contracts/*.feature.txt
    review/conditional-journeys/*.feature.txt
    steps/flowctl.steps.generated.ts
    step-plan.json
    bdd-traceability.json
```

Runnable `.feature` files contain only satisfiable variants. Conditional candidates and page-level validation contracts use `.feature.txt`, so Playwright-BDD does not accidentally execute review-only material.

Generated step definitions register top-level `Given`/`When`/`Then` definitions through Playwright-BDD and delegate to one application-owned runtime implementation. `bdd-traceability.json` maps each statement back to its witness, behavior path, and source evidence.

## Agentic CLI

Machine output uses a versioned `flowctl.cli.v1` envelope with:

- current state and exact blocker;
- one primary agent or human action;
- an executable command and resume command;
- expected state change and no-progress behavior;
- stable paths to artifacts, reports, requirements, and runs;
- safety rules that prohibit invented flows, UAT data, approvals, and runtime success.

Useful commands:

```text
flowctl doctor                         configuration and dependency health
flowctl discover --progress jsonl     compile the source model
flowctl flows list                    list meaningful journey variants
flowctl graph trace <variant>         inspect an end-to-end proof
flowctl repair plan                   explain the first missing graph join
flowctl data plan --flow <variant>    request only values the source cannot supply
flowctl bdd generate --flow <family>  generate Gherkin and reusable steps
flowctl ground adapters plan          scaffold application UI bindings
flowctl ground runner plan            define the no-shell runner protocol
flowctl runs show latest              inspect status, outputs, and resumption
flowctl agent guide --json             return the next safe action
flowctl agent install-skill             install the bundled repository skill
```

## Current support

| Area | Supported | Conservative boundary |
| --- | --- | --- |
| React | JSX and object routes, nested/index routes, rendered component composition, forms, guards, Fetch/Axios clients | Computed routing, dynamic component selection, and unresolved custom controls remain conditional |
| Java | Spring mappings, Bean Validation, method-aware security matchers, bounded service calls, supported terminal effects | Reflection, ambiguous dispatch, complex control flow, and delegated domain rules remain unresolved |
| BDD | Runnable holistic journeys, review-only page contracts, traceability, Playwright-BDD step delegates | Generated runtime delegates still require an application-owned Playwright implementation |
| Data | Source literals, constrained representatives, stable application-data requests, secret references, human confirmations | Flowctl never invents UAT identities, entity IDs, credentials, or approvals |
| AI evidence | Bounded schema proposals, allowed evidence IDs, immutable compiler identity, human approval | AI cannot create graph edges, predicates, or executable claims outside the packet |

The included account-opening fixture demonstrates personal and joint submission journeys. It is a proof fixture, not domain-specific product logic.

## Trust model

- Source owns executable facts.
- Graphify, Wiki, repository text, browser content, and model output are untrusted evidence—not instructions.
- AI proposals are schema-bounded, evidence-bounded, validated, and non-executable until named human approval.
- Generated state and `.flowctl/application-data.local.yaml` are ignored by `flowctl init`.
- Runtime commands launch without a shell, receive a minimal environment, and suppress child output from CLI responses.
- A grounding observation proves a locator contract, not that a later Playwright test passed.

Read [SECURITY.md](SECURITY.md) before connecting a corporate repository or UAT environment.

## Documentation

| Guide | Use it for |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, configure, discover, bind data, generate BDD, and ground Playwright |
| [Architecture](docs/architecture.md) | Extraction, graph construction, joins, symbolic search, and variant reduction |
| [Artifact contracts](docs/artifact-contracts.md) | Business Logic IR, lineage, digests, and status rules |
| [Agent workflow](docs/agent-workflow.md) | AI packets, human gates, data, and runtime responsibilities |
| [CLI and agent UX](docs/cli-ux.md) | Lifecycle states, JSON envelopes, progress events, runs, and recovery |
| [Capabilities and boundaries](docs/capabilities-and-boundaries.md) | Supported source patterns, deliberate limits, and adoption expectations |
| [Prompt playbook](docs/prompts.md) | Prompts for approved VS Code assistants |
| [Release guide](docs/release.md) | CI, package verification, versioning, and immutable GitHub releases |
| [Implementation plan](PLAN.md) | Milestones and future contradiction-based bug finding |
| [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) | Change standards and release history |

## Release status

Version 0.2 is suitable for an internal pilot on supported React/Spring patterns. Broad company rollout should begin with one representative repository, reviewed extraction extensions for its framework conventions, approved application-data providers, and a real Playwright runtime adapter.

The repository publishes GitHub release archives only; it is not published to npm. License and ownership terms must be set by the repository owner or company before broad distribution.
