import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { FlowctlConfig } from '../core/config.js';
import { ArtifactStore } from '../core/artifact-store.js';
import { stableJson } from '../core/stable.js';
import { snapshotSources } from '../adapters/source.js';
import { extractReact } from '../adapters/react.js';
import { extractJava } from '../adapters/java.js';
import { importGraphify } from '../adapters/graphify.js';
import { importWiki } from '../adapters/wiki.js';
import { applyApprovedOperationDecisions, createOperationPacket } from '../agent/packets.js';
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
  completedStages: Stage[];
  files: string[];
  counts: Record<string, number>;
}

export async function analyze(config: FlowctlConfig, through: Stage = 'coverage'): Promise<AnalyzeResult> {
  const store = new ArtifactStore(config);
  await store.initialize();
  const snapshot = await snapshotSources(config);
  const [graphify, wiki] = await Promise.all([importGraphify(config), importWiki(config)]);
  const react = extractReact(snapshot.files);
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

  const evidence = buildEvidenceGraph(bundle);
  const evidenceEnvelope = store.createEnvelope({ artifactType: 'evidence-graph', producer: 'evidence:link', sourceDigest: snapshot.digest, data: evidence, unresolved: evidence.diagnostics });
  files.push(await store.write('evidence', evidenceEnvelope));
  completedStages.push('evidence');
  if (stopAfter('evidence')) return summarize();

  operations = buildOperationCatalog(bundle);
  await applyApprovedOperationDecisions(store, operations);
  const operationsEnvelope = store.createEnvelope({ artifactType: 'operation-catalog', producer: 'operations:discover', sourceDigest: snapshot.digest, inputDigests: { evidence: evidenceEnvelope.meta.contentDigest }, data: operations, status: operations.operations.some((operation) => operation.inclusion === 'review-required') ? 'proposed' : 'generated' });
  files.push(await store.write('operations', operationsEnvelope));
  await createOperationPacket(store, operations);
  completedStages.push('operations');
  if (stopAfter('operations')) return summarize();

  const actors = buildActorRequirements(bundle, operations);
  pages = buildPageContracts(bundle);
  const actorsEnvelope = store.createEnvelope({ artifactType: 'actor-requirements', producer: 'actors:build', sourceDigest: snapshot.digest, inputDigests: { evidence: evidenceEnvelope.meta.contentDigest, operations: operationsEnvelope.meta.contentDigest }, data: actors });
  const pagesEnvelope = store.createEnvelope({ artifactType: 'page-contracts', producer: 'pages:build', sourceDigest: snapshot.digest, inputDigests: { evidence: evidenceEnvelope.meta.contentDigest }, data: pages });
  files.push(await store.write('actors', actorsEnvelope), await store.write('pages', pagesEnvelope));
  completedStages.push('contracts');
  if (stopAfter('contracts')) return summarize();

  const behavior = buildBehaviorGraph(bundle, operations, pages, config);
  const behaviorEnvelope = store.createEnvelope({ artifactType: 'behavior-graph', producer: 'behavior:build', sourceDigest: snapshot.digest, inputDigests: { operations: operationsEnvelope.meta.contentDigest, pages: pagesEnvelope.meta.contentDigest, actors: actorsEnvelope.meta.contentDigest }, data: behavior });
  files.push(await store.write('behavior', behaviorEnvelope));
  completedStages.push('behavior');
  if (stopAfter('behavior')) return summarize();

  const families = buildFlowFamilies(operations, actors, behavior);
  const familiesEnvelope = store.createEnvelope({ artifactType: 'flow-families', producer: 'families:discover', sourceDigest: snapshot.digest, inputDigests: { behavior: behaviorEnvelope.meta.contentDigest }, data: families });
  files.push(await store.write('families', familiesEnvelope));
  completedStages.push('families');
  if (stopAfter('families')) return summarize();

  const witnesses = searchPaths(behavior, families, config);
  const witnessesEnvelope = store.createEnvelope({ artifactType: 'path-witnesses', producer: 'paths:search', sourceDigest: snapshot.digest, inputDigests: { behavior: behaviorEnvelope.meta.contentDigest, families: familiesEnvelope.meta.contentDigest }, data: witnesses, status: witnesses.witnesses.some((witness) => witness.feasibility === 'conditional') ? 'proposed' : 'generated' });
  files.push(await store.write('witnesses', witnessesEnvelope));
  completedStages.push('witnesses');
  if (stopAfter('witnesses')) return summarize();

  variants = reduceVariants(witnesses, families, behavior);
  completedStages.push('variants');
  if (stopAfter('variants')) {
    const envelope = store.createEnvelope({ artifactType: 'flow-variants', producer: 'variants:reduce', sourceDigest: snapshot.digest, inputDigests: { witnesses: witnessesEnvelope.meta.contentDigest }, data: variants });
    files.push(await store.write('variants', envelope));
    return summarize();
  }

  const dataRequirements = buildDataRequirements(variants, pages, actors);
  const variantsEnvelope = store.createEnvelope({ artifactType: 'flow-variants', producer: 'variants:reduce', sourceDigest: snapshot.digest, inputDigests: { witnesses: witnessesEnvelope.meta.contentDigest }, data: variants, status: variants.variants.some((variant) => variant.feasibility === 'conditional') ? 'proposed' : 'generated' });
  files.push(await store.write('variants', variantsEnvelope));
  for (const variant of variants.variants) {
    const requirements = dataRequirements.filter((requirement) => requirement.variantId === variant.id);
    const destination = path.join(store.dataRequirementsDirectory, `${variant.id}.yaml`);
    await fs.writeFile(destination, stringifyYaml({
      meta: {
        artifactType: 'data-requirements',
        schemaVersion: '1.0',
        producer: 'data:plan',
        sourceDigest: snapshot.digest,
        configDigest: config.configDigest,
      },
      data: { variantId: variant.id, requirements },
    }, { lineWidth: 0, sortMapEntries: true }), 'utf8');
    files.push(destination);
  }
  completedStages.push('data');
  if (stopAfter('data')) return summarize();

  let runtime: RuntimeBindings = { bindings: [] };
  if (await store.exists('runtime')) {
    const runtimeEnvelope = await store.read<RuntimeBindings>('runtime');
    if (runtimeEnvelope.meta.sourceDigest === snapshot.digest) {
      runtime = runtimeEnvelope.data;
    } else {
      files.push(await store.write('runtime', store.createEnvelope({
        artifactType: 'runtime-bindings',
        producer: 'runtime:invalidate',
        sourceDigest: snapshot.digest,
        data: runtimeEnvelope.data,
        status: 'stale',
        unresolved: [{ code: 'RUNTIME_BINDINGS_STALE', severity: 'blocked', message: 'Source changed after runtime grounding; bindings must be revalidated.' }],
      })));
    }
  } else files.push(await store.write('runtime', store.createEnvelope({ artifactType: 'runtime-bindings', producer: 'runtime:initialize', sourceDigest: snapshot.digest, data: runtime })));
  const coverage = buildCoverage(bundle, operations, pages, actors, behavior, families, witnesses, variants, dataRequirements, runtime, config);
  const coverageEnvelope = store.createEnvelope({ artifactType: 'coverage', producer: 'coverage:build', sourceDigest: snapshot.digest, inputDigests: { variants: variantsEnvelope.meta.contentDigest }, data: coverage, unresolved: coverage.unresolved });
  files.push(await store.write('coverage', coverageEnvelope));
  completedStages.push('coverage');
  await fs.mkdir(path.join(config.outputRoot, 'runs'), { recursive: true });
  await fs.writeFile(path.join(config.outputRoot, 'runs', 'latest.json'), stableJson({ sourceDigest: snapshot.digest, configDigest: config.configDigest, completedStages, files }), 'utf8');
  return summarize();

  function summarize(): AnalyzeResult {
    return {
      completedStages,
      files,
      counts: {
        sourceFiles: bundle.sourceFiles.length,
        evidenceNodes: evidence.nodes.length,
        operations: operations?.operations.length ?? 0,
        pages: pages?.pages.length ?? 0,
        variants: variants?.variants.length ?? 0,
      },
    };
  }
}
