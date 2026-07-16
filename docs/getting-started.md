# Getting started

This guide takes one React/Spring repository from source discovery to generated BDD and a Playwright-ready execution plan.

## 1. Install and verify

Use Node.js 22 or 24.

```bash
npm ci
npm run check
npm run build
node dist/src/cli.js --help
```

For repository development, commands may use `node --import tsx src/cli.ts`. A packaged or linked installation uses `flowctl`.

## 2. Initialize an application repository

```bash
flowctl init --directory /path/to/application
```

Initialization creates `flowctl.config.yaml`, the managed output directory, and a `.gitignore` rule for generated state and local application data. It does not overwrite an existing configuration.

Configure:

- React/TypeScript and Java source roots;
- source include/exclude patterns;
- entry routes;
- optional Graphify graph and Wiki paths;
- reviewed transparent presentation components;
- bounded search depth and state visits;
- one runtime environment/base URL;
- an approved adapter manifest and runner when runtime grounding is required.

Application-specific values are not environment variables. They remain in the single ignored `.flowctl/application-data.local.yaml` file, keyed by stable requirement ID.

Install the bundled coding-assistant skill without searching the repository:

```bash
flowctl agent install-skill --directory /path/to/application
```

The command writes `.agents/skills/agentic-bdd/SKILL.md` and prints a starter prompt. It will not overwrite a different existing skill.

## 3. Create optional Graphify evidence

```bash
uv tool install graphifyy
graphify extract /path/to/application --code-only --no-cluster
```

Set `graphify.required: true` only when analysis must block without this graph. Graphify evidence helps an agent navigate architecture; typed Flowctl adapters still own executable joins.

## 4. Diagnose and discover

```bash
flowctl doctor --config flowctl.config.yaml --json
flowctl discover --config flowctl.config.yaml --json --progress jsonl
flowctl flows list --config flowctl.config.yaml --json
```

If no complete variant exists, run:

```bash
flowctl repair plan --config flowctl.config.yaml --json
```

The repair packet identifies the first missing join for each operation and provides source spans plus ast-grep investigation hints. The hints help the coding agent find syntax; they do not create canonical graph facts.

## 5. Inspect one journey

```bash
flowctl flows show <variant-id> --config flowctl.config.yaml --json
flowctl graph trace <variant-id> --config flowctl.config.yaml
flowctl agent guide --variant <variant-id> --env <environment> \
  --config flowctl.config.yaml --json
```

Use only the returned primary action. Rerun the returned resume command after the expected state change. Stop for every human action, missing application value, approval, or policy decision.

## 6. Resolve bounded AI packets

```bash
flowctl packet inspect <packet-id> --config flowctl.config.yaml --json
# An approved coding assistant writes only the packet output file.
flowctl packet validate <packet-id> --config flowctl.config.yaml --json
# Human-only:
flowctl review approve <packet-id> --reviewer <corporate-id> \
  --config flowctl.config.yaml
flowctl analyze --through coverage --config flowctl.config.yaml
```

Operation packets may improve labels and family hints but cannot change compiler-owned operation identity. Rule packets can use only packet-listed endpoints, evidence, predicate paths, literal values, and authorities.

## 7. Supply application data

```bash
flowctl data plan --flow <variant-id> --config flowctl.config.yaml --json
```

The result separates compiler-generated representatives from human-supplied values. It gives exact configuration keys and bind command templates for UAT identities, existing entities, product codes, runtime options, and secret references.

```bash
flowctl data bind --requirement <id> --alias <alias> \
  --resolver <approved-provider> --value <approved-non-secret-value> \
  --config flowctl.config.yaml

# Use --secret-ref instead of --value for credentials and identities.

# Human-only confirmation:
flowctl data confirm --requirement <id> --reviewer <corporate-id> \
  --config flowctl.config.yaml

flowctl data verify --flow <variant-id> --config flowctl.config.yaml --json
```

Never leave `<...>` placeholders unchanged. Binding is not approval; external values require separate human confirmation.

## 8. Generate BDD

```bash
flowctl bdd generate --flow <family-id> --config flowctl.config.yaml --json
```

Runnable journeys are written to `.flowctl/generated/features/journeys`. Conditional journeys and page contracts are written as `.feature.txt` review files. The generated TypeScript definitions delegate to an application-owned runtime through stable IDs.

## 9. Prepare Playwright grounding

```bash
flowctl ground adapters plan --variant <variant-id> --config flowctl.config.yaml --json
# Implement the application-owned adapter returned by the plan.
flowctl ground adapters verify --variant <variant-id> --config flowctl.config.yaml --json

flowctl ground runner plan --config flowctl.config.yaml --json
# An authorized human reviews and configures runtime.runner.

flowctl ground prepare --variant <variant-id> --env <environment> \
  --config flowctl.config.yaml --json
flowctl ground run --run <run-id> --config flowctl.config.yaml --json
flowctl execution-plan --variant <variant-id> --env <environment> \
  --config flowctl.config.yaml --json
```

The runner receives ordered actor-session, screen, field, and action targets. It resolves approved values in memory, writes no raw secrets to observations, and cannot change the business path.

`ready-for-playwright-run` means the source plan, data, adapters, and runtime bindings are current. It does not mean the browser test passed.

## 10. Inspect progress and failures

```bash
flowctl runs list --limit 20 --config flowctl.config.yaml
flowctl runs show latest --config flowctl.config.yaml --json
flowctl coverage --config flowctl.config.yaml
```

Expired or stale grounding runs remain visible but are not presented as resumable. A repeated directive without a source, config, decision, data, or artifact digest change is `NO_PROGRESS`, not permission to retry.
