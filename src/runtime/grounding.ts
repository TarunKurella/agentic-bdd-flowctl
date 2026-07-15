import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { snapshotSources } from '../adapters/source.js';
import type { ArtifactStore } from '../core/artifact-store.js';
import { EXIT_CODE, FlowctlError } from '../core/errors.js';
import { assertArtifactLineage } from '../core/freshness.js';
import { safeChildPath, safeFileSegment } from '../core/paths.js';
import { readApplicationBindings, readVariantRequirements, verifyVariantData } from '../data/bindings.js';
import { deriveActionSteps } from '../graph/trace.js';
import { allPredicates, solvePredicate } from '../ir/predicates.js';
import { loadAdapterManifest, permittedAdapterIds, type LoadedAdapterManifest, type RuntimeTargetKind } from './adapters.js';
import { sha256, stableId, stableJson } from '../core/stable.js';
import type {
  ActorRequirements,
  BehaviorGraph,
  DataRequirement,
  FlowVariant,
  FlowVariants,
  PageContracts,
  PathWitness,
  PathWitnesses,
  RuntimeBinding,
  RuntimeBindings,
} from '../ir/model.js';

const LocatorSchema = z.object({
  strategy: z.enum(['role-and-name', 'label', 'test-id', 'scoped-text', 'reviewed-css']),
  role: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  value: z.string().trim().min(1).optional(),
}).strict().superRefine((locator, context) => {
  if (locator.strategy === 'role-and-name' && (!locator.role || !locator.name)) {
    context.addIssue({ code: 'custom', message: 'role-and-name requires both role and accessible name.' });
  }
  if (locator.strategy === 'label' && !locator.name && !locator.value) {
    context.addIssue({ code: 'custom', message: 'label requires a durable label name or value.' });
  }
  if (['test-id', 'scoped-text', 'reviewed-css'].includes(locator.strategy) && !locator.value) {
    context.addIssue({ code: 'custom', message: `${locator.strategy} requires a durable locator value.` });
  }
});

const ObservationAdapterSchema = z.object({
  componentAdapter: z.string().trim().min(1),
  evidenceRefs: z.array(z.string()).default([]),
}).strict();

const VisibleProbeSchema = z.object({
  matchCount: z.literal(1),
  visible: z.literal(true),
}).strict();

const ValueResolutionSchema = z.object({
  source: z.enum(['canonical-representative', 'application-data']),
  requirementId: z.string().min(1),
  logicalAlias: z.string().min(1),
  strategy: z.string().min(1),
  lookupFile: z.string().min(1),
  lookupKey: z.string().min(1),
  secretHandle: z.string().min(1).optional(),
}).strict();

const ObservationItemSchema = z.discriminatedUnion('targetKind', [
  ObservationAdapterSchema.extend({
    targetKind: z.literal('actor-session'),
    actorRequirementIds: z.array(z.string().min(1)).min(1),
    actorRequirementsDigest: z.string().min(1),
    identityBindingDigests: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length > 0, 'At least one identity binding digest is required.'),
    actorDataRequirementIds: z.array(z.string().min(1)).min(1),
    actorDataBindingDigests: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length > 0, 'At least one actor-data binding digest is required.'),
    actorDataResolutionDigests: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length > 0, 'At least one actor-data resolution digest is required.'),
    probe: z.object({ sessionEstablished: z.literal(true) }).strict(),
  }),
  ObservationAdapterSchema.extend({
    targetKind: z.literal('screen-state'),
    screenId: z.string().min(1),
    screenStatePhase: z.enum(['entry', 'intermediate', 'success']),
    locator: LocatorSchema,
    unique: z.literal(true),
    observedUrl: z.string().url().optional(),
    probe: VisibleProbeSchema,
  }),
  ObservationAdapterSchema.extend({
    targetKind: z.literal('field'),
    screenId: z.string().min(1),
    fieldId: z.string().min(1),
    dataRequirementId: z.string().min(1),
    dataRequirementDigest: z.string().min(1),
    valueBindingDigest: z.string().min(1),
    valueAvailability: z.enum(['representative-value', 'application-value', 'secret-reference']),
    valueResolutionDigest: z.string().min(1),
    locator: LocatorSchema,
    unique: z.literal(true),
    actionable: z.literal(true),
    probe: VisibleProbeSchema.extend({
      enabled: z.literal(true),
      writable: z.literal(true),
      valueAvailable: z.literal(true),
      valueAccepted: z.literal(true),
    }).strict(),
  }),
  ObservationAdapterSchema.extend({
    targetKind: z.literal('action'),
    screenId: z.string().min(1),
    actionId: z.string().min(1),
    locator: LocatorSchema,
    unique: z.literal(true),
    actionable: z.literal(true),
    probe: VisibleProbeSchema.extend({ enabled: z.literal(true) }).strict(),
    observedOperationId: z.string().optional(),
    observedNextStateId: z.string().optional(),
  }),
]);

const ObservationSchema = z.object({
  runId: z.string().min(1),
  manifestDigest: z.string().min(1),
  adapterManifestDigest: z.string().min(1),
  producer: z.literal('flowctl-playwright-adapter-runner'),
  environment: z.string().min(1),
  observations: z.array(ObservationItemSchema).min(1),
}).strict();

const ManifestStepBaseSchema = z.object({
  sequence: z.number().int().positive(),
  sourceEvidenceRefs: z.array(z.string()),
  permittedAdapterIds: z.array(z.string()).min(1),
}).strict();

const ManifestStepSchema = z.discriminatedUnion('targetKind', [
  ManifestStepBaseSchema.extend({
    targetKind: z.literal('actor-session'),
    actorRequirementIds: z.array(z.string()).min(1),
    actorRequirementsDigest: z.string(),
    identityBindingDigests: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length > 0),
    actorDataRequirementIds: z.array(z.string()).min(1),
    actorDataBindingDigests: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length > 0),
    actorDataResolutions: z.record(z.string(), ValueResolutionSchema).refine((value) => Object.keys(value).length > 0),
    actorDataResolutionDigests: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length > 0),
  }),
  ManifestStepBaseSchema.extend({
    targetKind: z.literal('screen-state'),
    screenId: z.string(),
    screenStatePhase: z.enum(['entry', 'intermediate', 'success']),
    routePatterns: z.array(z.string()),
  }),
  ManifestStepBaseSchema.extend({
    targetKind: z.literal('field'),
    screenId: z.string(),
    fieldId: z.string(),
    fieldPath: z.string(),
    dataRequirementId: z.string(),
    dataRequirementDigest: z.string(),
    valueBindingDigest: z.string(),
    valueAvailability: z.enum(['representative-value', 'application-value', 'secret-reference']),
    valueResolution: ValueResolutionSchema,
    valueResolutionDigest: z.string(),
    controlKind: z.string(),
  }),
  ManifestStepBaseSchema.extend({
    targetKind: z.literal('action'),
    screenId: z.string(),
    actionId: z.string(),
    actionLabel: z.string(),
    permittedActionIds: z.array(z.string()).min(1),
    expectedNextScreenId: z.string().optional(),
    expectedOperationIds: z.array(z.string()),
    edgeIds: z.array(z.string()),
  }),
]);

const GroundingManifestSchema = z.object({
  runId: z.string(),
  variantId: z.string(),
  witnessId: z.string(),
  environment: z.string(),
  sourceDigest: z.string(),
  runtimeConfigDigest: z.string(),
  dataReadinessDigest: z.string(),
  adapterManifestDigest: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  baseUrl: z.string().url(),
  rules: z.array(z.string()),
  steps: z.array(ManifestStepSchema).min(1),
  expectedSuccessScreenId: z.string(),
  manifestDigest: z.string(),
}).strict();

export type GroundingManifest = z.infer<typeof GroundingManifestSchema>;
export type GroundingManifestStep = z.infer<typeof ManifestStepSchema>;
export type RuntimeValueResolutionHandoff = z.infer<typeof ValueResolutionSchema>;

export interface RuntimeValueBinding {
  dataRequirementId: string;
  dataRequirementDigest: string;
  valueBindingDigest: string;
  valueAvailability: 'representative-value' | 'application-value' | 'secret-reference';
  valueResolution: RuntimeValueResolutionHandoff;
  valueResolutionDigest: string;
}

export interface PendingGroundingManifest {
  runId: string;
  path: string;
  observationPath: string;
  observationExists: boolean;
  manifestDigest: string;
  createdAt: string;
  expiresAt: string;
  stepCount: number;
}

export function assertConfiguredRuntimeEnvironment(store: ArtifactStore, environment: string): void {
  if (environment !== store.config.runtime.environment) {
    throw new FlowctlError(
      'INVALID_INPUT',
      EXIT_CODE.invalid,
      `Runtime environment ${environment} does not match configured runtime.environment ${store.config.runtime.environment}. `
      + 'This version supports one named runtime target per config file; select that name or use a separate config file for another target.',
    );
  }
}

export async function prepareGrounding(store: ArtifactStore, variantId: string, environment: string): Promise<{ runId: string; path: string }> {
  assertConfiguredRuntimeEnvironment(store, environment);
  const baseUrl = store.config.runtime.baseUrl;
  if (!baseUrl) throw new Error('Runtime grounding requires runtime.baseUrl in flowctl.config.yaml.');
  const adapters = await loadAdapterManifest(store);
  const [variants, witnesses, behavior, pages, actors] = await Promise.all([
    store.read<FlowVariants>('variants'),
    store.read<PathWitnesses>('witnesses'),
    store.read<BehaviorGraph>('behavior'),
    store.read<PageContracts>('pages'),
    store.read<ActorRequirements>('actors'),
  ]);
  const variant = variants.data.variants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`Unknown variant ${variantId}.`);
  if (variant.feasibility === 'conditional') {
    throw new Error(`Review required: conditional variant ${variantId} cannot enter runtime grounding until its unresolved guards are source-proven.`);
  }
  await assertArtifactLineage(store, [
    { name: 'variants', envelope: variants },
    { name: 'witnesses', envelope: witnesses },
    { name: 'behavior', envelope: behavior },
    { name: 'pages', envelope: pages },
    { name: 'actors', envelope: actors },
  ]);
  const witness = representativeWitness(variant, witnesses.data);
  const sourceDigest = await currentArtifactDigest(store, [variants, witnesses, behavior, pages, actors]);
  const requirements = await readVariantRequirements(store, variantId);
  const data = await verifyVariantData(store, variantId);
  if (!data.ready) {
    const blockers = [
      ...data.missing.map((item) => `${item.id} (missing)`),
      ...data.unverified.map((item) => `${item.id} (unverified)`),
    ];
    throw new Error(`Cannot prepare runtime grounding for ${variantId}: required application data is not verified: ${blockers.join(', ')}.`);
  }
  const valueBindings = await resolveRuntimeValueBindings(store, requirements);
  const steps = buildManifestSteps(variant, witness, behavior.data, pages.data, actors.data, requirements, valueBindings, adapters);
  const successStep = [...steps].reverse().find((step) => step.targetKind === 'screen-state' && step.screenStatePhase === 'success');
  if (!successStep || successStep.targetKind !== 'screen-state') {
    throw new Error(`Runtime grounding unavailable for witness ${witness.id}: it has no source-supported post-action screen. The source flow may still be valid, but operation-response/outcome runtime probes are not implemented.`);
  }
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 30 * 60 * 1000);
  const runId = stableId('grounding-run', `${variantId}:${environment}:${sourceDigest}:${witness.id}:${data.readinessDigest}:${createdAt.toISOString()}`);
  const content: Omit<GroundingManifest, 'manifestDigest'> = {
    runId,
    variantId,
    witnessId: witness.id,
    environment,
    sourceDigest,
    runtimeConfigDigest: store.config.runtimeConfigDigest,
    dataReadinessDigest: data.readinessDigest,
    adapterManifestDigest: adapters.digest,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    baseUrl,
    rules: [
      'Use the registered Playwright adapter for every actor-session, screen-state, field and action target in sequence.',
      `Before each interaction, revalidate this manifest with flowctl ground verify --run ${runId}.`,
      'Capture a fresh snapshot after session setup, navigation or rerender.',
      'Resolve actor identity and actor-attribute requirements by stable requirement ID through their actorDataResolutions handoffs.',
      'Resolve each field value through its valueResolution logical alias, approved strategy and lookup reference; verify the resolution digest and never guess a value.',
      'Do not copy raw secrets into the manifest or observation; resolve approved secret handles only inside the registered adapter runner.',
      'Do not persist snapshot-local references, force clicks, guess values or alter the business path.',
      'A recorded observation establishes an auditable locator contract; it is not independent proof that a later Playwright run passed.',
    ],
    steps,
    expectedSuccessScreenId: successStep.screenId,
  };
  const manifest: GroundingManifest = { ...content, manifestDigest: sha256(stableJson(content)) };
  const directory = path.join(store.workDirectory, 'runtime');
  const destination = safeChildPath(directory, `${safeFileSegment(runId, 'Run ID')}.manifest.json`);
  await store.writeManagedFile(destination, stableJson(manifest));
  return { runId, path: destination };
}

export async function recordGrounding(store: ArtifactStore, runId: string, observationFile: string): Promise<RuntimeBindings> {
  const observationPath = path.resolve(observationFile);
  const observationText = store.isManagedFilePath(observationPath)
    ? await store.readManagedFile(observationPath)
    : await fs.readFile(observationPath, 'utf8');
  const observation = ObservationSchema.parse(JSON.parse(observationText));
  if (observation.runId !== runId) throw new Error(`Observation runId ${observation.runId} does not match ${runId}.`);
  const { manifest, variants, witnesses, behavior, pages, actors } = await validateGroundingManifest(store, runId);
  if (observation.manifestDigest !== manifest.manifestDigest) throw new Error(`Observation manifest digest does not match grounding run ${runId}.`);
  if (observation.adapterManifestDigest !== manifest.adapterManifestDigest) throw new Error(`Observation adapter digest does not match grounding run ${runId}.`);
  if (observation.environment !== manifest.environment) {
    throw new Error(`Observation environment ${observation.environment} does not match manifest environment ${manifest.environment}.`);
  }
  if (observation.observations.length !== manifest.steps.length) {
    throw new Error(`Grounding observation is partial: expected ${manifest.steps.length} ordered observations, received ${observation.observations.length}.`);
  }
  let existing: RuntimeBindings = { bindings: [] };
  if (await store.exists('runtime')) {
    const runtime = await store.read<RuntimeBindings>('runtime');
    if (runtime.meta.status === 'grounded'
      && runtime.meta.sourceDigest === manifest.sourceDigest
      && runtime.meta.configDigest === store.config.configDigest
      && runtime.meta.inputDigests.behavior === behavior.meta.contentDigest
      && runtime.meta.inputDigests.witnesses === witnesses.meta.contentDigest
      && runtime.meta.inputDigests.variants === variants.meta.contentDigest
      && runtime.meta.inputDigests.pages === pages.meta.contentDigest
      && runtime.meta.inputDigests.actors === actors.meta.contentDigest) {
      existing = { bindings: runtime.data.bindings.filter((binding) => (
        binding.adapterManifestDigest === manifest.adapterManifestDigest
        && binding.runtimeConfigDigest === manifest.runtimeConfigDigest
        && binding.baseUrl === manifest.baseUrl
      )) };
    }
  }
  const additions: RuntimeBinding[] = observation.observations.map((item, index) => {
    const expected = manifest.steps[index]!;
    if (item.targetKind !== expected.targetKind) {
      throw new Error(`Observation ${index + 1} must ground ${expected.targetKind}; received ${item.targetKind}.`);
    }
    const targetId = runtimeTargetId(expected);
    if (!expected.permittedAdapterIds.includes(item.componentAdapter)) {
      throw new Error(`Observation ${index + 1} uses unregistered adapter ${item.componentAdapter}; permitted adapters are ${expected.permittedAdapterIds.join(', ')}.`);
    }
    const common = {
      id: stableId('runtime-binding', `${manifest.witnessId}:${expected.sequence}:${observation.environment}:${expected.targetKind}:${targetId}`),
      witnessId: manifest.witnessId,
      sequence: expected.sequence,
      groundingRunId: manifest.runId,
      groundingManifestDigest: manifest.manifestDigest,
      observationProducer: observation.producer,
      environment: observation.environment,
      runtimeConfigDigest: manifest.runtimeConfigDigest,
      baseUrl: manifest.baseUrl,
      componentAdapter: item.componentAdapter,
      adapterManifestDigest: manifest.adapterManifestDigest,
      evidenceRefs: [...new Set([...expected.sourceEvidenceRefs, ...item.evidenceRefs])],
    };

    if (expected.targetKind === 'actor-session') {
      if (item.targetKind !== 'actor-session'
        || stableJson(item.actorRequirementIds) !== stableJson(expected.actorRequirementIds)
        || item.actorRequirementsDigest !== expected.actorRequirementsDigest
        || stableJson(item.identityBindingDigests) !== stableJson(expected.identityBindingDigests)
        || stableJson(item.actorDataRequirementIds) !== stableJson(expected.actorDataRequirementIds)
        || stableJson(item.actorDataBindingDigests) !== stableJson(expected.actorDataBindingDigests)
        || stableJson(item.actorDataResolutionDigests) !== stableJson(expected.actorDataResolutionDigests)) {
        throw new Error(`Observation ${index + 1} does not establish the exact actor-session contract ${targetId}.`);
      }
      return {
        ...common,
        targetKind: 'actor-session' as const,
        actorRequirementIds: expected.actorRequirementIds,
        actorRequirementsDigest: expected.actorRequirementsDigest,
        identityBindingDigests: expected.identityBindingDigests,
        actorDataRequirementIds: expected.actorDataRequirementIds,
        actorDataBindingDigests: expected.actorDataBindingDigests,
        actorDataResolutionDigests: expected.actorDataResolutionDigests,
      };
    }

    if (expected.targetKind === 'screen-state') {
      if (item.targetKind !== 'screen-state' || item.screenId !== expected.screenId || item.screenStatePhase !== expected.screenStatePhase) {
        throw new Error(`Observation ${index + 1} must probe ${expected.screenStatePhase} screen ${expected.screenId}.`);
      }
      return {
        ...common,
        targetKind: 'screen-state' as const,
        screenId: expected.screenId,
        screenStatePhase: expected.screenStatePhase,
        locator: runtimeLocator(item.locator),
        unique: true,
        ...(item.observedUrl ? { observedUrl: item.observedUrl } : {}),
      };
    }

    if (expected.targetKind === 'field') {
      if (item.targetKind !== 'field' || item.screenId !== expected.screenId || item.fieldId !== expected.fieldId
        || item.dataRequirementId !== expected.dataRequirementId
        || item.dataRequirementDigest !== expected.dataRequirementDigest
        || item.valueBindingDigest !== expected.valueBindingDigest
        || item.valueResolutionDigest !== expected.valueResolutionDigest
        || item.valueAvailability !== expected.valueAvailability) {
        throw new Error(`Observation ${index + 1} must ground field ${expected.fieldId} with its exact requirement and value-binding digests.`);
      }
      return {
        ...common,
        targetKind: 'field' as const,
        screenId: expected.screenId,
        fieldId: expected.fieldId,
        dataRequirementId: expected.dataRequirementId,
        dataRequirementDigest: expected.dataRequirementDigest,
        valueBindingDigest: expected.valueBindingDigest,
        valueAvailability: expected.valueAvailability,
        valueResolutionDigest: expected.valueResolutionDigest,
        locator: runtimeLocator(item.locator),
        unique: true,
        actionable: true,
      };
    }

    if (item.targetKind !== 'action' || item.screenId !== expected.screenId || item.actionId !== expected.actionId) {
      throw new Error(`Observation ${index + 1} must ground ${expected.screenId} -> ${expected.actionId}.`);
    }
    if (expected.expectedNextScreenId && item.observedNextStateId !== expected.expectedNextScreenId) {
      throw new Error(`Observation ${index + 1} for ${item.actionId} must reach ${expected.expectedNextScreenId}; received ${item.observedNextStateId ?? 'no next state'}.`);
    }
    if (expected.expectedOperationIds.length) {
      if (!item.observedOperationId || !expected.expectedOperationIds.includes(item.observedOperationId)) {
        throw new Error(`Observation ${index + 1} for ${item.actionId} must observe one of [${expected.expectedOperationIds.join(', ')}]; received ${item.observedOperationId ?? 'no operation'}.`);
      }
    } else if (item.observedOperationId) {
      throw new Error(`Observation ${index + 1} for ${item.actionId} reported unexpected operation ${item.observedOperationId}.`);
    }
    return {
      ...common,
      targetKind: 'action' as const,
      screenId: expected.screenId,
      actionId: expected.actionId,
      locator: runtimeLocator(item.locator),
      unique: true,
      actionable: true,
      ...(item.observedOperationId ? { observedOperationId: item.observedOperationId } : {}),
      ...(item.observedNextStateId ? { observedNextStateId: item.observedNextStateId } : {}),
    };
  });
  const merged = { bindings: [...new Map([...existing.bindings, ...additions].map((binding) => [binding.id, binding])).values()] };
  const envelope = store.createEnvelope({
    artifactType: 'runtime-bindings',
    producer: 'runtime:record',
    sourceDigest: behavior.meta.sourceDigest,
    inputDigests: {
      behavior: behavior.meta.contentDigest,
      witnesses: witnesses.meta.contentDigest,
      variants: variants.meta.contentDigest,
      pages: pages.meta.contentDigest,
      actors: actors.meta.contentDigest,
    },
    data: merged,
    status: 'grounded',
  });
  await store.write('runtime', envelope);
  return merged;
}

export async function verifyGroundingManifest(store: ArtifactStore, runId: string): Promise<GroundingManifest> {
  return (await validateGroundingManifest(store, runId)).manifest;
}

export async function findPendingGroundingManifest(
  store: ArtifactStore,
  variantId: string,
  environment: string,
): Promise<PendingGroundingManifest | undefined> {
  assertConfiguredRuntimeEnvironment(store, environment);
  const directory = path.join(store.workDirectory, 'runtime');
  const names = (await store.listManagedDirectory(directory)).map((entry) => entry.name);
  const candidates: GroundingManifest[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.manifest.json'))) {
    try {
      const parsed = GroundingManifestSchema.safeParse(JSON.parse(await store.readManagedFile(safeChildPath(directory, name))));
      if (parsed.success && parsed.data.variantId === variantId && parsed.data.environment === environment) {
        candidates.push(parsed.data);
      }
    } catch {
      // An incomplete or unrelated work file is not a resumable grounding run.
    }
  }
  candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  for (const candidate of candidates) {
    try {
      const current = await verifyGroundingManifest(store, candidate.runId);
      const observationPath = safeChildPath(directory, `${safeFileSegment(current.runId, 'Run ID')}.observation.json`);
      const observationExists = await store.managedFileExists(observationPath);
      return {
        runId: current.runId,
        path: safeChildPath(directory, `${safeFileSegment(current.runId, 'Run ID')}.manifest.json`),
        observationPath,
        observationExists,
        manifestDigest: current.manifestDigest,
        createdAt: current.createdAt,
        expiresAt: current.expiresAt,
        stepCount: current.steps.length,
      };
    } catch {
      // Stale, expired or otherwise invalid manifests must not be resumed.
    }
  }
  return undefined;
}

async function validateGroundingManifest(store: ArtifactStore, runId: string): Promise<{
  manifest: GroundingManifest;
  variants: Awaited<ReturnType<ArtifactStore['read']>> & { data: FlowVariants };
  witnesses: Awaited<ReturnType<ArtifactStore['read']>> & { data: PathWitnesses };
  behavior: Awaited<ReturnType<ArtifactStore['read']>> & { data: BehaviorGraph };
  pages: Awaited<ReturnType<ArtifactStore['read']>> & { data: PageContracts };
  actors: Awaited<ReturnType<ArtifactStore['read']>> & { data: ActorRequirements };
}> {
  const manifestPath = safeChildPath(path.join(store.workDirectory, 'runtime'), `${safeFileSegment(runId, 'Run ID')}.manifest.json`);
  const manifest = GroundingManifestSchema.parse(JSON.parse(await store.readManagedFile(manifestPath)));
  if (manifest.runId !== runId) throw new Error(`Grounding manifest runId ${manifest.runId} does not match ${runId}.`);
  const { manifestDigest, ...content } = manifest;
  if (manifestDigest !== sha256(stableJson(content))) throw new Error(`Grounding manifest ${runId} content digest does not match.`);
  if (manifest.environment !== store.config.runtime.environment) {
    throw new Error(`Grounding manifest ${runId} targets ${manifest.environment}, not configured runtime.environment ${store.config.runtime.environment}.`);
  }
  if (manifest.runtimeConfigDigest !== store.config.runtimeConfigDigest || manifest.baseUrl !== store.config.runtime.baseUrl) {
    throw new Error(`Grounding manifest ${runId} is stale because runtime configuration changed.`);
  }
  const adapters = await loadAdapterManifest(store);
  if (adapters.digest !== manifest.adapterManifestDigest) {
    throw new Error(`Grounding manifest ${runId} is stale because the runtime adapter manifest or implementation changed.`);
  }
  if (Date.parse(manifest.expiresAt) <= Date.now()) throw new Error(`Grounding manifest ${runId} has expired; prepare a fresh run.`);
  const [variants, witnesses, behavior, pages, actors] = await Promise.all([
    store.read<FlowVariants>('variants'),
    store.read<PathWitnesses>('witnesses'),
    store.read<BehaviorGraph>('behavior'),
    store.read<PageContracts>('pages'),
    store.read<ActorRequirements>('actors'),
  ]);
  await assertArtifactLineage(store, [
    { name: 'variants', envelope: variants },
    { name: 'witnesses', envelope: witnesses },
    { name: 'behavior', envelope: behavior },
    { name: 'pages', envelope: pages },
    { name: 'actors', envelope: actors },
  ]);
  const currentDigest = await currentArtifactDigest(store, [variants, witnesses, behavior, pages, actors]);
  if (currentDigest !== manifest.sourceDigest) {
    throw new Error(`Grounding manifest source digest ${manifest.sourceDigest} is stale; current source digest is ${currentDigest}.`);
  }
  const variant = variants.data.variants.find((candidate) => candidate.id === manifest.variantId);
  if (!variant) throw new Error(`Grounding manifest references unknown variant ${manifest.variantId}.`);
  if (variant.feasibility === 'conditional') throw new Error(`Review required: grounding manifest ${runId} targets a conditional variant.`);
  const witness = witnesses.data.witnesses.find((candidate) => candidate.id === manifest.witnessId);
  if (!witness || !variant.witnessIds.includes(witness.id)) {
    throw new Error(`Grounding manifest witness ${manifest.witnessId} is not valid for variant ${variant.id}.`);
  }
  const data = await verifyVariantData(store, variant.id);
  if (!data.ready || data.readinessDigest !== manifest.dataReadinessDigest) {
    throw new Error(`Grounding manifest ${runId} is stale because confirmed application data changed.`);
  }
  const requirements = await readVariantRequirements(store, variant.id);
  const valueBindings = await resolveRuntimeValueBindings(store, requirements);
  const currentSteps = buildManifestSteps(variant, witness, behavior.data, pages.data, actors.data, requirements, valueBindings, adapters);
  if (stableJson(currentSteps) !== stableJson(manifest.steps)) {
    throw new Error(`Grounding manifest ${runId} no longer matches the current witness path.`);
  }
  return { manifest, variants, witnesses, behavior, pages, actors };
}

function representativeWitness(variant: FlowVariant, witnesses: PathWitnesses): PathWitness {
  const witness = witnesses.witnesses.find((candidate) => candidate.id === variant.witnessIds[0]);
  if (!witness) throw new Error(`Variant ${variant.id} has no readable path witness.`);
  return witness;
}

export async function resolveRuntimeValueBindings(
  store: ArtifactStore,
  requirements: DataRequirement[],
): Promise<Map<string, RuntimeValueBinding>> {
  const applicationBindings = await readApplicationBindings(store);
  return new Map(requirements.map((requirement) => {
    const dataRequirementDigest = sha256(stableJson(requirement));
    if (['flow-literal', 'synthetic-constrained', 'derived', 'runtime-option'].includes(requirement.classification)
      && requirement.status === 'generated'
      && requirement.representativeValue !== undefined) {
      const valueResolution: RuntimeValueBinding['valueResolution'] = {
        source: 'canonical-representative',
        requirementId: requirement.id,
        logicalAlias: `source-derived:${requirement.id}`,
        strategy: requirement.resolutionStrategies[0] ?? 'path-assignment',
        lookupFile: portableProjectPath(store, safeChildPath(store.dataRequirementsDirectory, `${safeFileSegment(requirement.variantId, 'Variant ID')}.yaml`)),
        lookupKey: requirement.id,
      };
      const binding: RuntimeValueBinding = {
        dataRequirementId: requirement.id,
        dataRequirementDigest,
        valueAvailability: 'representative-value',
        valueResolution,
        valueResolutionDigest: sha256(stableJson(valueResolution)),
        valueBindingDigest: sha256(stableJson({
          dataRequirementDigest,
          valueResolution,
          representativeValueDigest: sha256(stableJson(requirement.representativeValue)),
        })),
      };
      return [requirement.id, binding];
    }
    const configured = applicationBindings.bindings[requirement.id];
    const requiresSecretReference = requirement.classification === 'secret-reference'
      || requirement.classification === 'authenticated-identity';
    const invalidModality = requiresSecretReference
      ? !configured?.secretRef || configured.value !== undefined
      : configured?.value === undefined || Boolean(configured.secretRef);
    if (!configured?.verified || !configured.confirmation
      || configured.requirementDigest !== dataRequirementDigest
      || !requirement.resolutionStrategies.includes(configured.resolver)
      || invalidModality) {
      throw new Error(`Data requirement ${requirement.id} has no confirmed value binding in ${portableProjectPath(store, store.applicationDataFile)}.`);
    }
    const valueAvailability = configured.secretRef ? 'secret-reference' : 'application-value';
    const valueResolution: RuntimeValueBinding['valueResolution'] = {
      source: 'application-data',
      requirementId: requirement.id,
      logicalAlias: configured.alias,
      strategy: configured.resolver,
      lookupFile: portableProjectPath(store, store.applicationDataFile),
      lookupKey: requirement.id,
      ...(configured.secretRef ? { secretHandle: configured.secretRef } : {}),
    };
    const binding: RuntimeValueBinding = {
      dataRequirementId: requirement.id,
      dataRequirementDigest,
      valueAvailability,
      valueResolution,
      valueResolutionDigest: sha256(stableJson(valueResolution)),
      valueBindingDigest: sha256(stableJson({ dataRequirementDigest, valueResolution, binding: configured })),
    };
    return [requirement.id, binding];
  }));
}

export function buildManifestSteps(
  variant: FlowVariant,
  witness: PathWitness,
  behavior: BehaviorGraph,
  pages: PageContracts,
  actors: ActorRequirements,
  requirements: DataRequirement[],
  valueBindings: Map<string, RuntimeValueBinding>,
  adapters: LoadedAdapterManifest,
): GroundingManifestStep[] {
  const derived = deriveActionSteps(witness, behavior);
  if (derived.length !== variant.actionSequence.length || derived.some((step, index) => step.actionId !== variant.actionSequence[index])) {
    throw new Error(`Variant ${variant.id} action sequence does not match witness ${witness.id}.`);
  }
  const nodeById = new Map(behavior.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(behavior.edges.map((edge) => [edge.id, edge]));
  const actorContracts = variant.actorRequirementIds.map((id) => {
    const actor = actors.actors.find((candidate) => candidate.id === id);
    if (!actor) throw new Error(`Variant ${variant.id} references missing actor requirement ${id}.`);
    return actor;
  });
  const authenticatedActors = actorContracts.filter((actor) => actor.authentication === 'required');
  if (authenticatedActors.length > 1) {
    throw new Error(`Runtime grounding unavailable for witness ${witness.id}: it requires ${authenticatedActors.length} authenticated actor contracts, but actor switching is not ordered on the witness. The source flow may still be valid; multi-actor session scheduling is not implemented.`);
  }
  const unscopedActorData = requirements.filter((requirement) => (
    (requirement.classification === 'authenticated-identity' || requirement.classification === 'actor-attribute')
    && !requirement.actorRequirementId
  ));
  if (unscopedActorData.length) {
    throw new Error(`Actor-session grounding requires actorRequirementId on actor data requirement(s): ${unscopedActorData.map((requirement) => requirement.id).join(', ')}.`);
  }
  const identityRequirements = authenticatedActors.map((actor) => {
    const matches = requirements.filter((requirement) => (
      requirement.classification === 'authenticated-identity' && requirement.actorRequirementId === actor.id
    ));
    if (matches.length !== 1) {
      throw new Error(`Authenticated actor ${actor.id} requires exactly one occurrence-specific identity data requirement; found ${matches.length}.`);
    }
    return matches[0]!;
  });
  const authenticatedActorIds = new Set(authenticatedActors.map((actor) => actor.id));
  const actorDataRequirements = requirements
    .filter((requirement) => (
      (requirement.classification === 'authenticated-identity' || requirement.classification === 'actor-attribute')
      && requirement.actorRequirementId
      && authenticatedActorIds.has(requirement.actorRequirementId)
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
  const results: GroundingManifestStep[] = [];
  let sequence = 0;
  if (authenticatedActors.length) {
    const identityBindingDigests = Object.fromEntries(identityRequirements.sort((left, right) => left.id.localeCompare(right.id)).map((requirement) => {
      const value = valueBindings.get(requirement.id);
      if (!value) throw new Error(`Authenticated actor requirement ${requirement.id} has no runtime value binding.`);
      return [requirement.id, value.valueBindingDigest];
    }));
    const actorDataBindings = actorDataRequirements.map((requirement) => {
      const value = valueBindings.get(requirement.id);
      if (!value) throw new Error(`Actor data requirement ${requirement.id} has no runtime value binding.`);
      return [requirement.id, value] as const;
    });
    const actorDataBindingDigests = Object.fromEntries(actorDataBindings.map(([id, value]) => [id, value.valueBindingDigest]));
    const actorDataResolutions = Object.fromEntries(actorDataBindings.map(([id, value]) => [id, value.valueResolution]));
    const actorDataResolutionDigests = Object.fromEntries(actorDataBindings.map(([id, value]) => [id, value.valueResolutionDigest]));
    sequence += 1;
    results.push({
      targetKind: 'actor-session',
      sequence,
      actorRequirementIds: authenticatedActors.map((actor) => actor.id).sort(),
      actorRequirementsDigest: sha256(stableJson(authenticatedActors.sort((left, right) => left.id.localeCompare(right.id)))),
      identityBindingDigests,
      actorDataRequirementIds: actorDataRequirements.map((requirement) => requirement.id),
      actorDataBindingDigests,
      actorDataResolutions,
      actorDataResolutionDigests,
      permittedAdapterIds: requirePermittedAdapters(adapters, 'actor-session', undefined, 'authenticated actor session'),
      sourceEvidenceRefs: [...new Set(authenticatedActors
        .flatMap((actor) => [actor.id, ...actor.evidenceRefs])
        .concat(actorDataRequirements.flatMap((requirement) => [requirement.id, ...requirement.evidenceRefs])))],
    });
  }

  const screenIndexes = witness.nodePath.flatMap((nodeId, index) => nodeById.get(nodeId)?.kind === 'screen-state' ? [index] : []);
  const actionIndexes = witness.nodePath.flatMap((nodeId, index) => nodeById.get(nodeId)?.kind === 'action' ? [index] : []);
  const lastActionIndex = actionIndexes.at(-1) ?? -1;
  const successScreenIndex = [...screenIndexes].reverse().find((index) => {
    if (index <= lastActionIndex) return false;
    const screenId = witness.nodePath[index]!;
    const incomingEdge = index > 0 ? edgeById.get(witness.edgePath[index - 1]!) : undefined;
    return behavior.successNodeIds.includes(screenId) || incomingEdge?.outcome === 'success';
  });
  if (successScreenIndex === undefined) {
    throw new Error(`Runtime grounding unavailable for witness ${witness.id}: it has no source-supported screen-state after its final action. The source flow may still be valid, but operation-response/outcome runtime probes are not implemented.`);
  }
  let actionOccurrence = 0;
  let currentScreenId: string | undefined;
  const visitedFieldTargets = new Set<string>();
  for (let pathIndex = 0; pathIndex < witness.nodePath.length; pathIndex += 1) {
    const node = nodeById.get(witness.nodePath[pathIndex]!);
    if (!node) throw new Error(`Witness ${witness.id} references missing behavior node ${witness.nodePath[pathIndex]}.`);
    if (node.kind === 'screen-state') {
      currentScreenId = node.id;
      const page = pages.pages.find((candidate) => candidate.id === node.id);
      if (!page) throw new Error(`Witness ${witness.id} references missing page contract ${node.id}.`);
      const screenStatePhase = pathIndex === screenIndexes[0]
        ? 'entry'
        : pathIndex === successScreenIndex ? 'success' : 'intermediate';
      sequence += 1;
      results.push({
        targetKind: 'screen-state',
        sequence,
        screenId: node.id,
        screenStatePhase,
        routePatterns: page.routePatterns,
        permittedAdapterIds: requirePermittedAdapters(adapters, 'screen-state', undefined, node.id),
        sourceEvidenceRefs: [...new Set([node.id, ...(node.referenceId ? [node.referenceId] : []), ...page.evidenceRefs])],
      });
      // A screen reached after the final journey action is an outcome probe.
      // Its controls are not journey inputs and must never create fill targets.
      if (pathIndex > lastActionIndex) continue;
      const visibleFields = page.fields.filter((candidate) => (
        solvePredicate(allPredicates([witness.pathCondition, ...candidate.visibleWhen])).status !== 'unsatisfiable'
      ));
      const conditionalInput = visibleFields.find((field) => field.inputMode === 'conditional');
      if (conditionalInput) {
        throw new Error(`Runtime grounding requires review for ${page.id}/${conditionalInput.id}: its input mode is conditional, so Flowctl cannot prove that the runner may write it.`);
      }
      for (const field of visibleFields.filter((candidate) => (candidate.inputMode ?? 'editable') === 'editable')) {
        const fieldTarget = `${page.id}/${field.id}`;
        if (visitedFieldTargets.has(fieldTarget)) {
          throw new Error(`Runtime grounding unavailable for witness ${witness.id}: active field ${fieldTarget} occurs on more than one screen visit, but data requirements are not visit-specific. The source flow may still be valid; visit-specific value contracts are not implemented.`);
        }
        visitedFieldTargets.add(fieldTarget);
        const requirement = requirementForField(requirements, page.id, field.id);
        if (!requirement || !variant.dataRequirementIds.includes(requirement.id)) {
          throw new Error(`Active field ${page.id}/${field.id} has no occurrence-specific data requirement for variant ${variant.id}.`);
        }
        const valueBinding = valueBindings.get(requirement.id);
        if (!valueBinding) throw new Error(`Active field ${page.id}/${field.id} has no available runtime value binding.`);
        sequence += 1;
        results.push({
          targetKind: 'field',
          sequence,
          screenId: node.id,
          fieldId: field.id,
          fieldPath: field.dataPath,
          dataRequirementId: requirement.id,
          dataRequirementDigest: valueBinding.dataRequirementDigest,
          valueBindingDigest: valueBinding.valueBindingDigest,
          valueAvailability: valueBinding.valueAvailability,
          valueResolution: valueBinding.valueResolution,
          valueResolutionDigest: valueBinding.valueResolutionDigest,
          controlKind: field.controlKind,
          permittedAdapterIds: requirePermittedAdapters(adapters, 'field', field.controlKind, field.id),
          sourceEvidenceRefs: [...new Set([field.id, requirement.id, ...field.constraints.map((constraint) => constraint.id), ...requirement.evidenceRefs])],
        });
      }
      continue;
    }
    if (node.kind !== 'action') continue;
    const step = derived[actionOccurrence];
    actionOccurrence += 1;
    if (!step || step.actionId !== node.id || !currentScreenId || step.screenId !== currentScreenId) {
      throw new Error(`Action occurrence ${node.id} in witness ${witness.id} is not bound to its exact preceding screen.`);
    }
    sequence += 1;
    results.push({
      targetKind: 'action',
      sequence,
      screenId: currentScreenId,
      actionId: step.actionId,
      actionLabel: step.actionLabel,
      permittedAdapterIds: requirePermittedAdapters(adapters, 'action', undefined, step.actionId),
      permittedActionIds: [step.actionId],
      ...(step.nextScreenId ? { expectedNextScreenId: step.nextScreenId } : {}),
      expectedOperationIds: step.operationIds,
      edgeIds: step.edgeIds,
      sourceEvidenceRefs: [...new Set([
        step.actionId,
        ...(node.referenceId ? [node.referenceId] : []),
        ...step.edgeIds.flatMap((edgeId) => edgeById.get(edgeId)?.evidenceRefs ?? []),
      ])],
    });
  }
  return results;
}

export function bindingMatchesStep(
  binding: RuntimeBinding,
  step: GroundingManifestStep,
  witnessId: string,
  adapterManifestDigest: string,
  runtimeConfigDigest: string,
  baseUrl: string,
): boolean {
  if (binding.witnessId !== witnessId || binding.sequence !== step.sequence || binding.targetKind !== step.targetKind) return false;
  if (binding.observationProducer !== 'flowctl-playwright-adapter-runner'
    || !binding.groundingRunId || !binding.groundingManifestDigest) return false;
  if (binding.runtimeConfigDigest !== runtimeConfigDigest || binding.baseUrl !== baseUrl) return false;
  if (!step.permittedAdapterIds.includes(binding.componentAdapter) || binding.adapterManifestDigest !== adapterManifestDigest) return false;
  if (step.targetKind === 'actor-session') {
    return stableJson(binding.actorRequirementIds) === stableJson(step.actorRequirementIds)
      && binding.actorRequirementsDigest === step.actorRequirementsDigest
      && stableJson(binding.identityBindingDigests) === stableJson(step.identityBindingDigests)
      && stableJson(binding.actorDataRequirementIds) === stableJson(step.actorDataRequirementIds)
      && stableJson(binding.actorDataBindingDigests) === stableJson(step.actorDataBindingDigests)
      && stableJson(binding.actorDataResolutionDigests) === stableJson(step.actorDataResolutionDigests);
  }
  if (step.targetKind === 'screen-state') {
    return binding.screenId === step.screenId && binding.screenStatePhase === step.screenStatePhase;
  }
  if (step.targetKind === 'field') {
    return binding.screenId === step.screenId && binding.fieldId === step.fieldId
      && binding.dataRequirementId === step.dataRequirementId
      && binding.dataRequirementDigest === step.dataRequirementDigest
      && binding.valueBindingDigest === step.valueBindingDigest
      && binding.valueResolutionDigest === step.valueResolutionDigest
      && binding.valueAvailability === step.valueAvailability;
  }
  if (binding.screenId !== step.screenId || binding.actionId !== step.actionId) return false;
  if (step.expectedNextScreenId && binding.observedNextStateId !== step.expectedNextScreenId) return false;
  if (step.expectedOperationIds.length && (!binding.observedOperationId || !step.expectedOperationIds.includes(binding.observedOperationId))) return false;
  return true;
}

export function runtimeTargetId(step: GroundingManifestStep): string {
  if (step.targetKind === 'actor-session') return `actor-session:${step.actorRequirementIds.join('+')}`;
  if (step.targetKind === 'screen-state') return `screen-state:${step.screenStatePhase}:${step.screenId}`;
  if (step.targetKind === 'field') return `field:${step.screenId}:${step.fieldId}`;
  return `action:${step.screenId}:${step.actionId}`;
}

function requirementForField(requirements: DataRequirement[], pageId: string, fieldId: string): DataRequirement | undefined {
  const occurrenceMatches = requirements.filter((requirement) => (
    requirement.pageId === pageId && requirement.fieldId === fieldId
  ));
  if (occurrenceMatches.length > 1) throw new Error(`Multiple data requirements target field occurrence ${pageId}/${fieldId}.`);
  return occurrenceMatches[0];
}

function runtimeLocator(locator: z.infer<typeof LocatorSchema>): NonNullable<RuntimeBinding['locator']> {
  return {
    strategy: locator.strategy,
    ...(locator.role ? { role: locator.role } : {}),
    ...(locator.name ? { name: locator.name } : {}),
    ...(locator.value ? { value: locator.value } : {}),
  };
}

function portableProjectPath(store: ArtifactStore, value: string): string {
  const relative = path.relative(store.config.projectRoot, value);
  return relative.startsWith('..') ? value : relative || '.';
}

function requirePermittedAdapters(
  adapters: LoadedAdapterManifest,
  targetKind: RuntimeTargetKind,
  controlKind: string | undefined,
  targetId: string,
): string[] {
  const ids = permittedAdapterIds(adapters, targetKind, controlKind);
  if (!ids.length) {
    throw new Error(`Runtime adapter manifest has no ${targetKind} adapter for ${targetId}${controlKind ? ` (${controlKind})` : ''}.`);
  }
  return ids;
}

async function currentArtifactDigest(
  store: ArtifactStore,
  artifacts: Array<{ meta: { artifactType: string; sourceDigest: string; configDigest: string; status: string } }>,
): Promise<string> {
  const unique = [...new Set(artifacts.map((artifact) => artifact.meta.sourceDigest))];
  if (unique.length !== 1) throw new Error(`Runtime grounding artifacts are stale or inconsistent: ${unique.join(', ')}.`);
  const sourceDigest = unique[0]!;
  const currentSourceDigest = (await snapshotSources(store.config)).digest;
  const stale = artifacts.find((artifact) => (
    artifact.meta.status === 'stale'
    || artifact.meta.configDigest !== store.config.configDigest
    || artifact.meta.sourceDigest !== currentSourceDigest
  ));
  if (stale) throw new Error(`${stale.meta.artifactType} is stale; rerun flowctl analyze before runtime grounding.`);
  return sourceDigest;
}
