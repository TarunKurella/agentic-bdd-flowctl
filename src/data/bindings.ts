import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { ArtifactStore } from '../core/artifact-store.js';
import type { DataRequirement, FlowVariants } from '../ir/model.js';

const BindingSchema = z.object({
  version: z.literal(1),
  environment: z.string(),
  bindings: z.record(z.string(), z.object({
    alias: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    secretRef: z.string().optional(),
    resolver: z.string().min(1),
    verified: z.boolean().default(false),
  }).refine((binding) => binding.value !== undefined || binding.secretRef !== undefined, 'A value or secretRef is required.')),
});

export type EnvironmentBindings = z.infer<typeof BindingSchema>;

export async function readVariantRequirements(store: ArtifactStore, variantId: string): Promise<DataRequirement[]> {
  const file = path.join(store.dataRequirementsDirectory, `${variantId}.yaml`);
  const parsed = parseYaml(await fs.readFile(file, 'utf8')) as { data?: { requirements?: DataRequirement[] } };
  return parsed.data?.requirements ?? [];
}

export async function readEnvironmentBindings(store: ArtifactStore, environment: string): Promise<EnvironmentBindings> {
  const file = path.join(store.dataBindingsDirectory, `${environment}.local.yaml`);
  try {
    return BindingSchema.parse(parseYaml(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    return { version: 1, environment, bindings: {} };
  }
}

export async function bindRequirement(options: {
  store: ArtifactStore;
  environment: string;
  requirementId: string;
  alias: string;
  resolver: string;
  value?: string;
  secretRef?: string;
}): Promise<string> {
  const variants = await options.store.read<FlowVariants>('variants');
  const requirements = (await Promise.all(variants.data.variants.map((variant) => readVariantRequirements(options.store, variant.id)))).flat();
  const requirement = requirements.find((candidate) => candidate.id === options.requirementId);
  if (!requirement) throw new Error(`Data requirement ${options.requirementId} not found.`);
  if (requirement.classification === 'secret-reference' || requirement.classification === 'authenticated-identity') {
    if (!options.secretRef) throw new Error(`${requirement.classification} must be bound with --secret-ref, not a raw value.`);
  }
  if (options.value !== undefined && /(password|token|secret|otp)/i.test(requirement.fieldPath)) {
    throw new Error(`Raw sensitive value is forbidden for ${requirement.fieldPath}; use --secret-ref.`);
  }
  const current = await readEnvironmentBindings(options.store, options.environment);
  current.bindings[options.requirementId] = {
    alias: options.alias,
    ...(options.value !== undefined ? { value: parseScalar(options.value) } : {}),
    ...(options.secretRef ? { secretRef: options.secretRef } : {}),
    resolver: options.resolver,
    verified: false,
  };
  const validated = BindingSchema.parse(current);
  await fs.mkdir(options.store.dataBindingsDirectory, { recursive: true });
  const destination = path.join(options.store.dataBindingsDirectory, `${options.environment}.local.yaml`);
  await fs.writeFile(destination, stringifyYaml(validated, { lineWidth: 0, sortMapEntries: true }), 'utf8');
  return destination;
}

export async function verifyVariantData(store: ArtifactStore, variantId: string, environment: string): Promise<{
  ready: boolean;
  generated: string[];
  bound: string[];
  missing: { id: string; fieldPath: string; classification: string; strategies: string[] }[];
}> {
  const requirements = await readVariantRequirements(store, variantId);
  const bindings = await readEnvironmentBindings(store, environment);
  const generated = requirements.filter((requirement) => ['flow-literal', 'synthetic-constrained', 'derived'].includes(requirement.classification)).map((requirement) => requirement.id);
  const external = requirements.filter((requirement) => !generated.includes(requirement.id));
  const bound = external.filter((requirement) => bindings.bindings[requirement.id]).map((requirement) => requirement.id);
  const missing = external.filter((requirement) => !bindings.bindings[requirement.id]).map((requirement) => ({
    id: requirement.id,
    fieldPath: requirement.fieldPath,
    classification: requirement.classification,
    strategies: requirement.resolutionStrategies,
  }));
  return { ready: missing.length === 0, generated, bound, missing };
}

function parseScalar(value: string): string | number | boolean {
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
