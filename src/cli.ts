#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command, Option } from 'commander';
import { parse as parseYaml } from 'yaml';
import { loadConfig, type FlowctlConfig } from './core/config.js';
import { ArtifactStore, ARTIFACT_FILES, type ArtifactName } from './core/artifact-store.js';
import { analyze, STAGES, type Stage } from './pipeline/analyze.js';
import { generateBdd } from './bdd/generate.js';
import { approvePacket, inspectPacket, nextPacket, validatePacketProposal } from './agent/packets.js';
import { prepareGrounding, recordGrounding } from './runtime/grounding.js';
import { bindRequirement, verifyVariantData } from './data/bindings.js';
import { compileExecutionPlan } from './runtime/execution-plan.js';
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
} from './ir/model.js';

const program = new Command();
program
  .name('flowctl')
  .description('Compile React/Java source evidence into source-grounded happy-path BDD artifacts.')
  .version('0.1.0');

program.command('init')
  .description('Initialize Flowctl configuration and working directories.')
  .option('--directory <path>', 'Project directory', '.')
  .action(async ({ directory }: { directory: string }) => {
    const root = path.resolve(directory);
    await fs.mkdir(root, { recursive: true });
    const configPath = path.join(root, 'flowctl.config.yaml');
    try {
      await fs.access(configPath);
      console.log(`Configuration already exists: ${configPath}`);
    } catch {
      const moduleDirectory = path.dirname(new URL(import.meta.url).pathname);
      const sourceExamplePath = path.resolve(moduleDirectory, '..', 'flowctl.config.example.yaml');
      const builtExamplePath = path.resolve(moduleDirectory, '..', '..', 'flowctl.config.example.yaml');
      const fallbackPath = path.resolve('flowctl.config.example.yaml');
      const source = await fs.readFile(await firstExisting([sourceExamplePath, builtExamplePath, fallbackPath]), 'utf8');
      await fs.writeFile(configPath, source, 'utf8');
      console.log(`Created ${configPath}`);
    }
    const config = await loadConfig(configPath);
    await new ArtifactStore(config).initialize();
    console.log(`Initialized ${config.outputRoot}`);
  });

withConfig(program.command('doctor').description('Check configuration, source roots and optional inputs.'))
  .action(async (options: ConfigOptions) => {
    const config = await loadConfig(options.config);
    const checks = await doctor(config);
    print(checks, options.json);
    if (checks.some((check) => check.status === 'error')) process.exitCode = 2;
  });

withConfig(program.command('analyze').description('Run the static artifact pipeline.'))
  .addOption(new Option('--through <stage>', 'Last pipeline stage').choices([...STAGES]).default('coverage'))
  .action(async (options: ConfigOptions & { through: Stage }) => {
    const result = await analyze(await loadConfig(options.config), options.through);
    print(result, options.json);
  });

withConfig(program.command('status').description('Show canonical artifact and review status.'))
  .action(async (options: ConfigOptions) => {
    const config = await loadConfig(options.config);
    const status = await artifactStatus(new ArtifactStore(config));
    print(status, options.json);
  });

withConfig(program.command('next').description('Return the next required compiler or agent action.'))
  .action(async (options: ConfigOptions) => {
    const config = await loadConfig(options.config);
    const store = new ArtifactStore(config);
    await store.initialize();
    const missing = await firstMissingArtifact(store);
    if (missing) {
      print({ kind: 'compiler-stage', action: 'analyze', reason: `${ARTIFACT_FILES[missing]} is missing`, command: `flowctl analyze --config ${options.config}` }, options.json);
      return;
    }
    const packet = await nextPacket(store);
    if (packet) {
      print({ kind: 'agent-packet', action: packet.taskType, packetId: packet.packetId, packetPath: path.join(store.workDirectory, 'packets', `${packet.packetId}.json`), outputPath: packet.outputPath }, options.json);
      return;
    }
    print({ kind: 'complete-static', action: 'data-or-runtime', message: 'Static artifacts exist. Bind required data, generate BDD, or prepare runtime grounding.' }, options.json);
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

const data = program.command('data').description('Plan and inspect logical/environment data obligations.');
withConfig(data.command('plan'))
  .requiredOption('--flow <variant-id>', 'Flow variant ID')
  .option('--env <environment>', 'Environment', 'local')
  .action(async (options: ConfigOptions & { flow: string; env: string }) => {
    const config = await loadConfig(options.config);
    await analyze(config, 'data');
    const store = new ArtifactStore(config);
    const file = path.join(store.dataRequirementsDirectory, `${options.flow}.yaml`);
    const contents = parseYaml(await fs.readFile(file, 'utf8')) as { data: { requirements: DataRequirement[] } };
    print({ environment: options.env, variantId: options.flow, requirements: contents.data.requirements }, options.json);
  });
withConfig(data.command('bind'))
  .requiredOption('--requirement <id>', 'Data requirement ID')
  .requiredOption('--alias <alias>', 'Non-sensitive logical alias')
  .requiredOption('--resolver <name>', 'Approved resolver name')
  .option('--env <environment>', 'Environment', 'local')
  .option('--value <value>', 'Non-sensitive resolved value')
  .option('--secret-ref <reference>', 'Secret-store reference; never a raw secret')
  .action(async (options: ConfigOptions & { requirement: string; alias: string; resolver: string; env: string; value?: string; secretRef?: string }) => {
    if ((options.value === undefined) === (options.secretRef === undefined)) throw new Error('Provide exactly one of --value or --secret-ref.');
    const store = new ArtifactStore(await loadConfig(options.config));
    const destination = await bindRequirement({
      store,
      environment: options.env,
      requirementId: options.requirement,
      alias: options.alias,
      resolver: options.resolver,
      ...(options.value !== undefined ? { value: options.value } : {}),
      ...(options.secretRef ? { secretRef: options.secretRef } : {}),
    });
    print({ bound: options.requirement, destination }, options.json);
  });
withConfig(data.command('verify'))
  .requiredOption('--flow <variant-id>', 'Flow variant ID')
  .option('--env <environment>', 'Environment', 'local')
  .action(async (options: ConfigOptions & { flow: string; env: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const result = await verifyVariantData(store, options.flow, options.env);
    print(result, options.json);
    if (!result.ready) process.exitCode = 4;
  });

const ground = program.command('ground').description('Prepare and record bounded Playwright runtime grounding.');
withConfig(ground.command('prepare'))
  .requiredOption('--variant <variant-id>', 'Flow variant ID')
  .option('--env <environment>', 'Environment', 'local')
  .action(async (options: ConfigOptions & { variant: string; env: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    print(await prepareGrounding(store, options.variant, options.env), options.json);
  });
withConfig(ground.command('record'))
  .requiredOption('--run <run-id>', 'Grounding run ID')
  .requiredOption('--observation <file>', 'Structured runtime observation JSON')
  .action(async (options: ConfigOptions & { run: string; observation: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const result = await recordGrounding(store, options.run, options.observation);
    print({ recorded: result.bindings.length, artifact: store.artifactPath('runtime') }, options.json);
  });

const bdd = program.command('bdd').description('Generate source-derived BDD and step plans.');
withConfig(bdd.command('generate'))
  .option('--flow <family-id>', 'Generate one flow family')
  .action(async (options: ConfigOptions & { flow?: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const files = await generateBdd(store, options.flow);
    print({ generated: files }, options.json);
  });

withConfig(program.command('execution-plan').description('Compile data and runtime readiness for one variant.'))
  .requiredOption('--variant <variant-id>', 'Flow variant ID')
  .option('--env <environment>', 'Environment', 'local')
  .action(async (options: ConfigOptions & { variant: string; env: string }) => {
    const store = new ArtifactStore(await loadConfig(options.config));
    const result = await compileExecutionPlan(store, options.variant, options.env);
    print(result, options.json);
    if (result.plan.readiness !== 'executable') process.exitCode = result.plan.readiness === 'blocked-data' ? 4 : 5;
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
  const message = error instanceof Error ? error.message : String(error);
  console.error(`flowctl: ${message}`);
  process.exitCode = /not found|missing|unknown/i.test(message) ? 4 : 2;
});

interface ConfigOptions {
  config: string;
  json: boolean;
}

function withConfig(command: Command): Command {
  return command
    .option('-c, --config <path>', 'Flowctl configuration', 'flowctl.config.yaml')
    .option('--json', 'Print machine-readable JSON', false);
}

function print(value: unknown, json = false): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
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

async function doctor(config: FlowctlConfig): Promise<{ check: string; status: 'ok' | 'warning' | 'error'; detail: string }[]> {
  const checks: { check: string; status: 'ok' | 'warning' | 'error'; detail: string }[] = [];
  checks.push({ check: 'node', status: Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'error', detail: process.versions.node });
  for (const [kind, roots] of [['frontend', config.sources.frontend], ['backend', config.sources.backend]] as const) {
    for (const root of roots) {
      try {
        await fs.access(path.resolve(config.projectRoot, root));
        checks.push({ check: `${kind}:${root}`, status: 'ok', detail: 'source root exists' });
      } catch {
        checks.push({ check: `${kind}:${root}`, status: 'error', detail: 'source root does not exist' });
      }
    }
  }
  try {
    await fs.access(path.resolve(config.projectRoot, config.graphify.graph));
    checks.push({ check: 'graphify', status: 'ok', detail: config.graphify.graph });
  } catch {
    checks.push({ check: 'graphify', status: config.graphify.required ? 'error' : 'warning', detail: 'optional graph not present' });
  }
  return checks;
}

async function artifactStatus(store: ArtifactStore): Promise<unknown> {
  const artifacts = [];
  for (const [name, file] of Object.entries(ARTIFACT_FILES) as [ArtifactName, string][]) {
    if (!(await store.exists(name))) {
      artifacts.push({ name, file, status: 'missing' });
      continue;
    }
    const envelope = await store.read<unknown>(name);
    artifacts.push({ name, file, status: envelope.meta.status, producer: envelope.meta.producer, sourceDigest: envelope.meta.sourceDigest, unresolved: envelope.meta.unresolved.length });
  }
  const pendingPacket = await nextPacket(store).catch(() => undefined);
  return { project: store.config.project.name, artifacts, pendingPacket: pendingPacket?.packetId };
}

async function firstMissingArtifact(store: ArtifactStore): Promise<ArtifactName | undefined> {
  const order: ArtifactName[] = ['evidence', 'operations', 'pages', 'actors', 'behavior', 'families', 'witnesses', 'variants', 'runtime', 'coverage'];
  for (const artifact of order) if (!(await store.exists(artifact))) return artifact;
  return undefined;
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
