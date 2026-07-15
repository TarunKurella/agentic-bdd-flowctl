#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { stringify as stringifyYaml } from 'yaml';
import { snapshotSources } from './adapters/source.js';
import { loadConfig, type FlowctlConfig } from './core/config.js';
import { ArtifactStore } from './core/artifact-store.js';
import { analyze, STAGES, type AnalyzeProgressEvent, type Stage } from './pipeline/analyze.js';
import { generateBdd } from './bdd/generate.js';
import { approvePacket, inspectPacket, validatePacketProposal } from './agent/packets.js';
import { prepareGrounding, recordGrounding, verifyGroundingManifest } from './runtime/grounding.js';
import { planRuntimeAdapters, renderRuntimeAdapterPlan, verifyRuntimeAdapters } from './runtime/adapter-plan.js';
import { planGroundingRunner, renderGroundingRunnerPlan, runGrounding } from './runtime/runner.js';
import { loadAdapterManifest } from './runtime/adapters.js';
import { bindRequirement, confirmRequirement, readVariantRequirements, verifyVariantData } from './data/bindings.js';
import { compileExecutionPlan } from './runtime/execution-plan.js';
import { normalizeFlowctlError } from './core/errors.js';
import { shellQuote } from './core/command.js';
import { failureEnvelope, successEnvelope } from './ux/cli-envelope.js';
import { inspectProjectHealth, renderDoctor } from './ux/doctor.js';
import { listRuns, renderRun, renderRunList, showRun } from './ux/runs.js';
import {
  buildAgentPrompt,
  buildProjectGuide,
  renderNextAction,
  renderProjectGuide,
  type ProjectGuide,
} from './ux/guide.js';
import {
  buildGraphSummary,
  buildVariantTrace,
  listFlows,
  renderFlowList,
  renderGraphSummary,
  renderVariantTrace,
} from './graph/trace.js';
import type {
  ActorRequirements,
  ArtifactEnvelope,
  BehaviorGraph,
  CoverageReport,
  DataRequirement,
  EvidenceGraph,
  FlowFamilies,
  FlowVariants,
  OperationCatalog,
  PageContracts,
  PathWitnesses,
  RuntimeBindings,
  Diagnostic,
} from './ir/model.js';

const program = new Command();
program
  .name('flowctl')
  .description('Compile React/Java source evidence into source-grounded happy-path BDD artifacts.')
  .version('0.2.0')
  .addHelpText('after', `
Guided start:
  flowctl discover --config flowctl.config.yaml
  flowctl guide
  flowctl flows list
  flowctl graph trace <variant-id>
  flowctl runs list
  flowctl runs show latest
  flowctl agent prompt --variant <variant-id> --env <environment>

Use --json for the stable flowctl.cli.v1 machine envelope.
Use --progress jsonl on analyze/discover for flowctl.progress.v1 events on stderr.`)
  .configureOutput({
    writeErr: (value) => {
      if (!process.argv.includes('--json')) process.stderr.write(value);
    },
  })
  .exitOverride((error) => {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return;
    throw error;
  });

program.command('init')
  .description('Initialize Flowctl configuration and working directories.')
  .option('--directory <path>', 'Project directory', '.')
  .action(async ({ directory }: { directory: string }) => {
    const root = path.resolve(directory);
    await fs.mkdir(root, { recursive: true });
    const configPath = path.join(root, 'flowctl.config.yaml');
    let existing = false;
    try {
      const stat = await fs.lstat(configPath);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to initialize through symbolic link ${configPath}.`);
      if (!stat.isFile()) throw new Error(`Configuration destination is not a regular file: ${configPath}.`);
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing) {
      console.log(`Configuration already exists: ${configPath}`);
    } else {
      const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
      const sourceExamplePath = path.resolve(moduleDirectory, '..', 'flowctl.config.example.yaml');
      const builtExamplePath = path.resolve(moduleDirectory, '..', '..', 'flowctl.config.example.yaml');
      const fallbackPath = path.resolve('flowctl.config.example.yaml');
      const source = await fs.readFile(await firstExisting([sourceExamplePath, builtExamplePath, fallbackPath]), 'utf8');
      await writeNewFileExclusive(configPath, source, 0o644);
      console.log(`Created ${configPath}`);
    }
    const config = await loadConfig(configPath);
    await new ArtifactStore(config).initialize();
    console.log(`Initialized ${config.outputRoot}`);
  });

withConfig(program.command('doctor').description('Check configuration, source roots and optional inputs.'))
  .action(async (options: ConfigOptions) => {
    const config = await loadConfig(options.config);
    const result = await inspectProjectHealth(config);
    print(result, options.json, renderDoctor(result), { command: 'doctor', code: result.ready ? 'DOCTOR_READY' : 'CONFIG_INVALID', config });
    if (!result.ready) process.exitCode = 2;
  });

withConfig(program.command('analyze').description('Run the static artifact pipeline.'))
  .addOption(new Option('--through <stage>', 'Last pipeline stage').choices([...STAGES]).default('coverage'))
  .addOption(progressOption())
  .action(async (options: ConfigOptions & { through: Stage; progress?: 'jsonl' }) => {
    const config = await loadConfig(options.config);
    const progress = progressReporter(options.progress, 'analyze');
    const result = await analyze(config, options.through, { command: 'analyze', ...(progress ? { onProgress: progress } : {}) });
    print(result, options.json, undefined, { command: 'analyze', config, sourceDigest: result.sourceDigest });
  });

withConfig(program.command('discover').description('Build the complete source model, summarize its graphs and show the next safe action.'))
  .addOption(progressOption())
  .action(async (options: ConfigOptions & { progress?: 'jsonl' }) => {
    const config = await loadConfig(options.config);
    const progress = progressReporter(options.progress, 'discover');
    const analysis = await analyze(config, 'coverage', { command: 'discover', ...(progress ? { onProgress: progress } : {}) });
    const store = new ArtifactStore(config);
    const [summary, guide] = await Promise.all([
      buildGraphSummary(store),
      buildProjectGuide(store),
    ]);
    const result = { analysis, summary, guide };
    print(result, options.json, `${renderGraphSummary(summary)}\n\n${renderProjectGuide(guide)}`, {
      command: 'discover',
      code: guide.phase,
      sourceDigest: guide.sourceDigest,
      config,
      nextActions: guide.nextActions,
      diagnostics: guideDiagnostics(guide),
    });
  });

withGuidance(program.command('status').description('Show target-aware lifecycle, artifacts, blockers and readiness.'))
  .action(async (options: GuidanceOptions) => {
    const config = await loadConfig(options.config);
    const guide = await buildProjectGuide(new ArtifactStore(config), { variantId: options.variant, environment: options.env });
    print(guide, options.json, renderProjectGuide(guide), {
      command: 'status',
      code: guide.phase,
      sourceDigest: guide.sourceDigest,
      config,
      target: targetFor(options, guide),
      nextActions: guide.nextActions,
      diagnostics: guideDiagnostics(guide),
    });
  });

withGuidance(program.command('next').description('Return one exact next action for a variant/environment.'))
  .action(async (options: GuidanceOptions) => {
    const config = await loadConfig(options.config);
    const guide = await buildProjectGuide(new ArtifactStore(config), { variantId: options.variant, environment: options.env });
    const result = { phase: guide.phase, reason: guide.phaseReason, action: guide.primaryAction ?? null };
    print(result, options.json, renderNextAction(guide), {
      command: 'next',
      code: guide.phase,
      sourceDigest: guide.sourceDigest,
      config,
      target: targetFor(options, guide),
      nextActions: guide.nextActions,
      diagnostics: guideDiagnostics(guide),
    });
  });

withGuidance(program.command('guide').description('Show the guided agentic workflow dashboard.'))
  .action(async (options: GuidanceOptions) => {
    const config = await loadConfig(options.config);
    const guide = await buildProjectGuide(new ArtifactStore(config), { variantId: options.variant, environment: options.env });
    print(guide, options.json, renderProjectGuide(guide), {
      command: 'guide', code: guide.phase, sourceDigest: guide.sourceDigest, config, target: targetFor(options, guide), nextActions: guide.nextActions, diagnostics: guideDiagnostics(guide),
    });
  });

const agent = program.command('agent').description('Generate state-aware guidance for a VS Code coding assistant.');
withGuidance(agent.command('guide').description('Show lifecycle state, blockers and exact safe actions.'))
  .action(async (options: GuidanceOptions) => {
    const config = await loadConfig(options.config);
    const guide = await buildProjectGuide(new ArtifactStore(config), { variantId: options.variant, environment: options.env });
    print(guide, options.json, renderProjectGuide(guide), {
      command: 'agent guide', code: guide.phase, sourceDigest: guide.sourceDigest, config, target: targetFor(options, guide), nextActions: guide.nextActions, diagnostics: guideDiagnostics(guide),
    });
  });
withGuidance(agent.command('prompt').description('Print a copy-ready prompt derived from current Flowctl state.'))
  .action(async (options: GuidanceOptions) => {
    const config = await loadConfig(options.config);
    const guide = await buildProjectGuide(new ArtifactStore(config), { variantId: options.variant, environment: options.env });
    const prompt = buildAgentPrompt(guide);
    print({ prompt, phase: guide.phase }, options.json, prompt, {
      command: 'agent prompt', code: guide.phase, sourceDigest: guide.sourceDigest, config, target: targetFor(options, guide), nextActions: guide.nextActions, diagnostics: guideDiagnostics(guide),
    });
  });

const graph = program.command('graph').description('Inspect graph construction and source-to-flow proofs.');
withConfig(graph.command('summary').description('Summarize evidence, behavior and flow graphs.'))
  .action(async (options: ConfigOptions) => {
    const config = await loadConfig(options.config);
    const summary = await buildGraphSummary(new ArtifactStore(config));
    print(summary, options.json, renderGraphSummary(summary), { command: 'graph summary', config });
  });
withConfig(graph.command('trace <variant-id>').description('Explain one variant from witness path to BDD.'))
  .action(async (variantId: string, options: ConfigOptions) => {
    const config = await loadConfig(options.config);
    const trace = await buildVariantTrace(new ArtifactStore(config), variantId);
    print(trace, options.json, renderVariantTrace(trace), { command: 'graph trace', config, target: { variantId } });
  });

const flows = program.command('flows').description('List and inspect behaviorally distinct flow variants.');
withConfig(flows.command('list').description('List discovered flow variants and representative assignments.'))
  .action(async (options: ConfigOptions) => {
    const config = await loadConfig(options.config);
    const values = await listFlows(new ArtifactStore(config));
    print({ variants: values }, options.json, renderFlowList(values), { command: 'flows list', config });
  });
withConfig(flows.command('show <variant-id>').description('Show the full graph proof for one variant.'))
  .action(async (variantId: string, options: ConfigOptions) => {
    const config = await loadConfig(options.config);
    const trace = await buildVariantTrace(new ArtifactStore(config), variantId);
    print(trace, options.json, renderVariantTrace(trace), { command: 'flows show', config, target: { variantId } });
  });

const runs = program.command('runs').description('List and inspect resumable analysis and runtime grounding runs.');
withConfig(runs.command('list').description('List recent Flowctl runs and resume commands.'))
  .option('--limit <count>', 'Maximum number of runs', '20')
  .action(async (options: ConfigOptions & { limit: string }) => {
    const config = await loadConfig(options.config);
    const limit = Number.parseInt(options.limit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be an integer between 1 and 1000.');
    const values = await listRuns(new ArtifactStore(config), limit);
    print({ runs: values }, options.json, renderRunList(values), { command: 'runs list', config });
  });
withConfig(runs.command('show <run-id>').description('Show one run; use latest for the most recent run.'))
  .action(async (runId: string, options: ConfigOptions) => {
    const config = await loadConfig(options.config);
    const value = await showRun(new ArtifactStore(config), runId);
    const target = {
      ...(value.variantId ? { variantId: value.variantId } : {}),
      ...(value.environment ? { environment: value.environment } : {}),
    };
    const resumeAction = value.resume ? {
      id: 'resume-run',
      kind: value.kind === 'grounding' ? 'runtime' as const : 'inspect' as const,
      executor: value.resume.executor,
      title: `Resume ${value.kind} workflow`,
      reason: `Run ${value.runId} is ${value.status} and has a safe continuation.`,
      command: value.resume.command,
      blocking: false,
    } : undefined;
    print(value, options.json, renderRun(value), {
      command: 'runs show',
      code: value.status === 'stale' || value.status === 'expired' ? 'RUN_NOT_RESUMABLE' : 'OK',
      config,
      ...(Object.keys(target).length ? { target } : {}),
      ...(resumeAction ? { nextActions: [resumeAction] } : {}),
      ...((value.status === 'stale' || value.status === 'expired') ? {
        diagnostics: [{
          code: 'RUN_NOT_RESUMABLE',
          severity: 'warning' as const,
          message: `Run ${value.runId} is ${value.status}; inspect its paths but obtain a current action from flowctl agent guide.`,
        }],
      } : {}),
    });
  });

const packet = program.command('packet').description('Inspect and validate file-mediated agent packets.');
withConfig(packet.command('inspect <packet-id>'))
  .action(async (packetId: string, options: ConfigOptions) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    print(await inspectPacket(store, packetId), options.json);
  });
withConfig(packet.command('validate <packet-id>'))
  .action(async (packetId: string, options: ConfigOptions) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const proposal = await validatePacketProposal(store, packetId);
    print({ valid: true, decisions: proposal.decisions.length, unresolved: proposal.unresolved.length }, options.json);
  });

const review = program.command('review').description('Record explicit human review decisions.');
withConfig(review.command('approve <packet-id>'))
  .requiredOption('--reviewer <id>', 'Corporate reviewer identity')
  .action(async (packetId: string, options: ConfigOptions & { reviewer: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const destination = await approvePacket(store, packetId, options.reviewer);
    print({ approved: true, destination, next: `flowctl analyze --config ${options.config}` }, options.json);
  });

const data = program.command('data').description('Plan and validate application-specific data obligations.');
withConfig(data.command('plan'))
  .requiredOption('--flow <variant-id>', 'Flow variant ID')
  .action(async (options: ConfigOptions & { flow: string }) => {
    const config = await loadConfig(options.config);
    const store = new ArtifactStore(config);
    const [requirements, verification] = await Promise.all([
      readVariantRequirements(store, options.flow),
      verifyVariantData(store, options.flow),
    ]);
    const currentSourceDigest = (await snapshotSources(config)).digest;
    const missingIds = new Set(verification.missing.map((requirement) => requirement.id));
    const bindingRequests = requirements.filter((requirement) => missingIds.has(requirement.id)).map((requirement) => {
      const bindCommandTemplates = requirement.resolutionStrategies.map((strategy) => (
        `flowctl data bind --requirement ${shellQuote(requirement.id)} --alias <approved-alias> --resolver ${shellQuote(strategy)} ${bindingArgumentTemplate(requirement.classification)} --config ${shellQuote(config.configPath)}`
      ));
      return {
        requirementId: requirement.id,
        fieldPath: requirement.fieldPath,
        classification: requirement.classification,
        ...(requirement.expectedValue !== undefined ? { expectedValue: requirement.expectedValue } : {}),
        ...(requirement.expectedAttributes ? { expectedAttributes: requirement.expectedAttributes } : {}),
        approvedStrategies: requirement.resolutionStrategies,
        requiresHumanInput: true as const,
        bindCommandTemplates,
        bindCommandTemplate: bindCommandTemplates[0] ?? 'No approved binding strategy is available.',
      };
    });
    const confirmationRequests = verification.unverified.map((requirement) => ({
      requirementId: requirement.id,
      fieldPath: requirement.fieldPath,
      alias: requirement.alias,
      resolver: requirement.resolver,
      requiresHumanConfirmation: true as const,
      confirmCommandTemplate: `flowctl data confirm --requirement ${shellQuote(requirement.id)} --reviewer <corporate-id> --config ${shellQuote(config.configPath)}`,
    }));
    const applicationDataConfigTemplate = {
      version: 1,
      application: config.project.name,
      bindings: Object.fromEntries(bindingRequests.map((request) => [request.requirementId, {
        alias: '<human-supplied-logical-alias>',
        resolver: request.approvedStrategies[0] ?? '<choose-an-approved-strategy>',
        ...(request.classification === 'secret-reference' || request.classification === 'authenticated-identity'
          ? { secretRef: '<approved-secret-provider-reference>' }
          : { value: '<human-supplied-application-value>' }),
        verified: false,
      }])),
    };
    const result = {
      application: config.project.name,
      applicationDataFile: config.applicationDataPath,
      applicationDataConfigTemplate,
      variantId: options.flow,
      ready: verification.ready,
      requirements,
      generatedRequirementIds: verification.generated,
      bindingRequests,
      confirmationRequests,
    };
    print(result, options.json, renderDataPlan(result), {
      command: 'data plan',
      code: verification.ready ? 'READY' : 'DATA_REQUIRED',
      sourceDigest: currentSourceDigest,
      config,
      target: { variantId: options.flow },
      diagnostics: [
        ...bindingRequests.map((request) => ({
          code: `DATA_REQUIRED:${request.requirementId}`,
          severity: 'blocked' as const,
          message: `${request.fieldPath} requires human-approved ${request.classification} data.`,
        })),
        ...confirmationRequests.map((request) => ({
          code: `DATA_CONFIRMATION_REQUIRED:${request.requirementId}`,
          severity: 'blocked' as const,
          message: `${request.fieldPath} is bound as ${request.alias} but requires named human confirmation.`,
        })),
      ],
    });
  });
withConfig(data.command('bind'))
  .requiredOption('--requirement <id>', 'Data requirement ID')
  .requiredOption('--alias <alias>', 'Non-sensitive logical alias')
  .requiredOption('--resolver <name>', 'Approved resolver name')
  .option('--value <value>', 'Non-sensitive resolved value')
  .option('--secret-ref <reference>', 'Secret-store reference; never a raw secret')
  .action(async (options: ConfigOptions & { requirement: string; alias: string; resolver: string; value?: string; secretRef?: string }) => {
    if ((options.value === undefined) === (options.secretRef === undefined)) throw new Error('Provide exactly one of --value or --secret-ref.');
    const store = new ArtifactStore(await loadConfig(options.config));
    const destination = await bindRequirement({
      store,
      requirementId: options.requirement,
      alias: options.alias,
      resolver: options.resolver,
      ...(options.value !== undefined ? { value: options.value } : {}),
      ...(options.secretRef ? { secretRef: options.secretRef } : {}),
    });
    print({ bound: options.requirement, destination }, options.json);
  });
withConfig(data.command('confirm'))
  .requiredOption('--requirement <id>', 'Bound data requirement ID')
  .requiredOption('--reviewer <id>', 'Corporate reviewer identity')
  .action(async (options: ConfigOptions & { requirement: string; reviewer: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const result = await confirmRequirement({
      store,
      requirementId: options.requirement,
      reviewer: options.reviewer,
    });
    print({ confirmed: options.requirement, ...result }, options.json);
  });
withConfig(data.command('verify'))
  .requiredOption('--flow <variant-id>', 'Flow variant ID')
  .action(async (options: ConfigOptions & { flow: string }) => {
    const config = await loadConfig(options.config);
    const store = new ArtifactStore(config);
    const result = await verifyVariantData(store, options.flow);
    const diagnostics: Diagnostic[] = [
      ...result.missing.map((item) => ({
        code: `DATA_REQUIRED:${item.id}`,
        severity: 'blocked' as const,
        message: `${item.fieldPath} is not present in the application data file.`,
      })),
      ...result.unverified.map((item) => ({
        code: `DATA_CONFIRMATION_REQUIRED:${item.id}`,
        severity: 'blocked' as const,
        message: `${item.fieldPath} is present but not confirmed in the application data file.`,
      })),
    ];
    print(result, options.json, undefined, {
      command: 'data verify',
      code: result.ready ? 'READY' : 'DATA_REQUIRED',
      config,
      target: { variantId: options.flow },
      diagnostics,
    });
    if (!result.ready) process.exitCode = 4;
  });

const ground = program.command('ground').description('Prepare and record bounded Playwright runtime grounding.');
const groundAdapters = ground.command('adapters').description('Plan and validate the application-specific Playwright adapter registry.');
withConfig(groundAdapters.command('plan'))
  .requiredOption('--variant <variant-id>', 'Flow variant ID')
  .action(async (options: ConfigOptions & { variant: string }) => {
    const config = await loadConfig(options.config);
    const plan = await planRuntimeAdapters(new ArtifactStore(config), options.variant);
    print(plan, options.json, renderRuntimeAdapterPlan(plan), {
      command: 'ground adapters plan',
      config,
      target: { variantId: options.variant },
    });
  });
withConfig(groundAdapters.command('verify'))
  .requiredOption('--variant <variant-id>', 'Flow variant ID')
  .action(async (options: ConfigOptions & { variant: string }) => {
    const config = await loadConfig(options.config);
    const result = await verifyRuntimeAdapters(new ArtifactStore(config), options.variant);
    print(result, options.json, undefined, {
      command: 'ground adapters verify',
      code: 'RUNTIME_ADAPTERS_READY',
      config,
      target: { variantId: options.variant },
    });
  });
const groundRunner = ground.command('runner').description('Configure the safe external Playwright runner protocol.');
withConfig(groundRunner.command('plan'))
  .action(async (options: ConfigOptions) => {
    const config = await loadConfig(options.config);
    const plan = await planGroundingRunner(new ArtifactStore(config));
    print(plan, options.json, renderGroundingRunnerPlan(plan), {
      command: 'ground runner plan',
      config,
    });
  });
withConfig(ground.command('prepare'))
  .requiredOption('--variant <variant-id>', 'Flow variant ID')
  .option('--env <environment>', 'Runtime environment (defaults to runtime.environment in config)')
  .action(async (options: ConfigOptions & { variant: string; env?: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    print(await prepareGrounding(store, options.variant, options.env ?? store.config.runtime.environment), options.json);
  });
withConfig(ground.command('run'))
  .requiredOption('--run <run-id>', 'Grounding run ID')
  .action(async (options: ConfigOptions & { run: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const result = await runGrounding(store, options.run);
    print(result, options.json, undefined, {
      command: 'ground run',
      code: 'RUNTIME_GROUNDING_RECORDED',
      config: store.config,
      target: { variantId: result.variantId, environment: result.environment },
    });
  });
withConfig(ground.command('record'))
  .requiredOption('--run <run-id>', 'Grounding run ID')
  .requiredOption('--observation <file>', 'Structured runtime observation JSON')
  .action(async (options: ConfigOptions & { run: string; observation: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const result = await recordGrounding(store, options.run, options.observation);
    print({ recorded: result.bindings.length, artifact: store.artifactPath('runtime') }, options.json);
  });
withConfig(ground.command('verify'))
  .requiredOption('--run <run-id>', 'Grounding run ID')
  .action(async (options: ConfigOptions & { run: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const manifest = await verifyGroundingManifest(store, options.run);
    print({ valid: true, manifest }, options.json);
  });

const bdd = program.command('bdd').description('Generate source-derived BDD and step plans.');
withConfig(bdd.command('generate'))
  .option('--flow <family-id>', 'Generate one flow family')
  .action(async (options: ConfigOptions & { flow?: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const files = await generateBdd(store, options.flow);
    print(
      { generated: files },
      options.json,
      ['BDD GENERATED', '', ...files.map((file) => `- ${file}`), '', 'Run `flowctl guide` to continue with data and runtime grounding.'].join('\n'),
    );
  });

withConfig(program.command('execution-plan').description('Compile data and runtime readiness for one variant.'))
  .requiredOption('--variant <variant-id>', 'Flow variant ID')
  .option('--env <environment>', 'Runtime environment (defaults to runtime.environment in config)')
  .action(async (options: ConfigOptions & { variant: string; env?: string }) => {
    const config = await loadConfig(options.config);
    const store = new ArtifactStore(config);
    const environment = options.env ?? config.runtime.environment;
    const result = await compileExecutionPlan(store, options.variant, environment);
    const guide = await buildProjectGuide(store, { variantId: options.variant, environment });
    const code = result.plan.readiness === 'ready-for-playwright-run'
      ? 'READY'
      : result.plan.readiness === 'blocked-data' ? 'DATA_REQUIRED' : 'RUNTIME_REQUIRED';
    print(result, options.json, undefined, {
      command: 'execution-plan',
      code,
      sourceDigest: guide.sourceDigest,
      config,
      target: { variantId: options.variant, environment },
      nextActions: guide.nextActions,
      diagnostics: guideDiagnostics(guide),
    });
    if (result.plan.readiness !== 'ready-for-playwright-run') process.exitCode = result.plan.readiness === 'blocked-data' ? 4 : 5;
  });

withConfig(program.command('coverage').description('Show the current coverage and unresolved-scope manifest.'))
  .action(async (options: ConfigOptions) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    if (!(await store.exists('coverage'))) await analyze(store.config, 'coverage');
    print((await store.read<CoverageReport>('coverage')).data, options.json);
  });

withConfig(program.command('explain <kind> <id>').description('Explain an evidence, operation, page, family, flow variant or witness.'))
  .action(async (kind: string, id: string, options: ConfigOptions) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    print(await explain(store, kind, id), options.json);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const normalized = normalizeFlowctlError(error);
  if (process.argv.includes('--json')) {
    console.error(JSON.stringify(failureEnvelope({
      command: activeCommandLabel(),
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    }), null, 2));
  } else {
    console.error(`flowctl: ${normalized.message}`);
  }
  process.exitCode = normalized.exitCode;
});

interface ConfigOptions {
  config: string;
  json: boolean;
}

interface GuidanceOptions extends ConfigOptions {
  variant?: string;
  env?: string;
}

interface DataBindingRequest {
  requirementId: string;
  fieldPath: string;
  classification: DataRequirement['classification'];
  expectedValue?: string | number | boolean | null;
  expectedAttributes?: Record<string, string | number | boolean | null>;
  approvedStrategies: string[];
  requiresHumanInput: true;
  bindCommandTemplate: string;
  bindCommandTemplates: string[];
}

interface DataPlanView {
  application: string;
  applicationDataFile: string;
  applicationDataConfigTemplate: Record<string, unknown>;
  variantId: string;
  ready: boolean;
  requirements: DataRequirement[];
  generatedRequirementIds: string[];
  bindingRequests: DataBindingRequest[];
  confirmationRequests: Array<{
    requirementId: string;
    fieldPath: string;
    alias: string;
    resolver: string;
    requiresHumanConfirmation: true;
    confirmCommandTemplate: string;
  }>;
}

interface PrintContext {
  command?: string;
  code?: string;
  sourceDigest?: string;
  config?: FlowctlConfig;
  target?: {
    familyId?: string;
    variantId?: string;
    environment?: string;
  };
  nextActions?: ProjectGuide['nextActions'];
  diagnostics?: Diagnostic[];
}

function withConfig(command: Command): Command {
  return command
    .option('-c, --config <path>', 'Flowctl configuration', 'flowctl.config.yaml')
    .option('--json', 'Print machine-readable JSON', false);
}

function withGuidance(command: Command): Command {
  return withConfig(command)
    .option('--variant <variant-id>', 'Target one discovered flow variant')
    .option('--env <environment>', 'Target runtime environment');
}

function progressOption(): Option {
  return new Option('--progress <format>', 'Write machine-readable progress events to stderr').choices(['jsonl']);
}

function progressReporter(format: 'jsonl' | undefined, command: string): ((event: AnalyzeProgressEvent) => void) | undefined {
  if (format !== 'jsonl') return undefined;
  let sequence = 0;
  return (event) => {
    sequence += 1;
    process.stderr.write(`${JSON.stringify({ ...event, command, sequence })}\n`);
  };
}

function bindingArgumentTemplate(classification: DataRequirement['classification']): string {
  if (classification === 'secret-reference' || classification === 'authenticated-identity') {
    return '--secret-ref <approved-provider-reference>';
  }
  if (classification === 'synthetic-constrained') return '--value <constraint-valid-value>';
  if (classification === 'derived') return '--value <execution-derived-value>';
  if (classification === 'existing-entity') return '--value <approved-application-entity-id>';
  return '--value <approved-non-sensitive-value>';
}

function renderDataPlan(plan: DataPlanView): string {
  const generatedIds = new Set(plan.generatedRequirementIds);
  const generated = plan.requirements.filter((requirement) => generatedIds.has(requirement.id));
  const lines = [
    `FLOWCTL DATA PLAN · ${plan.variantId}`,
    '',
    `Application    ${plan.application}`,
    `Data file      ${plan.applicationDataFile}`,
    `Requirements   ${plan.requirements.length}`,
    `Generated      ${generated.length}`,
    `Missing        ${plan.bindingRequests.length}`,
    `Unconfirmed    ${plan.confirmationRequests.length}`,
    `Ready          ${plan.ready ? 'yes' : 'no'}`,
  ];

  if (generated.length) {
    lines.push('', 'SAFE TO GENERATE');
    generated.forEach((requirement) => lines.push(`- ${requirement.fieldPath} (${requirement.classification})`));
  }

  if (plan.bindingRequests.length) {
    lines.push('', 'HUMAN-APPROVED BINDINGS REQUIRED');
    plan.bindingRequests.forEach((request, index) => {
      lines.push(`${index + 1}. ${request.fieldPath} (${request.classification})`);
      if (request.expectedValue !== undefined) lines.push(`   Must establish: ${request.fieldPath} = ${JSON.stringify(request.expectedValue)}`);
      if (request.expectedAttributes) lines.push(`   Fixture must establish: ${JSON.stringify(request.expectedAttributes)}`);
      lines.push(`   Approved strategies: ${request.approvedStrategies.join(', ') || 'none declared'}`);
      request.bindCommandTemplates.forEach((command) => lines.push(`   ${command}`));
    });
    lines.push('', 'APPLICATION DATA CONFIG TEMPLATE');
    lines.push('A human must replace every <...> placeholder before saving this local file. The agent must not invent these values.');
    lines.push(stringifyYaml(plan.applicationDataConfigTemplate, { lineWidth: 0, sortMapEntries: true }).trim());
  }

  if (plan.confirmationRequests.length) {
    lines.push('', 'NAMED HUMAN CONFIRMATION REQUIRED');
    plan.confirmationRequests.forEach((request, index) => {
      lines.push(`${index + 1}. ${request.fieldPath} is bound as ${request.alias} via ${request.resolver}`);
      lines.push(`   ${request.confirmCommandTemplate}`);
    });
  }

  if (!plan.bindingRequests.length && !plan.confirmationRequests.length) lines.push('', 'All required application bindings are confirmed.');
  lines.push('', 'This command only explains the application data contract. It does not invent, bind, or confirm application values.');

  return lines.join('\n');
}

function print(value: unknown, json = false, human?: string, context: PrintContext = {}): void {
  if (json) {
    const sourceDigest = context.sourceDigest ?? sourceDigestFrom(value);
    console.log(JSON.stringify(successEnvelope({
      command: context.command ?? activeCommandLabel(),
      result: value,
      ...(context.code ? { code: context.code } : {}),
      ...(context.config ? {
        project: {
          name: context.config.project.name,
          configPath: context.config.configPath,
          ...(sourceDigest ? { sourceDigest } : {}),
        },
      } : {}),
      ...(context.target ? { target: context.target } : {}),
      ...(context.nextActions ? { nextActions: context.nextActions } : {}),
      ...(context.diagnostics ? { diagnostics: context.diagnostics } : {}),
    }), null, 2));
    return;
  }
  if (human !== undefined) console.log(human);
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function targetFor(options: GuidanceOptions, guide: ProjectGuide): NonNullable<PrintContext['target']> {
  return {
    ...(options.variant || guide.selectedVariant?.id ? { variantId: options.variant ?? guide.selectedVariant!.id } : {}),
    environment: options.env ?? guide.environment,
  };
}

function guideDiagnostics(guide: ProjectGuide): Diagnostic[] {
  return [
    ...guide.attention.map((item) => ({
      code: item.code,
      severity: item.blocking ? 'blocked' as const : 'warning' as const,
      message: item.message,
    })),
    ...guide.blockers.map((blocker) => ({
      code: blocker.code,
      severity: 'blocked' as const,
      message: blocker.message,
      ...((blocker.resolution || blocker.configKeys?.length || blocker.paths?.length) ? {
        scope: [
          blocker.resolution,
          blocker.configKeys?.length ? `config=${blocker.configKeys.join(',')}` : undefined,
          blocker.paths?.length ? `paths=${blocker.paths.join(',')}` : undefined,
        ].filter(Boolean).join(' · '),
      } : {}),
    })),
  ];
}

function sourceDigestFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { sourceDigest?: unknown };
  return typeof record.sourceDigest === 'string' ? record.sourceDigest : undefined;
}

function activeCommandLabel(): string {
  const values = program.args.filter((value) => !value.startsWith('-'));
  const top = values[0];
  if (!top) return 'flowctl';
  const grouped = new Set(['agent', 'graph', 'flows', 'runs', 'packet', 'review', 'data', 'ground', 'bdd']);
  return grouped.has(top) && values[1] ? `${top} ${values[1]}` : top;
}

async function firstExisting(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue.
    }
  }
  throw new Error('flowctl.config.example.yaml could not be located.');
}

async function writeNewFileExclusive(destination: string, contents: string, mode: number): Promise<void> {
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(destination, flags, mode);
  try {
    await handle.writeFile(contents, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function explain(store: ArtifactStore, kind: string, id: string): Promise<unknown> {
  if (kind === 'evidence') {
    const artifact = await store.read<EvidenceGraph>('evidence');
    return artifact.data.nodes.find((node) => node.id === id) ?? artifact.data.edges.find((edge) => edge.id === id) ?? notFound(kind, id);
  }
  if (kind === 'operation') return findIn(await store.read<OperationCatalog>('operations'), 'operations', id, kind);
  if (kind === 'page') return findIn(await store.read<PageContracts>('pages'), 'pages', id, kind);
  if (kind === 'actor') return findIn(await store.read<ActorRequirements>('actors'), 'actors', id, kind);
  if (kind === 'family') return findIn(await store.read<FlowFamilies>('families'), 'families', id, kind);
  if (kind === 'flow' || kind === 'variant') return findIn(await store.read<FlowVariants>('variants'), 'variants', id, kind);
  if (kind === 'witness') return findIn(await store.read<PathWitnesses>('witnesses'), 'witnesses', id, kind);
  if (kind === 'behavior') {
    const artifact = await store.read<BehaviorGraph>('behavior');
    return artifact.data.nodes.find((node) => node.id === id) ?? artifact.data.edges.find((edge) => edge.id === id) ?? notFound(kind, id);
  }
  if (kind === 'runtime') return findIn(await store.read<RuntimeBindings>('runtime'), 'bindings', id, kind);
  throw new Error(`Unknown explain kind ${kind}.`);
}

function findIn<T, K extends keyof T>(artifact: ArtifactEnvelope<T>, property: K, id: string, kind: string): unknown {
  const values = artifact.data[property];
  if (!Array.isArray(values)) throw new Error(`${String(property)} is not an array.`);
  return values.find((value) => value && typeof value === 'object' && (value as { id?: string }).id === id) ?? notFound(kind, id);
}

function notFound(kind: string, id: string): never {
  throw new Error(`${kind} ${id} not found.`);
}
