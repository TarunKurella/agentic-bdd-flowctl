import path from 'node:path';
import { snapshotSources } from '../adapters/source.js';
import type { ArtifactStore } from '../core/artifact-store.js';
import { assertArtifactLineage } from '../core/freshness.js';
import { safeChildPath } from '../core/paths.js';
import { sha256, stableId, stableJson } from '../core/stable.js';
import { readVariantRequirements, verifyVariantData } from '../data/bindings.js';
import {
  assertConfiguredRuntimeEnvironment,
  bindingMatchesStep,
  buildManifestSteps,
  resolveRuntimeValueBindings,
  runtimeTargetId,
  type RuntimeValueResolutionHandoff,
} from './grounding.js';
import { loadAdapterManifest, type RuntimeTargetKind } from './adapters.js';
import type { ActorRequirements, BehaviorGraph, FlowVariants, PageContracts, PathWitnesses, RuntimeBindings } from '../ir/model.js';

export interface ExecutionPlan {
  planId: string;
  planDigest: string;
  variantId: string;
  witnessId: string;
  environment: string;
  sourceDigest: string;
  runtimeConfigDigest: string;
  dataReadinessDigest: string;
  runtimeBindingsDigest: string;
  variantArtifactDigest: string;
  witnessArtifactDigest: string;
  behaviorArtifactDigest: string;
  pageArtifactDigest: string;
  actorArtifactDigest: string;
  adapterManifestDigest: string;
  runtimeRunnerReady: boolean;
  generatedAt: string;
  readiness: 'blocked-data' | 'blocked-runtime' | 'ready-for-playwright-run';
  representativeAssignments: Record<string, string | number | boolean | null>;
  data: Awaited<ReturnType<typeof verifyVariantData>>;
  missingActorSessionBindings: string[];
  missingScreenStateBindings: string[];
  missingActionBindings: string[];
  missingFieldBindings: string[];
  missingRuntimeTargets: string[];
  steps: Array<{
    targetKind: RuntimeTargetKind;
    sequence: number;
    permittedAdapterIds: string[];
    sourceEvidenceRefs: string[];
    pageId?: string;
    screenStatePhase?: 'entry' | 'intermediate' | 'success';
    routePatterns?: string[];
    actorRequirementIds?: string[];
    actorRequirementsDigest?: string;
    identityBindingDigests?: Record<string, string>;
    actorDataRequirementIds?: string[];
    actorDataBindingDigests?: Record<string, string>;
    actorDataResolutions?: Record<string, RuntimeValueResolutionHandoff>;
    actorDataResolutionDigests?: Record<string, string>;
    actionId?: string;
    actionLabel?: string;
    fieldId?: string;
    fieldPath?: string;
    controlKind?: string;
    dataRequirementId?: string;
    dataRequirementDigest?: string;
    valueBindingDigest?: string;
    valueAvailability?: 'representative-value' | 'application-value' | 'secret-reference';
    valueResolution?: RuntimeValueResolutionHandoff;
    valueResolutionDigest?: string;
    runtimeBindingId?: string;
    runtimeAdapterId?: string;
    expectedNextPageId?: string;
    expectedOperationIds?: string[];
  }>;
  rules: string[];
}

export async function compileExecutionPlan(store: ArtifactStore, variantId: string, environment: string): Promise<{ plan: ExecutionPlan; path: string }> {
  assertConfiguredRuntimeEnvironment(store, environment);
  const baseUrl = store.config.runtime.baseUrl;
  if (!baseUrl) throw new Error('Execution planning requires runtime.baseUrl in flowctl.config.yaml.');
  const [variants, witnesses, behavior, pages, actors, runtime] = await Promise.all([
    store.read<FlowVariants>('variants'),
    store.read<PathWitnesses>('witnesses'),
    store.read<BehaviorGraph>('behavior'),
    store.read<PageContracts>('pages'),
    store.read<ActorRequirements>('actors'),
    store.read<RuntimeBindings>('runtime'),
  ]);
  const variant = variants.data.variants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`Unknown variant ${variantId}.`);
  if (variant.feasibility === 'conditional') {
    throw new Error(`Review required: conditional variant ${variantId} cannot compile to a Playwright run plan.`);
  }
  await assertArtifactLineage(store, [
    { name: 'variants', envelope: variants },
    { name: 'witnesses', envelope: witnesses },
    { name: 'behavior', envelope: behavior },
    { name: 'pages', envelope: pages },
    { name: 'actors', envelope: actors },
    { name: 'runtime', envelope: runtime },
  ]);
  const currentSourceDigest = (await snapshotSources(store.config)).digest;
  const inputs = [variants, witnesses, behavior, pages, actors];
  const stale = inputs.find((artifact) => (
    artifact.meta.status === 'stale'
    || artifact.meta.sourceDigest !== currentSourceDigest
    || artifact.meta.configDigest !== store.config.configDigest
  ));
  if (stale) throw new Error(`${stale.meta.artifactType} is stale; rerun flowctl analyze before compiling a Playwright run plan.`);
  const witness = witnesses.data.witnesses.find((candidate) => candidate.id === variant.witnessIds[0]);
  if (!witness) throw new Error(`Variant ${variantId} has no readable path witness.`);
  const requirements = await readVariantRequirements(store, variantId);
  const adapters = await loadAdapterManifest(store);
  const data = await verifyVariantData(store, variantId);
  const interactionSteps = data.ready
    ? buildManifestSteps(
      variant,
      witness,
      behavior.data,
      pages.data,
      actors.data,
      requirements,
      await resolveRuntimeValueBindings(store, requirements),
      adapters,
    )
    : [];
  const bindings = runtime.meta.status === 'grounded'
    && runtime.meta.sourceDigest === behavior.meta.sourceDigest
    && runtime.meta.configDigest === store.config.configDigest
    ? runtime.data.bindings.filter((binding) => (
      binding.environment === environment
      && binding.runtimeConfigDigest === store.config.runtimeConfigDigest
      && binding.baseUrl === baseUrl
      && bindingIsUsable(binding)
    ))
    : [];
  const resolvedSteps = interactionSteps.map((step) => ({
    step,
    binding: bindings.find((binding) => bindingMatchesStep(
      binding,
      step,
      witness.id,
      adapters.digest,
      store.config.runtimeConfigDigest,
      baseUrl,
    )),
  }));
  const missingByKind = (kind: RuntimeTargetKind): string[] => resolvedSteps
    .filter(({ step, binding }) => step.targetKind === kind && !binding)
    .map(({ step }) => runtimeTargetId(step));
  const missingActorSessionBindings = data.ready ? missingByKind('actor-session') : variant.actorRequirementIds
    .filter((id) => actors.data.actors.some((actor) => actor.id === id && actor.authentication === 'required'))
    .map((id) => `actor-session:${id}`);
  const missingScreenStateBindings = data.ready ? missingByKind('screen-state') : witness.pageSequence.map((id) => `screen-state:${id}`);
  const missingActionBindings = data.ready ? missingByKind('action') : variant.actionSequence.map((id) => `action:${id}`);
  const missingFieldBindings = data.ready ? missingByKind('field') : requirements
    .filter((requirement) => requirement.fieldId && requirement.pageId)
    .map((requirement) => `field:${requirement.pageId}:${requirement.fieldId}`);
  const missingRuntimeTargets = [
    ...(!store.config.runtime.runner ? ['runner:external-playwright'] : []),
    ...missingActorSessionBindings,
    ...missingScreenStateBindings,
    ...missingFieldBindings,
    ...missingActionBindings,
  ];
  const steps = resolvedSteps.map(({ step, binding }) => ({
    targetKind: step.targetKind,
    sequence: step.sequence,
    permittedAdapterIds: step.permittedAdapterIds,
    sourceEvidenceRefs: step.sourceEvidenceRefs,
    ...(step.targetKind === 'actor-session' ? {
      actorRequirementIds: step.actorRequirementIds,
      actorRequirementsDigest: step.actorRequirementsDigest,
      identityBindingDigests: step.identityBindingDigests,
      actorDataRequirementIds: step.actorDataRequirementIds,
      actorDataBindingDigests: step.actorDataBindingDigests,
      actorDataResolutions: step.actorDataResolutions,
      actorDataResolutionDigests: step.actorDataResolutionDigests,
    } : {}),
    ...(step.targetKind === 'screen-state' ? {
      pageId: step.screenId,
      screenStatePhase: step.screenStatePhase,
      routePatterns: step.routePatterns,
    } : {}),
    ...(step.targetKind === 'action' ? {
      pageId: step.screenId,
      actionId: step.actionId,
      actionLabel: step.actionLabel,
      ...(step.expectedNextScreenId ? { expectedNextPageId: step.expectedNextScreenId } : {}),
      ...(step.expectedOperationIds.length ? { expectedOperationIds: step.expectedOperationIds } : {}),
    } : {}),
    ...(step.targetKind === 'field' ? {
      pageId: step.screenId,
      fieldId: step.fieldId,
      fieldPath: step.fieldPath,
      controlKind: step.controlKind,
      dataRequirementId: step.dataRequirementId,
      dataRequirementDigest: step.dataRequirementDigest,
      valueBindingDigest: step.valueBindingDigest,
      valueAvailability: step.valueAvailability,
      valueResolution: step.valueResolution,
      valueResolutionDigest: step.valueResolutionDigest,
    } : {}),
    ...(binding ? { runtimeBindingId: binding.id, runtimeAdapterId: binding.componentAdapter } : {}),
  }));
  const readiness: ExecutionPlan['readiness'] = !data.ready
    ? 'blocked-data'
    : missingRuntimeTargets.length ? 'blocked-runtime' : 'ready-for-playwright-run';
  const generatedAt = new Date().toISOString();
  const lineage = {
    variantId,
    witnessId: witness.id,
    environment,
    sourceDigest: currentSourceDigest,
    runtimeConfigDigest: store.config.runtimeConfigDigest,
    dataReadinessDigest: data.readinessDigest,
    runtimeBindingsDigest: runtime.meta.contentDigest,
    variantArtifactDigest: variants.meta.contentDigest,
    witnessArtifactDigest: witnesses.meta.contentDigest,
    behaviorArtifactDigest: behavior.meta.contentDigest,
    pageArtifactDigest: pages.meta.contentDigest,
    actorArtifactDigest: actors.meta.contentDigest,
    adapterManifestDigest: adapters.digest,
    runtimeRunnerReady: Boolean(store.config.runtime.runner),
  };
  const content: Omit<ExecutionPlan, 'planDigest'> = {
    planId: stableId('execution-plan', stableJson(lineage)),
    ...lineage,
    generatedAt,
    readiness,
    representativeAssignments: witness.assignments,
    data,
    missingActorSessionBindings,
    missingScreenStateBindings,
    missingActionBindings,
    missingFieldBindings,
    missingRuntimeTargets,
    steps,
    rules: [
      'Run Playwright only when readiness is ready-for-playwright-run.',
      'Before the run, recompile this plan and require the same planId and readiness.',
      'Use every registered actor-session, screen-state, field and action adapter occurrence in sequence.',
      'Resolve actor identity/attribute and editable-field values only through each exact stable requirement ID, logical alias, approved strategy, lookup reference and digest in this plan; never guess a value.',
      'Keep resolved values in runner memory only; never write raw values or secrets to plans, manifests or observations.',
      'Do not replace missing data with guessed identifiers or bypass actionability with forced clicks.',
      'This plan is authorization to start an auditable Playwright run; it is not evidence that the run happened or passed.',
    ],
  };
  const plan: ExecutionPlan = { ...content, planDigest: sha256(stableJson(content)) };
  const directory = path.join(store.workDirectory, 'runtime');
  const destination = safeChildPath(directory, `${plan.planId}.execution.json`);
  await store.writeManagedFile(destination, stableJson(plan));
  return { plan, path: destination };
}

function bindingIsUsable(binding: RuntimeBindings['bindings'][number]): boolean {
  if (binding.targetKind === 'actor-session') return true;
  if (binding.targetKind === 'screen-state') return binding.unique === true;
  return binding.unique === true && binding.actionable === true;
}
