import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { FlowctlConfig } from '../core/config.js';
import { ArtifactStore } from '../core/artifact-store.js';
import { safeFileSegment } from '../core/paths.js';
import { recordAnalysisRun } from '../ux/runs.js';
import { snapshotSources } from '../adapters/source.js';
import { extractReact } from '../adapters/react.js';
import { extractJava } from '../adapters/java.js';
import { importGraphify } from '../adapters/graphify.js';
import { importWiki } from '../adapters/wiki.js';
import {
  applyApprovedOperationDecisions,
  applyApprovedRuleDecisions,
  createOperationPacket,
  createRulePacket,
} from '../agent/packets.js';
import { analyzeRequestPayloads } from '../contracts/request-payload.js';
import type { ExtractionBundle, FlowVariants, OperationCatalog, PageContracts, RuntimeBindings } from '../ir/model.js';
import {
  buildActorRequirements,
  buildBehaviorGraph,
  buildCoverage,
  buildDataRequirements,
  buildEvidenceGraph,
  buildFlowFamilies,
  buildOperationCatalog,
  buildPageContracts,
  reduceVariants,
  searchPaths,
} from './builders.js';

export const STAGES = ['evidence', 'operations', 'contracts', 'behavior', 'families', 'witnesses', 'variants', 'data', 'coverage'] as const;
export type Stage = typeof STAGES[number];

export interface AnalyzeResult {
  sourceDigest: string;
  completedStages: Stage[];
  files: string[];
  counts: Record<string, number>;
  runId: string;
  runPath: string;
  reportPaths: {
    coverage: string;
    dataRequirements: string;
    generatedBdd: string;
  };
}

export interface AnalyzeProgressEvent {
  schemaVersion: 'flowctl.progress.v1';
  event: 'analysis.started' | 'stage.completed' | 'analysis.completed';
  timestamp: string;
  stage?: Stage;
  completed: number;
  total: number;
  message: string;
}

export async function analyze(config: FlowctlConfig, through: Stage = 'coverage', options: {
  command?: 'analyze' | 'discover';
  onProgress?: (event: AnalyzeProgressEvent) => void;
} = {}): Promise<AnalyzeResult> {
  const startedAt = new Date().toISOString();
  const totalStages = STAGES.indexOf(through) + 1;
  const emit = (event: Omit<AnalyzeProgressEvent, 'schemaVersion' | 'timestamp'>): void => options.onProgress?.({
    schemaVersion: 'flowctl.progress.v1',
    timestamp: new Date().toISOString(),
    ...event,
  });
  emit({ event: 'analysis.started', completed: 0, total: totalStages, message: `Building source-grounded artifacts through ${through}.` });
  const store = new ArtifactStore(config);
  await store.initialize();
  const snapshot = await snapshotSources(config);
  const [graphify, wiki] = await Promise.all([importGraphify(config), importWiki(config)]);
  const react = extractReact(snapshot.files, { transparentComponents: config.analysis.transparentComponents });
  const java = extractJava(snapshot.files);
  const bundle: ExtractionBundle = {
    sourceDigest: snapshot.digest,
    sourceFiles: snapshot.refs,
    routes: react.routes,
    pages: react.pages,
    handlers: react.handlers,
    actions: react.actions,
    fields: react.fields,
    httpOperations: react.httpOperations,
    navigations: react.navigations,
    permissions: [...react.permissions, ...java.permissions],
    endpoints: java.endpoints,
    validations: java.validations,
    effects: java.effects,
    wikiConcepts: wiki.concepts,
    graphifyNodes: graphify.nodes,
    graphifyEdges: graphify.edges,
    diagnostics: [...react.diagnostics, ...java.diagnostics, ...graphify.diagnostics, ...wiki.diagnostics],
  };
  const completedStages: Stage[] = [];
  const files: string[] = [];
  const stopAfter = (stage: Stage) => STAGES.indexOf(through) <= STAGES.indexOf(stage);
  let operations: OperationCatalog | undefined;
  let pages: PageContracts | undefined;
  let variants: FlowVariants | undefined;

  const rawEvidence = buildEvidenceGraph(bundle);
  await store.write('evidence', store.createEnvelope({
    artifactType: 'evidence-graph',
    producer: 'evidence:link',
    sourceDigest: snapshot.digest,
    data: rawEvidence,
    unresolved: rawEvidence.diagnostics,
  }));
  await createRulePacket(store, bundle);
  await applyApprovedRuleDecisions(store, bundle);
  const requestPayloadAnalysis = analyzeRequestPayloads(bundle);
  bundle.requestContracts = requestPayloadAnalysis.contracts;
  bundle.diagnostics.push(...requestPayloadAnalysis.diagnostics);
  const evidence = buildEvidenceGraph(bundle);
  const evidenceEnvelope = store.createEnvelope({ artifactType: 'evidence-graph', producer: 'evidence:link', sourceDigest: snapshot.digest, data: evidence, unresolved: evidence.diagnostics });
  files.push(await store.write('evidence', evidenceEnvelope));
  completedStages.push('evidence');
  reportStage('evidence');
  if (stopAfter('evidence')) return finalize();

  operations = buildOperationCatalog(bundle, config);
  await applyApprovedOperationDecisions(store, operations);
  const actors = buildActorRequirements(bundle, operations);
  const operationsEnvelope = store.createEnvelope({ artifactType: 'operation-catalog', producer: 'operations:discover', sourceDigest: snapshot.digest, inputDigests: { evidence: evidenceEnvelope.meta.contentDigest }, data: operations, status: operations.operations.some((operation) => operation.inclusion === 'review-required') ? 'proposed' : 'generated' });
  files.push(await store.write('operations', operationsEnvelope));
  await createOperationPacket(store, operations);
  completedStages.push('operations');
  reportStage('operations');
  if (stopAfter('operations')) return finalize();

  pages = buildPageContracts(bundle, operations);
  const actorsEnvelope = store.createEnvelope({ artifactType: 'actor-requirements', producer: 'actors:build', sourceDigest: snapshot.digest, inputDigests: { evidence: evidenceEnvelope.meta.contentDigest, operations: operationsEnvelope.meta.contentDigest }, data: actors });
  const pagesEnvelope = store.createEnvelope({ artifactType: 'page-contracts', producer: 'pages:build', sourceDigest: snapshot.digest, inputDigests: { evidence: evidenceEnvelope.meta.contentDigest, operations: operationsEnvelope.meta.contentDigest }, data: pages });
  files.push(await store.write('actors', actorsEnvelope), await store.write('pages', pagesEnvelope));
  completedStages.push('contracts');
  reportStage('contracts');
  if (stopAfter('contracts')) return finalize();

  const behavior = buildBehaviorGraph(bundle, operations, pages, config);
  const behaviorEnvelope = store.createEnvelope({ artifactType: 'behavior-graph', producer: 'behavior:build', sourceDigest: snapshot.digest, inputDigests: { operations: operationsEnvelope.meta.contentDigest, pages: pagesEnvelope.meta.contentDigest, actors: actorsEnvelope.meta.contentDigest }, data: behavior });
  files.push(await store.write('behavior', behaviorEnvelope));
  completedStages.push('behavior');
  reportStage('behavior');
  if (stopAfter('behavior')) return finalize();

  const families = buildFlowFamilies(operations, actors, behavior);
  const familiesEnvelope = store.createEnvelope({ artifactType: 'flow-families', producer: 'families:discover', sourceDigest: snapshot.digest, inputDigests: { operations: operationsEnvelope.meta.contentDigest, actors: actorsEnvelope.meta.contentDigest, behavior: behaviorEnvelope.meta.contentDigest }, data: families });
  files.push(await store.write('families', familiesEnvelope));
  completedStages.push('families');
  reportStage('families');
  if (stopAfter('families')) return finalize();

  const witnesses = searchPaths(behavior, families, config);
  const witnessesEnvelope = store.createEnvelope({ artifactType: 'path-witnesses', producer: 'paths:search', sourceDigest: snapshot.digest, inputDigests: { behavior: behaviorEnvelope.meta.contentDigest, families: familiesEnvelope.meta.contentDigest }, data: witnesses, status: witnesses.witnesses.some((witness) => witness.feasibility === 'conditional') ? 'proposed' : 'generated' });
  files.push(await store.write('witnesses', witnessesEnvelope));
  completedStages.push('witnesses');
  reportStage('witnesses');
  if (stopAfter('witnesses')) return finalize();

  variants = reduceVariants(witnesses, families, behavior, pages, actors);
  completedStages.push('variants');
  reportStage('variants');
  if (stopAfter('variants')) {
    const envelope = store.createEnvelope({ artifactType: 'flow-variants', producer: 'variants:reduce', sourceDigest: snapshot.digest, inputDigests: { witnesses: witnessesEnvelope.meta.contentDigest, families: familiesEnvelope.meta.contentDigest, behavior: behaviorEnvelope.meta.contentDigest, pages: pagesEnvelope.meta.contentDigest, actors: actorsEnvelope.meta.contentDigest }, data: variants });
    files.push(await store.write('variants', envelope));
    return finalize();
  }

  const dataRequirements = buildDataRequirements(variants, pages, actors, { witnesses, behavior });
  const variantsEnvelope = store.createEnvelope({ artifactType: 'flow-variants', producer: 'variants:reduce', sourceDigest: snapshot.digest, inputDigests: { witnesses: witnessesEnvelope.meta.contentDigest, families: familiesEnvelope.meta.contentDigest, behavior: behaviorEnvelope.meta.contentDigest, pages: pagesEnvelope.meta.contentDigest, actors: actorsEnvelope.meta.contentDigest }, data: variants, status: variants.variants.some((variant) => variant.feasibility === 'conditional') ? 'proposed' : 'generated' });
  files.push(await store.write('variants', variantsEnvelope));
  for (const variant of variants.variants) {
    const requirements = dataRequirements.filter((requirement) => requirement.variantId === variant.id);
    const destination = path.join(store.dataRequirementsDirectory, `${safeFileSegment(variant.id, 'Variant ID')}.yaml`);
    const dataEnvelope = store.createEnvelope({
      artifactType: 'data-requirements',
      producer: 'data:plan',
      sourceDigest: snapshot.digest,
      inputDigests: {
        variants: variantsEnvelope.meta.contentDigest,
        witnesses: witnessesEnvelope.meta.contentDigest,
        behavior: behaviorEnvelope.meta.contentDigest,
        pages: pagesEnvelope.meta.contentDigest,
        actors: actorsEnvelope.meta.contentDigest,
      },
      data: { variantId: variant.id, requirements },
    });
    await store.writeManagedFile(destination, stringifyYaml(dataEnvelope, { lineWidth: 0, sortMapEntries: true }));
    files.push(destination);
  }
  completedStages.push('data');
  reportStage('data');
  if (stopAfter('data')) return finalize();

  let runtime: RuntimeBindings = { bindings: [] };
  if (await store.exists('runtime')) {
    try {
      const runtimeEnvelope = await store.read<RuntimeBindings>('runtime');
      if (runtimeEnvelope.meta.sourceDigest === snapshot.digest
        && runtimeEnvelope.meta.configDigest === config.configDigest
        && runtimeEnvelope.meta.status !== 'stale') {
        runtime = runtimeEnvelope.data;
      } else {
        files.push(await store.write('runtime', store.createEnvelope({
          artifactType: 'runtime-bindings',
          producer: 'runtime:invalidate',
          sourceDigest: snapshot.digest,
          data: runtimeEnvelope.data,
          status: 'stale',
          unresolved: [{ code: 'RUNTIME_BINDINGS_STALE', severity: 'blocked', message: 'Source or configuration changed after runtime grounding; bindings must be revalidated.' }],
        })));
      }
    } catch {
      files.push(await store.write('runtime', store.createEnvelope({
        artifactType: 'runtime-bindings',
        producer: 'runtime:upgrade-invalidate',
        sourceDigest: snapshot.digest,
        data: runtime,
        status: 'stale',
        unresolved: [{ code: 'RUNTIME_BINDINGS_UNREADABLE', severity: 'blocked', message: 'Existing runtime bindings use an unsupported or invalid artifact contract; bindings were discarded and must be grounded again.' }],
      })));
    }
  } else files.push(await store.write('runtime', store.createEnvelope({ artifactType: 'runtime-bindings', producer: 'runtime:initialize', sourceDigest: snapshot.digest, data: runtime })));
  const coverage = buildCoverage(bundle, operations, pages, actors, behavior, families, witnesses, variants, dataRequirements, runtime, config);
  const coverageEnvelope = store.createEnvelope({ artifactType: 'coverage', producer: 'coverage:build', sourceDigest: snapshot.digest, inputDigests: {
    evidence: evidenceEnvelope.meta.contentDigest,
    operations: operationsEnvelope.meta.contentDigest,
    pages: pagesEnvelope.meta.contentDigest,
    actors: actorsEnvelope.meta.contentDigest,
    behavior: behaviorEnvelope.meta.contentDigest,
    families: familiesEnvelope.meta.contentDigest,
    witnesses: witnessesEnvelope.meta.contentDigest,
    variants: variantsEnvelope.meta.contentDigest,
  }, data: coverage, unresolved: coverage.unresolved });
  files.push(await store.write('coverage', coverageEnvelope));
  completedStages.push('coverage');
  reportStage('coverage');
  return finalize();

  function reportStage(stage: Stage): void {
    emit({
      event: 'stage.completed',
      stage,
      completed: completedStages.length,
      total: totalStages,
      message: `Completed ${stage}.`,
    });
  }

  async function finalize(): Promise<AnalyzeResult> {
    const completedAt = new Date().toISOString();
    const counts = {
      sourceFiles: bundle.sourceFiles.length,
      evidenceNodes: evidence.nodes.length,
      operations: operations?.operations.length ?? 0,
      pages: pages?.pages.length ?? 0,
      variants: variants?.variants.length ?? 0,
    };
    const run = await recordAnalysisRun(store, {
      command: options.command ?? 'analyze',
      createdAt: startedAt,
      completedAt,
      sourceDigest: snapshot.digest,
      through,
      completedStages,
      counts,
    });
    emit({
      event: 'analysis.completed',
      completed: completedStages.length,
      total: totalStages,
      message: `Analysis run ${run.runId} completed.`,
    });
    return {
      sourceDigest: snapshot.digest,
      completedStages,
      files,
      counts,
      runId: run.runId,
      runPath: run.paths.record!,
      reportPaths: {
        coverage: run.paths.coverageReport!,
        dataRequirements: run.paths.dataRequirements!,
        generatedBdd: run.paths.generatedBdd!,
      },
    };
  }
}
