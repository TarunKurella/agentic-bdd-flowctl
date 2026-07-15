import path from 'node:path';
import { snapshotSources } from '../adapters/source.js';
import type { ArtifactStore } from '../core/artifact-store.js';
import { assertArtifactLineage } from '../core/freshness.js';
import { stableJson } from '../core/stable.js';
import { predicateLabel } from '../ir/predicates.js';
import type {
  ActorRequirement,
  ActorRequirements,
  BehaviorGraph,
  BehaviorNode,
  EvidenceGraph,
  FlowFamilies,
  FlowVariant,
  FlowVariants,
  OperationCatalog,
  PageContracts,
  PathWitness,
  PathWitnesses,
  Predicate,
  SourceRef,
} from '../ir/model.js';

export interface WitnessActionStep {
  sequence: number;
  actionId: string;
  actionLabel: string;
  screenId?: string;
  nextScreenId?: string;
  operationIds: string[];
  edgeIds: string[];
}

export interface GraphSummary {
  sourceDigest: string;
  evidence: {
    nodes: number;
    edges: number;
    nodesByKind: Record<string, number>;
    nodesByOrigin: Record<string, number>;
    unresolvedDiagnostics: number;
  };
  behavior: {
    nodes: number;
    edges: number;
    nodesByKind: Record<string, number>;
    edgesByOutcome: Record<string, number>;
    entryNodes: string[];
    successNodes: string[];
  };
  flows: {
    families: number;
    witnesses: number;
    variants: number;
    conditionalVariants: number;
  };
}

export interface VariantTrace {
  sourceDigest: string;
  variant: {
    id: string;
    label: string;
    familyId: string;
    feasibility: FlowVariant['feasibility'];
    behaviorSignature: string;
  };
  witness: {
    id: string;
    pathCondition: Predicate;
    pathConditionText: string;
    assignments: PathWitness['assignments'];
  };
  actors: ActorRequirement[];
  actionSteps: WitnessActionStep[];
  path: Array<{
    sequence: number;
    node: BehaviorNode;
    transition?: {
      id: string;
      guard: Predicate;
      guardText: string;
      effects: BehaviorGraph['edges'][number]['effects'];
      outcome: BehaviorGraph['edges'][number]['outcome'];
      evidenceRefs: string[];
    };
    sourceRefs: SourceRef[];
  }>;
  operations: Array<{
    id: string;
    label: string;
    method: string;
    pathTemplate: string;
    frontendOperationIds: string[];
    backendEndpointId: string;
    terminalEffectIds: string[];
    evidenceRefs: string[];
    sourceRefs: SourceRef[];
  }>;
  bdd: {
    generated: boolean;
    featurePath: string;
    scenarioTag: string;
    traceabilityPath: string;
  };
  unresolvedEvidenceRefs: string[];
}

export interface FlowListItem {
  id: string;
  label: string;
  familyId: string;
  feasibility: FlowVariant['feasibility'];
  pages: number;
  actions: number;
  actorRequirements: number;
  dataRequirements: number;
  assignments: PathWitness['assignments'];
}

export function deriveActionSteps(witness: PathWitness, graph: BehaviorGraph): WitnessActionStep[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const steps: WitnessActionStep[] = [];
  let currentScreenId: string | undefined;

  witness.nodePath.forEach((nodeId, index) => {
    const node = nodeById.get(nodeId);
    if (!node) return;
    if (node.kind === 'screen-state') {
      currentScreenId = node.id;
      return;
    }
    if (node.kind !== 'action') return;

    let nextScreenIndex: number | undefined;
    let boundaryIndex = witness.nodePath.length - 1;
    const operationIds: string[] = [];
    for (let cursor = index + 1; cursor < witness.nodePath.length; cursor += 1) {
      const candidate = nodeById.get(witness.nodePath[cursor]!);
      if (!candidate) continue;
      if (candidate.kind === 'operation') operationIds.push(candidate.referenceId ?? candidate.id);
      if (candidate.kind === 'screen-state') {
        nextScreenIndex = cursor;
        boundaryIndex = cursor;
        break;
      }
      if (candidate.kind === 'action') {
        boundaryIndex = cursor;
        break;
      }
    }

    steps.push({
      sequence: steps.length + 1,
      actionId: node.id,
      actionLabel: node.label,
      ...(currentScreenId ? { screenId: currentScreenId } : {}),
      ...(nextScreenIndex !== undefined ? { nextScreenId: witness.nodePath[nextScreenIndex] } : {}),
      operationIds,
      edgeIds: witness.edgePath.slice(Math.max(0, index - 1), boundaryIndex),
    });
  });

  return steps;
}

export async function buildGraphSummary(store: ArtifactStore): Promise<GraphSummary> {
  const [evidence, behavior, families, witnesses, variants] = await Promise.all([
    store.read<EvidenceGraph>('evidence'),
    store.read<BehaviorGraph>('behavior'),
    store.read<FlowFamilies>('families'),
    store.read<PathWitnesses>('witnesses'),
    store.read<FlowVariants>('variants'),
  ]);
  await assertArtifactLineage(store, [
    { name: 'evidence', envelope: evidence },
    { name: 'behavior', envelope: behavior },
    { name: 'families', envelope: families },
    { name: 'witnesses', envelope: witnesses },
    { name: 'variants', envelope: variants },
  ]);
  await assertArtifactsCurrent(store, [evidence, behavior, families, witnesses, variants]);
  return {
    sourceDigest: evidence.meta.sourceDigest,
    evidence: {
      nodes: evidence.data.nodes.length,
      edges: evidence.data.edges.length,
      nodesByKind: countBy(evidence.data.nodes.map((node) => node.kind)),
      nodesByOrigin: countBy(evidence.data.nodes.map((node) => node.origin)),
      unresolvedDiagnostics: evidence.data.diagnostics.length,
    },
    behavior: {
      nodes: behavior.data.nodes.length,
      edges: behavior.data.edges.length,
      nodesByKind: countBy(behavior.data.nodes.map((node) => node.kind)),
      edgesByOutcome: countBy(behavior.data.edges.map((edge) => edge.outcome)),
      entryNodes: behavior.data.entryNodeIds,
      successNodes: behavior.data.successNodeIds,
    },
    flows: {
      families: families.data.families.length,
      witnesses: witnesses.data.witnesses.length,
      variants: variants.data.variants.length,
      conditionalVariants: variants.data.variants.filter((variant) => variant.feasibility === 'conditional').length,
    },
  };
}

export async function listFlows(store: ArtifactStore): Promise<FlowListItem[]> {
  const [variants, witnesses] = await Promise.all([
    store.read<FlowVariants>('variants'),
    store.read<PathWitnesses>('witnesses'),
  ]);
  await assertArtifactLineage(store, [
    { name: 'variants', envelope: variants },
    { name: 'witnesses', envelope: witnesses },
  ]);
  await assertArtifactsCurrent(store, [variants, witnesses]);
  return variants.data.variants.map((variant) => {
    const witness = witnesses.data.witnesses.find((candidate) => candidate.id === variant.witnessIds[0]);
    return {
      id: variant.id,
      label: variant.label,
      familyId: variant.familyId,
      feasibility: variant.feasibility,
      pages: variant.pageSequence.length,
      actions: variant.actionSequence.length,
      actorRequirements: variant.actorRequirementIds.length,
      dataRequirements: variant.dataRequirementIds.length,
      assignments: witness?.assignments ?? {},
    };
  });
}

export async function buildVariantTrace(store: ArtifactStore, variantId: string): Promise<VariantTrace> {
  const [variants, witnesses, behavior, evidence, operations, actors, families, pages] = await Promise.all([
    store.read<FlowVariants>('variants'),
    store.read<PathWitnesses>('witnesses'),
    store.read<BehaviorGraph>('behavior'),
    store.read<EvidenceGraph>('evidence'),
    store.read<OperationCatalog>('operations'),
    store.read<ActorRequirements>('actors'),
    store.read<FlowFamilies>('families'),
    store.read<PageContracts>('pages'),
  ]);
  await assertArtifactLineage(store, [
    { name: 'variants', envelope: variants },
    { name: 'witnesses', envelope: witnesses },
    { name: 'behavior', envelope: behavior },
    { name: 'evidence', envelope: evidence },
    { name: 'operations', envelope: operations },
    { name: 'actors', envelope: actors },
    { name: 'families', envelope: families },
    { name: 'pages', envelope: pages },
  ]);
  await assertArtifactsCurrent(store, [variants, witnesses, behavior, evidence, operations, actors, families, pages]);
  const variant = variants.data.variants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`Unknown variant ${variantId}.`);
  const witness = witnesses.data.witnesses.find((candidate) => candidate.id === variant.witnessIds[0]);
  if (!witness) throw new Error(`Variant ${variantId} has no readable path witness.`);

  const behaviorNodes = new Map(behavior.data.nodes.map((node) => [node.id, node]));
  const behaviorEdges = new Map(behavior.data.edges.map((edge) => [edge.id, edge]));
  const evidenceNodes = new Map(evidence.data.nodes.map((node) => [node.id, node]));
  const evidenceEdges = new Map(evidence.data.edges.map((edge) => [edge.id, edge]));
  const operationsById = new Map(operations.data.operations.map((operation) => [operation.id, operation]));
  const resolvedEvidence = new Set<string>();

  const resolveSourceRefs = (refs: string[]): SourceRef[] => {
    const values: SourceRef[] = [];
    for (const ref of refs) {
      const item = evidenceNodes.get(ref) ?? evidenceEdges.get(ref);
      if (item) {
        resolvedEvidence.add(ref);
        values.push(...item.sourceRefs);
        continue;
      }
      const operation = operationsById.get(ref);
      if (!operation) continue;
      resolvedEvidence.add(ref);
      const operationRefs = [
        ...operation.frontendOperationIds,
        operation.backendEndpointId,
        ...operation.terminalEffectIds,
        ...operation.evidenceRefs,
      ];
      for (const operationRef of operationRefs) {
        const operationItem = evidenceNodes.get(operationRef) ?? evidenceEdges.get(operationRef);
        if (!operationItem) continue;
        resolvedEvidence.add(operationRef);
        values.push(...operationItem.sourceRefs);
      }
    }
    return dedupeSourceRefs(values);
  };

  const tracePath = witness.nodePath.map((nodeId, index) => {
    const node = behaviorNodes.get(nodeId);
    if (!node) throw new Error(`Witness ${witness.id} references unknown behavior node ${nodeId}.`);
    const transition = witness.edgePath[index] ? behaviorEdges.get(witness.edgePath[index]!) : undefined;
    const refs = [node.id, ...(node.referenceId ? [node.referenceId] : []), ...(transition?.evidenceRefs ?? [])];
    return {
      sequence: index + 1,
      node,
      ...(transition ? {
        transition: {
          id: transition.id,
          guard: transition.guard,
          guardText: predicateLabel(transition.guard),
          effects: transition.effects,
          outcome: transition.outcome,
          evidenceRefs: transition.evidenceRefs,
        },
      } : {}),
      sourceRefs: resolveSourceRefs(refs),
    };
  });

  const operationTrace = variant.operationIds.map((operationId) => {
    const operation = operations.data.operations.find((candidate) => candidate.id === operationId);
    if (!operation) throw new Error(`Variant ${variantId} references unknown operation ${operationId}.`);
    const refs = [
      ...operation.frontendOperationIds,
      operation.backendEndpointId,
      ...operation.terminalEffectIds,
      ...operation.evidenceRefs,
    ];
    return {
      id: operation.id,
      label: operation.businessCommand.label,
      method: operation.method,
      pathTemplate: operation.pathTemplate,
      frontendOperationIds: operation.frontendOperationIds,
      backendEndpointId: operation.backendEndpointId,
      terminalEffectIds: operation.terminalEffectIds,
      evidenceRefs: operation.evidenceRefs,
      sourceRefs: resolveSourceRefs(refs),
    };
  });

  const allEvidenceRefs = new Set([
    ...variant.evidenceRefs,
    ...witness.evidenceRefs,
    ...operationTrace.flatMap((operation) => operation.evidenceRefs),
  ]);
  resolveSourceRefs([...allEvidenceRefs]);

  const featurePath = variant.feasibility === 'conditional'
    ? path.join(store.generatedDirectory, 'review', 'conditional-journeys', `${variant.familyId}.feature.txt`)
    : path.join(store.generatedDirectory, 'features', 'journeys', `${variant.familyId}.feature`);
  const traceabilityPath = path.join(store.generatedDirectory, 'bdd-traceability.json');
  const generated = await bddGeneratedFor(
    store,
    featurePath,
    traceabilityPath,
    behavior.meta.sourceDigest,
    store.config.configDigest,
    {
      families: families.meta.contentDigest,
      variants: variants.meta.contentDigest,
      behavior: behavior.meta.contentDigest,
      witnesses: witnesses.meta.contentDigest,
      pages: pages.meta.contentDigest,
      actors: actors.meta.contentDigest,
      operations: operations.meta.contentDigest,
    },
    variant.id,
  );
  return {
    sourceDigest: behavior.meta.sourceDigest,
    variant: {
      id: variant.id,
      label: variant.label,
      familyId: variant.familyId,
      feasibility: variant.feasibility,
      behaviorSignature: variant.behaviorSignature,
    },
    witness: {
      id: witness.id,
      pathCondition: witness.pathCondition,
      pathConditionText: predicateLabel(witness.pathCondition),
      assignments: witness.assignments,
    },
    actors: variant.actorRequirementIds
      .map((id) => actors.data.actors.find((actor) => actor.id === id))
      .filter((actor): actor is ActorRequirement => Boolean(actor)),
    actionSteps: deriveActionSteps(witness, behavior.data),
    path: tracePath,
    operations: operationTrace,
    bdd: {
      generated,
      featurePath: portablePath(store, featurePath),
      scenarioTag: `@variant:${variant.id}`,
      traceabilityPath: portablePath(store, traceabilityPath),
    },
    unresolvedEvidenceRefs: [...allEvidenceRefs].filter((ref) => !resolvedEvidence.has(ref)).sort(),
  };
}

export function renderGraphSummary(summary: GraphSummary): string {
  const kinds = Object.entries(summary.evidence.nodesByKind)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `  ${kind.padEnd(24)} ${count}`)
    .join('\n');
  const origins = Object.entries(summary.evidence.nodesByOrigin)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([origin, count]) => `  ${origin.padEnd(24)} ${count}`)
    .join('\n');
  const outcomes = Object.entries(summary.behavior.edgesByOutcome)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([outcome, count]) => `  ${outcome.padEnd(24)} ${count}`)
    .join('\n');
  return [
    'FLOWCTL GRAPH SUMMARY',
    '',
    `Evidence graph   ${summary.evidence.nodes} nodes · ${summary.evidence.edges} edges`,
    `Behavior graph   ${summary.behavior.nodes} nodes · ${summary.behavior.edges} edges`,
    `Entry / success  ${summary.behavior.entryNodes.length} / ${summary.behavior.successNodes.length}`,
    `Flows            ${summary.flows.families} families · ${summary.flows.variants} variants · ${summary.flows.witnesses} witnesses`,
    `Conditional      ${summary.flows.conditionalVariants}`,
    `Unresolved       ${summary.evidence.unresolvedDiagnostics}`,
    '',
    'EVIDENCE NODE KINDS',
    kinds || '  none',
    '',
    'EVIDENCE ORIGINS',
    origins || '  none',
    '',
    'BEHAVIOR EDGE OUTCOMES',
    outcomes || '  none',
    '',
    'Inspect a proof: flowctl graph trace <variant-id>',
  ].join('\n');
}

export function renderFlowList(flows: FlowListItem[]): string {
  const lines = ['FLOWCTL FLOWS', ''];
  if (!flows.length) return `${lines.join('\n')}No variants found. Run flowctl analyze.`;
  for (const flow of flows) {
    const assignments = Object.entries(flow.assignments).map(([key, value]) => `${key}=${String(value)}`).join(', ') || 'none';
    lines.push(`${flow.id}`);
    lines.push(`  ${flow.label}`);
    lines.push(`  family ${flow.familyId} · ${flow.feasibility} · ${flow.pages} pages · ${flow.actions} actions`);
    lines.push(`  ${flow.actorRequirements} actor contract(s) · ${flow.dataRequirements} data requirement(s) · assignments: ${assignments}`);
  }
  lines.push('', 'Inspect one: flowctl graph trace <variant-id>');
  return lines.join('\n');
}

export function renderVariantTrace(trace: VariantTrace): string {
  const lines = [
    `FLOWCTL FLOW PROOF · ${trace.variant.id}`,
    '',
    trace.variant.label,
    `Feasibility       ${trace.variant.feasibility}`,
    `Witness           ${trace.witness.id}`,
    `Path condition    ${trace.witness.pathConditionText}`,
    `Assignments       ${Object.entries(trace.witness.assignments).map(([key, value]) => `${key}=${String(value)}`).join(', ') || 'none'}`,
    `Behavior signature ${trace.variant.behaviorSignature}`,
    '',
    'ACTOR CONTRACT',
  ];
  if (!trace.actors.length) lines.push('  none');
  for (const actor of trace.actors) {
    lines.push(`  ${actor.label}`);
    lines.push(`    authentication ${actor.authentication}`);
    lines.push(`    authorities    ${actor.authoritiesAll.join(', ') || 'none'}`);
    lines.push(`    roles          ${actor.rolesAll.join(', ') || 'none'}`);
    if (actor.relationships.length) lines.push(`    relationships  ${actor.relationships.join(', ')}`);
  }
  lines.push('',
    'BEHAVIOR PATH',
  );
  for (const item of trace.path) {
    lines.push(`${String(item.sequence).padStart(2, '0')}. [${item.node.kind}] ${item.node.label}`);
    if (item.transition) {
      lines.push(`    -- ${item.transition.guardText} / ${item.transition.outcome} -->`);
    }
    for (const source of item.sourceRefs.slice(0, 3)) {
      lines.push(`    source: ${source.file}:${source.line}${source.symbol ? ` · ${source.symbol}` : ''}`);
    }
  }
  lines.push('', 'ACTION STEPS');
  for (const step of trace.actionSteps) {
    lines.push(`${String(step.sequence).padStart(2, '0')}. ${step.screenId ?? 'unknown screen'} -- ${step.actionLabel} --> ${step.nextScreenId ?? 'terminal outcome'}`);
    lines.push(`    action ${step.actionId}`);
    lines.push(`    operation ${step.operationIds.join(', ') || 'none'}`);
  }
  lines.push('', 'BUSINESS OPERATIONS');
  for (const operation of trace.operations) {
    lines.push(`  ${operation.label}: ${operation.method} ${operation.pathTemplate}`);
    lines.push(`    frontend ${operation.frontendOperationIds.join(', ') || 'unresolved'}`);
    lines.push(`    backend  ${operation.backendEndpointId}`);
    lines.push(`    effects  ${operation.terminalEffectIds.join(', ') || 'unresolved'}`);
  }
  lines.push('', 'BDD');
  lines.push(`  ${trace.bdd.generated ? 'generated' : 'not generated'} · ${trace.bdd.scenarioTag}`);
  lines.push(`  feature: ${trace.bdd.featurePath}`);
  lines.push(`  trace:   ${trace.bdd.traceabilityPath}`);
  if (trace.unresolvedEvidenceRefs.length) {
    lines.push('', `UNRESOLVED REFERENCES (${trace.unresolvedEvidenceRefs.length})`);
    trace.unresolvedEvidenceRefs.slice(0, 10).forEach((ref) => lines.push(`  ${ref}`));
  }
  return lines.join('\n');
}

function countBy(values: string[]): Record<string, number> {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((candidate) => candidate === value).length]));
}

function dedupeSourceRefs(values: SourceRef[]): SourceRef[] {
  return [...new Map(values.map((value) => [`${value.file}:${value.line}:${value.endLine ?? ''}:${value.symbol ?? ''}`, value])).values()];
}

function portablePath(store: ArtifactStore, value: string): string {
  const relative = path.relative(store.config.projectRoot, value);
  return relative.startsWith('..') ? value : relative || '.';
}

async function bddGeneratedFor(
  store: ArtifactStore,
  featurePath: string,
  traceabilityPath: string,
  sourceDigest: string,
  configDigest: string,
  inputDigests: Record<string, string>,
  variantId: string,
): Promise<boolean> {
  if (!(await store.managedFileExists(featurePath)) || !(await store.managedFileExists(traceabilityPath))) return false;
  try {
    const trace = JSON.parse(await store.readManagedFile(traceabilityPath)) as {
      sourceDigest?: string;
      configDigest?: string;
      inputDigests?: Record<string, string>;
      journeys?: Array<{ variants?: Array<{ variantId?: string }> }>;
    };
    return trace.sourceDigest === sourceDigest
      && trace.configDigest === configDigest
      && stableJson(trace.inputDigests ?? {}) === stableJson(inputDigests)
      && Boolean(trace.journeys?.some((journey) => journey.variants?.some((variant) => variant.variantId === variantId)));
  } catch {
    return false;
  }
}

async function assertArtifactsCurrent(
  store: ArtifactStore,
  artifacts: Array<{ meta: { artifactType: string; sourceDigest: string; configDigest: string; status: string } }>,
): Promise<void> {
  const currentSourceDigest = (await snapshotSources(store.config)).digest;
  const stale = artifacts.find((artifact) => (
    artifact.meta.status === 'stale'
    || artifact.meta.sourceDigest !== currentSourceDigest
    || artifact.meta.configDigest !== store.config.configDigest
  ));
  if (stale) {
    throw new Error(`${stale.meta.artifactType} is stale. Run flowctl analyze --through coverage before inspecting graph proofs.`);
  }
}
