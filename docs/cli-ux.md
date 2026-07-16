# CLI and Agentic UX

## UX goal

The CLI should let a developer or coding assistant answer five questions at any time:

1. What source-grounded model exists?
2. Which materially different flows were discovered?
3. Why does a selected flow exist?
4. What blocks BDD or execution for this variant and environment?
5. What is the single safest next action?

The experience is state-driven rather than chat-driven. Conversation is not the system of record; source digests, artifacts, review decisions, local data bindings and runtime observations are.

## First-run experience

```bash
flowctl init
flowctl doctor --config flowctl.config.yaml
flowctl discover --config flowctl.config.yaml --progress jsonl
```

`discover` is the onboarding command. It runs static analysis through coverage, prints an evidence/behavior graph summary and ends with the guided lifecycle view. It does not open a browser or invent application data.

`doctor` returns a readiness summary plus structured checks. A non-OK check names its exact `configKeys`, affected `paths` and a safe `fix`; it does not merely say that runtime or source configuration is invalid. Its `paths` object points to the configuration, project/output roots, coverage report, unresolved data requirements, application-data file and run directory.

If analysis has already run, use the smaller inspection commands:

```bash
flowctl status --config flowctl.config.yaml
flowctl graph summary --config flowctl.config.yaml
flowctl flows list --config flowctl.config.yaml
```

## Select a target

Guidance becomes precise only after selecting a variant and runtime environment. Version 0.2 supports one named runtime target per config, so `--env` must equal `runtime.environment`; use a separate config file for another target/base URL. The environment controls runtime URL/session/bindings; it does not select application data:

```bash
flowctl guide \
  --variant <variant-id> \
  --env <environment> \
  --config flowctl.config.yaml
```

When exactly one variant exists, the guide can select it automatically. When several exist, it stops at `FLOW_SELECTION_REQUIRED` and sends the user to `flows list`. This prevents the tool from mixing data or runtime state across behaviorally different paths.

The three lifecycle commands share the same state engine:

| Command | Intended use |
| --- | --- |
| `flowctl status` | Show artifact lifecycle, inventory, target readiness and blockers. |
| `flowctl guide` | Show the full dashboard plus ordered exact actions and agent handoff. |
| `flowctl next` | Show only the primary action, its reason and follow-up commands. |

All accept optional `--variant`, `--env`, `--config` and `--json`.

The guide result contains a top-level `paths` object for the coverage report, generated BDD, unresolved data-requirement directory, application-data file and run history. When a variant is selected, `selectedVariant.data.requirementsPath` identifies its exact canonical requirement file. Blockers may carry `configKeys` and `paths` in addition to their stable code and resolution.

## Agent execution directive

Every current `--json` response contains a top-level `agent` object with schema `flowctl.agent.v1`. This is the control protocol for an LLM caller, not explanatory decoration:

```text
disposition            execute | inspect | stop-for-human | complete
directiveId            stable fingerprint of result, state, target, action and diagnostics
primaryAction          the only action the agent may execute from this response
instruction            task-specific reasoning boundary for that action
afterAction             expected state change, exact resume command, no-progress rule
retryPolicy             at most one attempt without state change
stopConditions          human/data/security/evidence/non-progress gates
guardrails              invariant restrictions that apply to every action
```

The directive's primary command includes `--json`, even when the corresponding human-facing `nextActions` command omits it. After execution, the caller verifies the stated postcondition and runs the exact resume command. For flow selection, the resume command contains `SELECTED_VARIANT_ID`, which must be replaced with an ID returned by the current flow catalog. If the same `directiveId` recurs without a relevant source, config, decision, data or artifact change, the caller reports `NO_PROGRESS` and does not retry.

Failure envelopes use the same protocol. Invalid arguments direct the agent to command help; an unknown flow directs it to the current flow catalog; recoverable lifecycle failures return to the state-aware guide; security and review failures produce `stop-for-human`. Schema and missing-path errors tell the agent what must be corrected or escalated instead of fabricating a command that would fail unchanged.

## Progress and resumable runs

Long static compilation supports a second machine channel:

```bash
flowctl discover --json --progress jsonl
flowctl analyze --through coverage --json --progress jsonl
```

The final `flowctl.cli.v1` envelope remains the only stdout document. Each stderr line is an independent `flowctl.progress.v1` JSON event with `command`, monotonic `sequence`, event name, timestamp and completed/total stage counts. This makes terminal spinners, IDE status panels and CI log processors possible without making the final JSON ambiguous. The schema is `schemas/v1/progress-event.schema.json`.

Analysis and runtime grounding share one inspection surface:

```bash
flowctl runs list --limit 20 --json
flowctl runs show latest --json
flowctl runs show <run-id> --json
```

Analysis records point directly to coverage, data requirements and generated BDD. Grounding entries point to the manifest, observation location, runtime bindings and selected variant requirements. A current pending grounding entry includes the exact `ground run` resume command; recorded, expired and stale entries remain inspectable but are not advertised as resumable. `latest` means the newest known analysis or grounding run by creation time.

Each returned entry uses `flowctl.run.v1`; its schema is `schemas/v1/run-summary.schema.json`.

## Lifecycle state machine

```text
ANALYSIS_REQUIRED
        │ flowctl discover
        ▼
SOURCE_REPAIR_REQUIRED (only when the current model has zero complete variants)
        │ flowctl repair plan; repair cited source/adapter/config evidence
        ▼
FLOW_SELECTION_REQUIRED
        │ flowctl flows list
        ▼
BDD_GENERATION_REQUIRED
        │ flowctl bdd generate --flow <family-id>
        ▼
REVIEW_REQUIRED (only for conditional proof)
        │ resolve source/evidence gap and rediscover
        ▼
DATA_REQUIRED
        │ plan → bind → human confirm → verify
        ▼
RUNTIME_GROUNDING_REQUIRED
        │ adapter plan/verify → runner plan/config → prepare or resume → ground run
        ▼
EXECUTION_PLAN_REQUIRED
        │ flowctl execution-plan
        ▼
READY (`ready-for-playwright-run`, not a pass result)
```

State is computed from facts:

- artifact existence, status and current source/config digest;
- number of discovered variants and selected variant;
- whether the selected family feature has been generated;
- generated, bound, unconfirmed and missing requirements in the one project-specific application-data file;
- exact current runtime bindings for every required actor-session, entry/intermediate/success screen, active editable field on interaction screens through the final action, and witness action occurrence. The terminal success-screen occurrence is probe-only.

Packet review is a side gate. The guide can surface an inspect, validate or approve action. Label packets affect wording only. Rule packets can affect executable graph meaning only through their compiler-listed gaps after schema/evidence/predicate validation, named human approval and deterministic recompilation.

## Flow and graph inspection

```bash
flowctl flows list
flowctl flows show <variant-id>
flowctl graph summary
flowctl graph trace <variant-id>
```

`flows list` is a compact catalog: variant ID and label, family, feasibility, page/action counts and representative assignments. It intentionally lists behavior variants, not every input-value permutation.

`flows show` and `graph trace` expose the full proof:

- variant and representative witness IDs;
- path condition and assignments;
- actor contracts;
- witness-ordered action occurrences;
- behavior nodes, guarded edges and outcomes;
- source references;
- frontend operation, backend endpoint and terminal effects;
- unresolved evidence references;
- feature, scenario tag and BDD traceability path.

`graph summary` gives counts by node origin/kind, behavior outcomes, entries/successes, families, witnesses, variants and conditional variants. Use it to understand model shape before selecting a flow.

## Source graph to BDD UX

Generate one family after inspecting a representative variant:

```bash
flowctl graph trace <variant-id>
flowctl bdd generate --flow <family-id>
```

The generated output includes runnable end-to-end journeys in `.flowctl/generated/features/journeys/*.feature`, review-only page contracts in `.flowctl/generated/review/page-contracts/*.feature.txt`, review-only conditional journeys, reusable runtime delegates, a step plan and `bdd-traceability.json`. Only satisfiable journeys enter Playwright-BDD discovery and carry `@implementation-required`; review files carry `@review-only`. The implementation tag means:

```text
source-grounded scenario exists
≠ application-specific Playwright implementation exists
≠ runtime locator/data grounding succeeded
```

This distinction prevents the CLI from presenting generated TypeScript delegates as completed test automation.

## Data UX: bind, then human attest

For every external requirement:

```bash
flowctl data plan --flow <variant-id>

flowctl data bind \
  --requirement <id> \
  --alias <logical-alias> \
  --resolver <approved-provider> \
  --secret-ref <secret-store-reference>

flowctl data confirm \
  --requirement <id> \
  --reviewer <corporate-id>

flowctl data verify --flow <variant-id>
```

`data plan` is read-only. It reports a requirement as generated only when the canonical requirement already contains a concrete source-derived representative that passes its constraint contract. For every other requirement, its JSON result includes a `bindingRequests` row with stable ID, classification, source-required `expectedValue`/`expectedAttributes` when present, approved strategies and exact bind-command templates. It also returns pending `confirmationRequests` and an `applicationDataConfigTemplate`. The template's `<...>` values are human questions and are rejected if left unchanged. The command never creates identifiers, product codes, eligible actors or entities; it does not bind or confirm them.

Binding and confirmation are intentionally separate. The assistant may enter a human-approved alias/provider reference in `.flowctl/application-data.local.yaml`, but the binding remains unverified until a human attests to it through `data confirm`. Flowctl records the supplied reviewer label and timestamp; it does not authenticate that person or technically enforce separation of duties, so repository access and reviewer authorization remain organizational controls. Examples are a valid UAT account/customer ID, an application product code, an existing entity in a source-required state, and an eligible actor identity/attribute. `guide` continues to show `DATA_REQUIRED` for both missing and unconfirmed bindings. This is one application-scoped file keyed by stable requirement IDs, never one file per environment. Data commands have no `--env`; runtime environment selects URL, session and runtime bindings only.

Use non-sensitive `--value` only when policy permits. Identities, credentials and secrets use `--secret-ref`; never supply a raw secret as application data or intentionally add one to generated features. Source-evidence and witness artifacts may retain literals already present in source and must be handled as source-equivalent.

## Runtime grounding UX

```bash
flowctl ground adapters plan --variant <variant-id> --json
# Implement the returned target-specific registry and scaffold.
flowctl ground adapters verify --variant <variant-id> --json
flowctl ground runner plan --json
# Human gate: an authorized reviewer configures the trusted runtime.runner.
flowctl ground prepare --variant <variant-id> --env <environment> --json
flowctl ground verify --run <run-id> --json # optional; ground run re-verifies
flowctl ground run --run <run-id> --json
```

The adapter plan reports every required actor-session, screen-state, interaction-screen editable-field/control-kind and action target, writes intentionally non-executable scaffold examples, and provides a validation command. A terminal success-screen occurrence contributes only its screen probe, never a field target. The runner plan provides a `runtime.runner` command/argv scaffold with mandatory `{manifest}` and `{observation}` placeholders. Its guide action has `executor: human`: an authorized reviewer selects and configures this trusted extension; the coding agent stops. Flowctl launches it directly with `shell: false`; it passes only defined values from a minimal built-in process allowlist plus variable names explicitly added through `runtime.runner.envAllowlist` (empty by default). Application-specific values still travel through the application-data/manifest handoff, never the runner environment. Runner stdout and stderr are suppressed from CLI responses, and approved runners must still avoid printing secrets. Neither action points the agent back to `agent prompt`.

Preparation returns a run ID and manifest path only when selected-variant data is ready. The manifest gives an agent a narrow interaction budget: one ordered action at a time, on an expected screen, with an expected next screen and operation. Field and actor-session data handoffs are keyed by stable requirement ID and carry a logical alias, approved strategy, lookup file/key, optional secret handle and integrity digests—not raw values.

`ground run` re-verifies the manifest, launches the configured corporate Playwright runner, requires a fresh regular observation file, validates it and records bindings. Then rerun the guide:

```bash
flowctl guide --variant <variant-id> --env <environment>
```

Recording rejects partial, reordered, stale, digest-mismatched, non-unique, non-actionable, raw-value-bearing or behavior-changing observations. The guide moves to `EXECUTION_PLAN_REQUIRED` after every required actor-session, screen-state, interaction-field and action occurrence has a current registered binding, then to `READY` only after `execution-plan` writes a current `ready-for-playwright-run` plan. `READY` means a Playwright test run may start; it does not mean a run passed. `ground record` remains a low-level import command, not the guided execution path.

When a valid unexpired manifest already exists, the guide returns `ground run --run <id>` for it. It does not loop on `ground prepare`.

## Agent commands

```bash
flowctl agent guide --variant <variant-id> --env <environment> --json
flowctl agent prompt --variant <variant-id> --env <environment>
```

`agent guide` returns the same lifecycle state used by the human dashboard. `agent prompt` renders that state as a copy-ready prompt containing exact actions, reasons, blockers and operating rules.

Recommended bootstrap prompt for any approved coding assistant:

```text
Run flowctl agent guide --json. Read the top-level flowctl.agent.v1 directive.
If disposition is execute, perform only agent.primaryAction.command once,
verify agent.afterAction.expectedStateChange, then run its resumeCommand.
If disposition is stop-for-human, stop and request the named human action.
Never invent graph facts, actors, application data, approvals or secrets.
If the same directiveId recurs without state change, report NO_PROGRESS.
```

Once a variant/runtime-environment is known, include them on every guide call. This makes runtime handoffs resumable and avoids dependence on conversation memory; data commands remain application-scoped.

## Stable JSON contract

Every command that supports `--json` returns the `flowctl.cli.v1` envelope. A successful example:

```json
{
  "schemaVersion": "flowctl.cli.v1",
  "command": "next",
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
  "result": {
    "phase": "DATA_REQUIRED",
    "reason": "One external data requirement prevents safe execution.",
    "action": {
      "id": "plan-data",
      "kind": "data",
      "executor": "agent",
      "title": "Inspect and request approved application data",
      "reason": "One application requirement is unbound.",
      "command": "flowctl data plan --flow flow.variant.id",
      "blocking": true
    }
  },
  "nextActions": [
    {
      "id": "plan-data",
      "kind": "data",
      "executor": "agent",
      "title": "Inspect and request approved application data",
      "reason": "One application requirement is unbound.",
      "command": "flowctl data plan --flow flow.variant.id",
      "blocking": true
    }
  ],
  "diagnostics": [
    {
      "code": "DATA_REQUIRED:requirement.id",
      "severity": "blocked",
      "message": "An approved existing entity is required."
    }
  ]
}
```

Fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Stable parser boundary; currently `flowctl.cli.v1`. |
| `command` | Command label that produced the envelope. |
| `ok` | Whether command processing succeeded. It does not mean the target is runtime-ready. |
| `code` | Stable command/error code. |
| `project` | Optional project/config/source context. |
| `target` | Optional family, variant and environment context. |
| `result` | Command-specific data. |
| `nextActions` | Ordered safe actions, each with reason, command, gate status and `executor`; an assistant must stop when `executor` is `human`. |
| `diagnostics` | Warnings, errors and blockers. |

Successful JSON is written to standard output. A caught command failure uses the same envelope on standard error with `ok: false`. Readiness commands may complete successfully while returning a non-zero gate exit code; inspect `result.ready` or `result.plan.readiness` as well as the exit code.

The schema lives at `schemas/v1/cli-envelope.schema.json`.

## Exit codes

| Exit | Stable meaning | Typical response |
| ---: | --- | --- |
| `0` | Command completed and no gate exit was requested. | Continue using `nextActions`. |
| `2` | Invalid input, configuration or schema; command failed. | Correct the request or proposal. |
| `3` | Human review required. | Inspect and obtain an explicit reviewer decision. |
| `4` | Required application data is missing or unconfirmed. | Plan, bind and confirm data. |
| `5` | Runtime grounding is incomplete. | Prepare/record witness-ordered observations. |
| `6` | Artifact or manifest is stale. | Re-run discovery and regenerate dependent work. |
| `7` | Security policy denied the action. | Remove raw secrets or use an approved resolver/reference. |
| `8` | Requested artifact, packet, flow or ID was not found. | List current objects and select a valid ID. |
| `10` | Unexpected internal failure. | Preserve diagnostics and report a defect. |

Scripts should branch on exit code and stable `code`, never on English messages.

## Human output principles

Human output leads with lifecycle state and outcome, then explains why, blockers and exact commands. It avoids presenting a wall of artifact JSON as a workflow. Graph traces remain detailed because their purpose is reviewable proof.

The human format is not a stable API. Use `--json` for assistants, CI and wrappers.

## Recovery patterns

### Source changed

Run `flowctl guide`. Stale static artifacts produce `ANALYSIS_REQUIRED`; rerun `discover`, then reselect the current variant. Never reuse a stale grounding manifest.

### Assistant cannot interact with a control

Inspect the grounding manifest and page/action source evidence. Try a permitted locator/component-adapter repair. If the control is still not uniquely actionable, record a blocker; do not force-click or change the journey.

### Assistant does not know which value to enter

Run the read-only `data plan` for the selected variant. Use only a source-derived representative value when one exists. Request a human-approved resolver, fixture alias or secret reference for everything else.

If the requirement is a dynamic option, product code, existing entity or eligible actor, do not infer a plausible value from labels. Put the human-supplied application value/reference in the single ignored application-data file and obtain confirmation.

### Too many flows

Inspect behavior signatures and representative assignments in `flows list` and `graph trace`. Values that do not change actors, pages, actions, active validations, payload shape or outcome should remain data cases rather than additional variants.

### No flows discovered

Run `repair plan`. Each gap identifies the first missing stage among client join, action join, success continuation, family, entry-to-success witness and variant, plus a bounded source-evidence neighborhood. Use ast-grep or repository search only to investigate nearby patterns; prove any new canonical edge through the typed extractor. Do not rerun unchanged coverage or ask Playwright to invent a path.

### Repeated-row control is missing

Version 0.2 does not synthesize parameterized row/entity locator templates for dynamic collections. Add explicit extractor and runtime-adapter support, or keep the affected flow unresolved; do not generalize a single observed row locator into a business flow.
