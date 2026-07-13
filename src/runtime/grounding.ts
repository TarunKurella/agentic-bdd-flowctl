import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ArtifactStore } from '../core/artifact-store.js';
import { stableId, stableJson } from '../core/stable.js';
import type { BehaviorGraph, FlowVariants, RuntimeBinding, RuntimeBindings } from '../ir/model.js';

const ObservationSchema = z.object({
  runId: z.string(),
  environment: z.string(),
  observations: z.array(z.object({
    actionId: z.string(),
    screenId: z.string(),
    locator: z.object({
      strategy: z.enum(['role-and-name', 'label', 'test-id', 'scoped-text', 'reviewed-css']),
      role: z.string().optional(),
      name: z.string().optional(),
      value: z.string().optional(),
    }),
    componentAdapter: z.string(),
    unique: z.boolean(),
    actionable: z.boolean(),
    observedOperationId: z.string().optional(),
    observedNextStateId: z.string().optional(),
    evidenceRefs: z.array(z.string()).default([]),
  })),
});

export async function prepareGrounding(store: ArtifactStore, variantId: string, environment: string): Promise<{ runId: string; path: string }> {
  const variants = await store.read<FlowVariants>('variants');
  const behavior = await store.read<BehaviorGraph>('behavior');
  const variant = variants.data.variants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`Unknown variant ${variantId}.`);
  const runId = stableId('grounding-run', `${variantId}:${environment}`);
  const steps = variant.actionSequence.map((actionId, index) => {
    const action = behavior.data.nodes.find((node) => node.id === actionId);
    const screenId = variant.pageSequence[Math.min(index, variant.pageSequence.length - 1)] ?? variant.pageSequence[0];
    const nextScreenId = variant.pageSequence[Math.min(index + 1, variant.pageSequence.length - 1)];
    return {
      sequence: index + 1,
      screenId,
      actionId,
      actionLabel: action?.label ?? actionId,
      permittedActionIds: [actionId],
      expectedNextScreenId: nextScreenId,
      sourceEvidenceRefs: variant.evidenceRefs,
    };
  });
  const manifest = {
    runId,
    variantId,
    environment,
    baseUrl: store.config.runtime.baseUrl,
    rules: [
      'Perform one planned action at a time.',
      'Capture a fresh snapshot after navigation or rerender.',
      'Do not persist snapshot-local references.',
      'Do not force clicks, guess values or alter the business path.',
    ],
    steps,
    expectedSuccessScreenId: variant.pageSequence.at(-1),
  };
  const directory = path.join(store.workDirectory, 'runtime');
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${runId}.manifest.json`);
  await fs.writeFile(destination, stableJson(manifest), 'utf8');
  return { runId, path: destination };
}

export async function recordGrounding(store: ArtifactStore, runId: string, observationFile: string): Promise<RuntimeBindings> {
  const observation = ObservationSchema.parse(JSON.parse(await fs.readFile(path.resolve(observationFile), 'utf8')));
  if (observation.runId !== runId) throw new Error(`Observation runId ${observation.runId} does not match ${runId}.`);
  const behavior = await store.read<BehaviorGraph>('behavior');
  const actionIds = new Set(behavior.data.nodes.filter((node) => node.kind === 'action').map((node) => node.id));
  const screenIds = new Set(behavior.data.nodes.filter((node) => node.kind === 'screen-state').map((node) => node.id));
  let existing: RuntimeBindings = { bindings: [] };
  if (await store.exists('runtime')) existing = (await store.read<RuntimeBindings>('runtime')).data;
  const additions: RuntimeBinding[] = observation.observations.map((item) => {
    if (!actionIds.has(item.actionId)) throw new Error(`Unknown action ${item.actionId}.`);
    if (!screenIds.has(item.screenId)) throw new Error(`Unknown screen ${item.screenId}.`);
    return {
      id: stableId('runtime-binding', `${observation.environment}:${item.screenId}:${item.actionId}`),
      actionId: item.actionId,
      screenId: item.screenId,
      environment: observation.environment,
      locator: {
        strategy: item.locator.strategy,
        ...(item.locator.role ? { role: item.locator.role } : {}),
        ...(item.locator.name ? { name: item.locator.name } : {}),
        ...(item.locator.value ? { value: item.locator.value } : {}),
      },
      componentAdapter: item.componentAdapter,
      unique: item.unique,
      actionable: item.actionable,
      ...(item.observedOperationId ? { observedOperationId: item.observedOperationId } : {}),
      ...(item.observedNextStateId ? { observedNextStateId: item.observedNextStateId } : {}),
      evidenceRefs: item.evidenceRefs,
    };
  });
  const merged = { bindings: [...new Map([...existing.bindings, ...additions].map((binding) => [binding.id, binding])).values()] };
  const envelope = store.createEnvelope({ artifactType: 'runtime-bindings', producer: 'runtime:record', sourceDigest: behavior.meta.sourceDigest, data: merged, status: 'grounded' });
  await store.write('runtime', envelope);
  return merged;
}
