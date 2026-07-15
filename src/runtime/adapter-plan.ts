import path from 'node:path';
import { snapshotSources } from '../adapters/source.js';
import type { ArtifactStore } from '../core/artifact-store.js';
import { shellQuote } from '../core/command.js';
import { assertArtifactLineage } from '../core/freshness.js';
import { safeChildPath, safeFileSegment } from '../core/paths.js';
import { stableJson } from '../core/stable.js';
import { readVariantRequirements } from '../data/bindings.js';
import { deriveActionSteps } from '../graph/trace.js';
import type {
  ActorRequirements,
  BehaviorGraph,
  FlowVariants,
  PageContracts,
  PathWitnesses,
} from '../ir/model.js';
import { allPredicates, solvePredicate } from '../ir/predicates.js';
import {
  loadAdapterManifest,
  permittedAdapterIds,
  type AdapterManifest,
  type RuntimeTargetKind,
} from './adapters.js';

export interface RuntimeAdapterTarget {
  targetKind: RuntimeTargetKind;
  targetId: string;
  screenId?: string;
  controlKind?: string;
  dataRequirementIds?: string[];
}

export interface RuntimeAdapterPlan {
  variantId: string;
  witnessId: string;
  configuredManifestPath: string;
  implementationPath: string;
  targets: RuntimeAdapterTarget[];
  manifestTemplate: AdapterManifest;
  implementationTemplate: string;
  scaffoldManifestPath: string;
  scaffoldImplementationPath: string;
  configInstruction?: string;
  validationCommand: string;
  rules: string[];
}

export async function planRuntimeAdapters(store: ArtifactStore, variantId: string): Promise<RuntimeAdapterPlan> {
  const inventory = await runtimeAdapterTargetInventory(store, variantId);
  const configuredManifestPath = store.config.runtime.adapterManifest ?? 'runtime/adapters.json';
  const implementationPath = 'runtime/flowctl-adapters.ts';
  const adapters = suggestedAdapters(inventory.targets);
  const manifestTemplate: AdapterManifest = { version: 1, implementation: implementationPath, adapters };
  const implementationTemplate = renderImplementationTemplate(adapters);
  const directory = safeChildPath(
    path.join(store.workDirectory, 'runtime', 'adapter-scaffolds'),
    safeFileSegment(variantId, 'Variant ID'),
  );
  const scaffoldManifestPath = safeChildPath(directory, 'adapters.example.json');
  const scaffoldImplementationPath = safeChildPath(directory, 'flowctl-adapters.example.ts');
  await Promise.all([
    store.writeManagedFile(scaffoldManifestPath, stableJson(manifestTemplate)),
    store.writeManagedFile(scaffoldImplementationPath, implementationTemplate),
  ]);
  return {
    variantId,
    witnessId: inventory.witnessId,
    configuredManifestPath,
    implementationPath,
    targets: inventory.targets,
    manifestTemplate,
    implementationTemplate,
    scaffoldManifestPath,
    scaffoldImplementationPath,
    ...(store.config.runtime.adapterManifest ? {} : {
      configInstruction: `Set runtime.adapterManifest to ${configuredManifestPath} in flowctl.config.yaml.`,
    }),
    validationCommand: `flowctl ground adapters verify --variant ${shellQuote(variantId)} --config ${shellQuote(store.config.configPath)}`,
    rules: [
      'Implement every declared adapter as a callable property of export const flowctlAdapters.',
      'Actor-session adapters resolve each actorDataRequirementId through its manifest handoff; never embed credentials or raw secrets.',
      'Field adapters resolve each dataRequirementId through its logical alias, approved strategy and lookup reference; never guess a value.',
      'Screen and action adapters must use durable unique/actionable locators; never persist snapshot-local references or force clicks.',
      'The generated implementation scaffold intentionally uses undefined placeholders, so validation remains blocked until real adapters exist.',
    ],
  };
}

export async function verifyRuntimeAdapters(store: ArtifactStore, variantId: string): Promise<{
  valid: true;
  manifestPath: string;
  implementationPath: string;
  adapterManifestDigest: string;
  targets: RuntimeAdapterTarget[];
}> {
  const [inventory, loaded] = await Promise.all([
    runtimeAdapterTargetInventory(store, variantId),
    loadAdapterManifest(store),
  ]);
  const uncovered = inventory.targets.filter((target) => (
    permittedAdapterIds(loaded, target.targetKind, target.controlKind).length === 0
  ));
  if (uncovered.length) {
    throw new Error(`Runtime adapter registry does not cover: ${uncovered.map((target) => `${target.targetKind}:${target.targetId}${target.controlKind ? ` (${target.controlKind})` : ''}`).join(', ')}.`);
  }
  return {
    valid: true,
    manifestPath: loaded.path,
    implementationPath: loaded.implementationPath,
    adapterManifestDigest: loaded.digest,
    targets: inventory.targets,
  };
}

async function runtimeAdapterTargetInventory(store: ArtifactStore, variantId: string): Promise<{
  witnessId: string;
  targets: RuntimeAdapterTarget[];
}> {
  const [variants, witnesses, behavior, pages, actors, requirements] = await Promise.all([
    store.read<FlowVariants>('variants'),
    store.read<PathWitnesses>('witnesses'),
    store.read<BehaviorGraph>('behavior'),
    store.read<PageContracts>('pages'),
    store.read<ActorRequirements>('actors'),
    readVariantRequirements(store, variantId),
  ]);
  await assertArtifactLineage(store, [
    { name: 'variants', envelope: variants },
    { name: 'witnesses', envelope: witnesses },
    { name: 'behavior', envelope: behavior },
    { name: 'pages', envelope: pages },
    { name: 'actors', envelope: actors },
  ]);
  const currentSourceDigest = (await snapshotSources(store.config)).digest;
  const stale = [variants, witnesses, behavior, pages, actors].find((artifact) => (
    artifact.meta.status === 'stale'
    || artifact.meta.sourceDigest !== currentSourceDigest
    || artifact.meta.configDigest !== store.config.configDigest
  ));
  if (stale) throw new Error(`${stale.meta.artifactType} is stale; rerun flowctl discover before planning runtime adapters.`);
  const variant = variants.data.variants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`Unknown variant ${variantId}.`);
  const witness = witnesses.data.witnesses.find((candidate) => candidate.id === variant.witnessIds[0]);
  if (!witness) throw new Error(`Variant ${variantId} has no readable representative witness.`);
  const nodeById = new Map(behavior.data.nodes.map((node) => [node.id, node]));
  const unscopedActorData = requirements.filter((requirement) => (
    (requirement.classification === 'authenticated-identity' || requirement.classification === 'actor-attribute')
    && !requirement.actorRequirementId
  ));
  if (unscopedActorData.length) {
    throw new Error(`Runtime adapter planning requires actorRequirementId on actor data requirement(s): ${unscopedActorData.map((requirement) => requirement.id).join(', ')}.`);
  }
  const actorIds = new Set(variant.actorRequirementIds.filter((actorId) => (
    actors.data.actors.some((actor) => actor.id === actorId && actor.authentication === 'required')
  )));
  const actorDataRequirementIds = requirements
    .filter((requirement) => (
      (requirement.classification === 'authenticated-identity' || requirement.classification === 'actor-attribute')
      && requirement.actorRequirementId
      && actorIds.has(requirement.actorRequirementId)
    ))
    .map((requirement) => requirement.id)
    .sort();
  const targets: RuntimeAdapterTarget[] = actorIds.size ? [{
    targetKind: 'actor-session',
    targetId: [...actorIds].sort().join('+'),
    dataRequirementIds: actorDataRequirementIds,
  }] : [];
  const lastActionIndex = witness.nodePath.reduce((latest, nodeId, index) => (
    nodeById.get(nodeId)?.kind === 'action' ? index : latest
  ), -1);
  for (let pathIndex = 0; pathIndex < witness.nodePath.length; pathIndex += 1) {
    const nodeId = witness.nodePath[pathIndex]!;
    const node = nodeById.get(nodeId);
    if (node?.kind !== 'screen-state') continue;
    const page = pages.data.pages.find((candidate) => candidate.id === node.id);
    if (!page) throw new Error(`Witness ${witness.id} references missing page contract ${node.id}.`);
    targets.push({ targetKind: 'screen-state', targetId: node.id, screenId: node.id });
    // A screen reached after the final journey action is an outcome probe only.
    // Keep its screen adapter, but never ask for field adapters or input data there.
    if (pathIndex > lastActionIndex) continue;
    const visibleFields = page.fields.filter((candidate) => (
      solvePredicate(allPredicates([witness.pathCondition, ...candidate.visibleWhen])).status !== 'unsatisfiable'
    ));
    const conditionalInput = visibleFields.find((field) => field.inputMode === 'conditional');
    if (conditionalInput) {
      throw new Error(`Runtime adapter planning requires review for ${page.id}/${conditionalInput.id}: its input mode is conditional, so a writable field adapter cannot be assumed.`);
    }
    for (const field of visibleFields.filter((candidate) => (candidate.inputMode ?? 'editable') === 'editable')) {
      const requirementIds = requirements.filter((requirement) => (
        requirement.pageId === page.id && requirement.fieldId === field.id
      )).map((requirement) => requirement.id);
      targets.push({
        targetKind: 'field',
        targetId: field.id,
        screenId: page.id,
        controlKind: field.controlKind,
        dataRequirementIds: requirementIds,
      });
    }
  }
  for (const action of deriveActionSteps(witness, behavior.data)) {
    targets.push({
      targetKind: 'action',
      targetId: action.actionId,
      ...(action.screenId ? { screenId: action.screenId } : {}),
    });
  }
  return { witnessId: witness.id, targets: deduplicateTargets(targets) };
}

function suggestedAdapters(targets: RuntimeAdapterTarget[]): AdapterManifest['adapters'] {
  const adapters: AdapterManifest['adapters'] = [];
  if (targets.some((target) => target.targetKind === 'actor-session')) {
    adapters.push({ id: 'flowctl-actor-session', targets: ['actor-session'] });
  }
  if (targets.some((target) => target.targetKind === 'screen-state')) {
    adapters.push({ id: 'flowctl-screen-state', targets: ['screen-state'] });
  }
  for (const controlKind of [...new Set(targets
    .filter((target) => target.targetKind === 'field')
    .map((target) => target.controlKind ?? 'unknown'))].sort()) {
    adapters.push({
      id: `flowctl-field-${safeAdapterId(controlKind)}`,
      targets: ['field'],
      controlKinds: [controlKind],
    });
  }
  if (targets.some((target) => target.targetKind === 'action')) {
    adapters.push({ id: 'flowctl-action', targets: ['action'] });
  }
  return adapters;
}

function renderImplementationTemplate(adapters: AdapterManifest['adapters']): string {
  return [
    '// Replace every undefined value with a real async adapter. Flowctl validation rejects these placeholders.',
    '// Resolve actor and field values only from the manifest handoff keyed by stable data requirement ID.',
    'export const flowctlAdapters = {',
    ...adapters.map((adapter) => `  '${adapter.id}': undefined,`),
    '};',
    '',
  ].join('\n');
}

function deduplicateTargets(targets: RuntimeAdapterTarget[]): RuntimeAdapterTarget[] {
  return [...new Map(targets.map((target) => [stableJson(target), target])).values()];
}

function safeAdapterId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'control';
}

export function renderRuntimeAdapterPlan(plan: RuntimeAdapterPlan): string {
  const byKind = (kind: RuntimeTargetKind) => plan.targets.filter((target) => target.targetKind === kind);
  return [
    `FLOWCTL RUNTIME ADAPTER PLAN · ${plan.variantId}`,
    '',
    `Witness        ${plan.witnessId}`,
    `Manifest       ${plan.configuredManifestPath}`,
    `Implementation ${plan.implementationPath}`,
    `Targets        ${byKind('actor-session').length} actor-session · ${byKind('screen-state').length} screen-state · ${byKind('field').length} field · ${byKind('action').length} action`,
    '',
    'TARGET INVENTORY',
    ...plan.targets.map((target) => `- ${target.targetKind}:${target.targetId}${target.controlKind ? ` (${target.controlKind})` : ''}${target.dataRequirementIds?.length ? ` requirements=[${target.dataRequirementIds.join(', ')}]` : ''}`),
    '',
    'SCAFFOLDS',
    `- Manifest example: ${plan.scaffoldManifestPath}`,
    `- Implementation example: ${plan.scaffoldImplementationPath}`,
    ...(plan.configInstruction ? ['', plan.configInstruction] : []),
    '',
    'VALIDATE',
    plan.validationCommand,
    '',
    ...plan.rules.map((rule) => `- ${rule}`),
  ].join('\n');
}
