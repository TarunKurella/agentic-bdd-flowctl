import path from 'node:path';
import { z } from 'zod';
import type { ArtifactStore } from '../core/artifact-store.js';
import { safeChildPath, safeFileSegment } from '../core/paths.js';
import { shortHash, stableJson } from '../core/stable.js';
import type { Stage } from '../pipeline/analyze.js';
import type { RuntimeBindings } from '../ir/model.js';
import { verifyGroundingManifest } from '../runtime/grounding.js';

const AnalysisRunSchema = z.object({
  schemaVersion: z.literal('flowctl.analysis-run.v1'),
  runId: z.string(),
  kind: z.literal('analysis'),
  status: z.literal('completed'),
  command: z.enum(['analyze', 'discover']),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  sourceDigest: z.string(),
  configDigest: z.string(),
  through: z.string(),
  completedStages: z.array(z.string()),
  counts: z.record(z.string(), z.number()),
  paths: z.object({
    record: z.string(),
    coverageReport: z.string(),
    dataRequirements: z.string(),
    generatedBdd: z.string(),
  }).strict(),
}).strict();

const GroundingRunSchema = z.object({
  runId: z.string(),
  variantId: z.string(),
  environment: z.string(),
  sourceDigest: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  steps: z.array(z.unknown()),
}).passthrough();

export interface FlowctlRunSummary {
  schemaVersion: 'flowctl.run.v1';
  runId: string;
  kind: 'analysis' | 'grounding';
  status: 'completed' | 'pending' | 'recorded' | 'expired' | 'stale';
  command: string;
  createdAt: string;
  completedAt?: string;
  variantId?: string;
  environment?: string;
  sourceDigest: string;
  summary: string;
  paths: Record<string, string>;
  resume?: { executor: 'agent' | 'human'; command: string };
}

export interface AnalysisRunInput {
  command: 'analyze' | 'discover';
  createdAt: string;
  completedAt: string;
  sourceDigest: string;
  through: Stage;
  completedStages: Stage[];
  counts: Record<string, number>;
}

export async function recordAnalysisRun(store: ArtifactStore, input: AnalysisRunInput): Promise<FlowctlRunSummary> {
  const directory = path.join(store.config.outputRoot, 'runs');
  const compactTimestamp = input.createdAt.replace(/\D/g, '').slice(0, 17);
  const runId = `analysis.${compactTimestamp}.${shortHash(`${input.command}:${input.sourceDigest}:${input.createdAt}`)}`;
  const recordPath = safeChildPath(directory, `${safeFileSegment(runId, 'Run ID')}.json`);
  const record = AnalysisRunSchema.parse({
    schemaVersion: 'flowctl.analysis-run.v1',
    runId,
    kind: 'analysis',
    status: 'completed',
    command: input.command,
    createdAt: input.createdAt,
    completedAt: input.completedAt,
    sourceDigest: input.sourceDigest,
    configDigest: store.config.configDigest,
    through: input.through,
    completedStages: input.completedStages,
    counts: input.counts,
    paths: {
      record: recordPath,
      coverageReport: store.artifactPath('coverage'),
      dataRequirements: store.dataRequirementsDirectory,
      generatedBdd: store.generatedDirectory,
    },
  });
  await store.writeManagedFile(recordPath, stableJson(record));
  await store.writeManagedFile(path.join(directory, 'latest.json'), stableJson({
    schemaVersion: 'flowctl.run-pointer.v1',
    runId,
    recordPath,
    updatedAt: input.completedAt,
  }));
  return analysisSummary(record, store.config.configPath);
}

export async function listRuns(store: ArtifactStore, limit = 20): Promise<FlowctlRunSummary[]> {
  await store.initialize();
  const runs: FlowctlRunSummary[] = [];
  const analysisDirectory = path.join(store.config.outputRoot, 'runs');
  for (const entry of await store.listManagedDirectory(analysisDirectory)) {
    if (!entry.isFile() || entry.name === 'latest.json' || !entry.name.endsWith('.json')) continue;
    try {
      const parsed = AnalysisRunSchema.safeParse(JSON.parse(await store.readManagedFile(safeChildPath(analysisDirectory, entry.name))));
      if (parsed.success) runs.push(analysisSummary(parsed.data, store.config.configPath));
    } catch {
      // Ignore incomplete or unknown records while preserving the usable run index.
    }
  }

  let runtime: RuntimeBindings | undefined;
  try {
    runtime = (await store.read<RuntimeBindings>('runtime')).data;
  } catch {
    runtime = undefined;
  }
  const runtimeDirectory = path.join(store.workDirectory, 'runtime');
  for (const entry of await store.listManagedDirectory(runtimeDirectory)) {
    if (!entry.isFile() || !entry.name.endsWith('.manifest.json')) continue;
    const manifestPath = safeChildPath(runtimeDirectory, entry.name);
    try {
      const parsed = GroundingRunSchema.safeParse(JSON.parse(await store.readManagedFile(manifestPath)));
      if (!parsed.success) continue;
      const manifest = parsed.data;
      const recorded = runtime?.bindings.some((binding) => binding.groundingRunId === manifest.runId) ?? false;
      let status: FlowctlRunSummary['status'] = recorded ? 'recorded' : Date.parse(manifest.expiresAt) <= Date.now() ? 'expired' : 'pending';
      if (!recorded && status === 'pending') {
        try {
          await verifyGroundingManifest(store, manifest.runId);
        } catch {
          status = 'stale';
        }
      }
      runs.push({
        schemaVersion: 'flowctl.run.v1',
        runId: manifest.runId,
        kind: 'grounding',
        status,
        command: 'ground run',
        createdAt: manifest.createdAt,
        variantId: manifest.variantId,
        environment: manifest.environment,
        sourceDigest: manifest.sourceDigest,
        summary: `${Array.isArray(manifest.steps) ? manifest.steps.length : 0} witness-ordered runtime grounding step(s)`,
        paths: {
          manifest: manifestPath,
          observation: safeChildPath(runtimeDirectory, `${safeFileSegment(manifest.runId, 'Run ID')}.observation.json`),
          runtimeBindings: store.artifactPath('runtime'),
          dataRequirements: safeChildPath(store.dataRequirementsDirectory, `${safeFileSegment(manifest.variantId, 'Variant ID')}.yaml`),
        },
        ...(status === 'pending' ? { resume: { executor: 'agent', command: `flowctl ground run --run ${shellQuote(manifest.runId)} --config ${shellQuote(store.config.configPath)}` } } : {}),
      });
    } catch {
      // Ignore malformed work files; doctor/guide will surface canonical blockers.
    }
  }
  return runs.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, Math.max(1, limit));
}

export async function showRun(store: ArtifactStore, runId: string): Promise<FlowctlRunSummary> {
  const runs = await listRuns(store, Number.MAX_SAFE_INTEGER);
  const selected = runId === 'latest' ? runs[0] : runs.find((run) => run.runId === runId);
  if (!selected) throw new Error(runId === 'latest' ? 'No Flowctl runs were found.' : `Unknown run ${runId}. Run flowctl runs list.`);
  return selected;
}

export function renderRunList(runs: FlowctlRunSummary[]): string {
  if (!runs.length) return 'FLOWCTL RUNS\n\nNo runs found. Start with `flowctl discover`.';
  return [
    'FLOWCTL RUNS',
    '',
    ...runs.flatMap((run) => [
      `${run.runId} · ${run.kind} · ${run.status} · ${run.createdAt}`,
      `  ${run.summary}`,
      ...(run.resume ? [`  Resume: ${run.resume.command}`] : []),
    ]),
    '',
    'Inspect: flowctl runs show latest',
  ].join('\n');
}

export function renderRun(run: FlowctlRunSummary): string {
  return [
    `FLOWCTL RUN · ${run.runId}`,
    '',
    `Kind       ${run.kind}`,
    `Status     ${run.status}`,
    `Created    ${run.createdAt}`,
    ...(run.completedAt ? [`Completed  ${run.completedAt}`] : []),
    ...(run.variantId ? [`Variant    ${run.variantId}`] : []),
    ...(run.environment ? [`Environment ${run.environment}`] : []),
    `Summary    ${run.summary}`,
    '',
    'PATHS',
    ...Object.entries(run.paths).map(([name, value]) => `${name}: ${value}`),
    ...(run.resume ? ['', `RESUME [${run.resume.executor}]`, run.resume.command] : []),
  ].join('\n');
}

function analysisSummary(record: z.infer<typeof AnalysisRunSchema>, configPath: string): FlowctlRunSummary {
  return {
    schemaVersion: 'flowctl.run.v1',
    runId: record.runId,
    kind: 'analysis',
    status: 'completed',
    command: record.command,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    sourceDigest: record.sourceDigest,
    summary: `${record.completedStages.length} stage(s) completed through ${record.through}`,
    paths: record.paths,
    resume: { executor: 'agent', command: `flowctl agent guide --config ${shellQuote(configPath)} --json` },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
