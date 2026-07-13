import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactStore } from '../core/artifact-store.js';
import { stableId, stableJson } from '../core/stable.js';
import { verifyVariantData } from '../data/bindings.js';
import type { BehaviorGraph, FlowVariants, PageContracts, RuntimeBindings } from '../ir/model.js';

export interface ExecutionPlan {
  planId: string;
  variantId: string;
  environment: string;
  readiness: 'blocked-data' | 'blocked-runtime' | 'executable';
  data: Awaited<ReturnType<typeof verifyVariantData>>;
  missingActionBindings: string[];
  steps: {
    sequence: number;
    pageId?: string;
    actionId: string;
    runtimeBindingId?: string;
    expectedNextPageId?: string;
  }[];
  rules: string[];
}

export async function compileExecutionPlan(store: ArtifactStore, variantId: string, environment: string): Promise<{ plan: ExecutionPlan; path: string }> {
  const variants = await store.read<FlowVariants>('variants');
  const behavior = await store.read<BehaviorGraph>('behavior');
  const pages = await store.read<PageContracts>('pages');
  const runtime = await store.read<RuntimeBindings>('runtime');
  const variant = variants.data.variants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`Unknown variant ${variantId}.`);
  const data = await verifyVariantData(store, variantId, environment);
  const bindings = runtime.meta.status === 'stale' ? [] : runtime.data.bindings.filter((binding) => binding.environment === environment && binding.unique && binding.actionable);
  const missingActionBindings = variant.actionSequence.filter((actionId) => !bindings.some((binding) => binding.actionId === actionId));
  const steps = variant.actionSequence.map((actionId, index) => ({
    sequence: index + 1,
    ...(variant.pageSequence[index] ? { pageId: variant.pageSequence[index] } : {}),
    actionId,
    ...(bindings.find((binding) => binding.actionId === actionId)?.id ? { runtimeBindingId: bindings.find((binding) => binding.actionId === actionId)!.id } : {}),
    ...(variant.pageSequence[index + 1] ? { expectedNextPageId: variant.pageSequence[index + 1] } : {}),
  }));
  const readiness: ExecutionPlan['readiness'] = !data.ready ? 'blocked-data' : missingActionBindings.length ? 'blocked-runtime' : 'executable';
  const plan: ExecutionPlan = {
    planId: stableId('execution-plan', `${variantId}:${environment}`),
    variantId,
    environment,
    readiness,
    data,
    missingActionBindings,
    steps,
    rules: [
      'Do not execute unless readiness is executable.',
      'Use only the environment bindings and grounded actions referenced by this plan.',
      'Do not replace missing data with guessed identifiers.',
      'Do not bypass actionability with forced clicks.',
    ],
  };
  const directory = path.join(store.workDirectory, 'runtime');
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${plan.planId}.execution.json`);
  await fs.writeFile(destination, stableJson(plan), 'utf8');
  return { plan, path: destination };
}
