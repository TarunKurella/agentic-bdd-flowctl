import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { snapshotSources } from '../adapters/source.js';
import { artifactEnvelopeDigest, type ArtifactStore } from '../core/artifact-store.js';
import { safeChildPath, safeFileSegment } from '../core/paths.js';
import { sha256, stableJson } from '../core/stable.js';
import { evaluateConstraintValue } from '../contracts/constraints.js';
import { isSecretBearingRequirement, isSensitiveFieldPath } from './sensitivity.js';
import type {
  ActorRequirements,
  ArtifactEnvelope,
  BehaviorGraph,
  DataRequirement,
  FlowVariants,
  PageContracts,
  PathWitnesses,
} from '../ir/model.js';

const ConfirmationSchema = z.object({
  reviewer: z.string().trim().min(1),
  confirmedAt: z.string().datetime({ offset: true }),
});

const BindingEntrySchema = z.object({
  alias: z.string().trim().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  secretRef: z.string().trim().min(1).optional(),
  resolver: z.string().trim().min(1),
  requirementDigest: z.string().optional(),
  verified: z.boolean().default(false),
  confirmation: ConfirmationSchema.optional(),
}).refine(
  (binding) => (binding.value !== undefined) !== (binding.secretRef !== undefined),
  'Exactly one of value or secretRef is required.',
)
  .superRefine((binding, context) => {
    if (/^<.*>$/.test(binding.alias) || (typeof binding.value === 'string' && /^<.*>$/.test(binding.value))
      || (binding.secretRef && /^<.*>$/.test(binding.secretRef))) {
      context.addIssue({
        code: 'custom',
        message: 'Application data template placeholders must be replaced by a human-supplied value before this file can be used.',
      });
    }
    if (binding.verified && !binding.confirmation) {
      context.addIssue({
        code: 'custom',
        path: ['confirmation'],
        message: 'A verified binding requires reviewer and confirmation timestamp metadata.',
      });
    }
    if (binding.verified && !binding.requirementDigest) {
      context.addIssue({
        code: 'custom',
        path: ['requirementDigest'],
        message: 'A verified binding requires the exact canonical requirement digest.',
      });
    }
    if (!binding.verified && binding.confirmation) {
      context.addIssue({
        code: 'custom',
        path: ['verified'],
        message: 'Confirmation metadata is only valid for a verified binding.',
      });
    }
  });

const BindingSchema = z.object({
  version: z.literal(1),
  application: z.string().min(1),
  bindings: z.record(z.string(), BindingEntrySchema),
});

export type ApplicationBindings = z.infer<typeof BindingSchema>;
export type RequirementConfirmation = z.infer<typeof ConfirmationSchema>;

interface DataRequirementsArtifact {
  variantId: string;
  requirements: DataRequirement[];
}

interface RequirementContext {
  variants: ArtifactEnvelope<FlowVariants>;
  pages: ArtifactEnvelope<PageContracts>;
  actors: ArtifactEnvelope<ActorRequirements>;
  witnesses: ArtifactEnvelope<PathWitnesses>;
  behavior: ArtifactEnvelope<BehaviorGraph>;
  currentSourceDigest: string;
}

export async function readVariantRequirements(store: ArtifactStore, variantId: string): Promise<DataRequirement[]> {
  const context = await requirementContext(store);
  return readVariantRequirementsWithContext(store, variantId, context);
}

async function readVariantRequirementsWithContext(
  store: ArtifactStore,
  variantId: string,
  context: RequirementContext,
): Promise<DataRequirement[]> {
  const safeVariantId = safeFileSegment(variantId, 'Variant ID');
  const file = safeChildPath(store.dataRequirementsDirectory, `${safeVariantId}.yaml`);
  const parsed = parseYaml(await store.readManagedFile(file)) as ArtifactEnvelope<DataRequirementsArtifact>;
  if (!parsed?.meta || !parsed.data || !Array.isArray(parsed.data.requirements)) {
    throw new Error(`Data requirements for ${variantId} are not a valid canonical artifact.`);
  }
  const variant = context.variants.data.variants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`Unknown variant ${variantId}.`);
  const actualContentDigest = sha256(stableJson(parsed.data));
  if (parsed.meta.artifactType !== 'data-requirements' || parsed.meta.producer !== 'data:plan'
    || parsed.meta.schemaVersion !== '1.0' || parsed.meta.producerVersion !== '0.2.0'
    || parsed.meta.contentDigest !== actualContentDigest) {
    throw new Error(`Data requirements for ${variantId} have an invalid or stale artifact envelope.`);
  }
  if (!parsed.meta.envelopeDigest
    || parsed.meta.envelopeDigest !== artifactEnvelopeDigest(parsed)) {
    throw new Error(`Data requirements for ${variantId} have an invalid envelope digest. Run flowctl discover.`);
  }
  const expectedInputDigests = {
    variants: context.variants.meta.contentDigest,
    witnesses: context.witnesses.meta.contentDigest,
    behavior: context.behavior.meta.contentDigest,
    pages: context.pages.meta.contentDigest,
    actors: context.actors.meta.contentDigest,
  };
  if (parsed.meta.status === 'stale'
    || parsed.meta.sourceDigest !== context.currentSourceDigest
    || parsed.meta.sourceDigest !== context.variants.meta.sourceDigest
    || parsed.meta.configDigest !== store.config.configDigest
    || stableJson(parsed.meta.inputDigests) !== stableJson(expectedInputDigests)) {
    throw new Error(`Data requirements for ${variantId} are stale. Run flowctl discover before using application data.`);
  }
  if (parsed.data.variantId !== variantId || parsed.data.requirements.some((requirement) => requirement.variantId !== variantId)) {
    throw new Error(`Data requirements for ${variantId} contain a mismatched variant identity.`);
  }
  const declared = [...variant.dataRequirementIds].sort();
  const actual = parsed.data.requirements.map((requirement) => requirement.id).sort();
  if (new Set(actual).size !== actual.length || stableJson(actual) !== stableJson(declared)) {
    throw new Error(`Data requirements for ${variantId} do not match the variant's declared requirement IDs.`);
  }
  return parsed.data.requirements;
}

export async function readApplicationBindings(store: ArtifactStore): Promise<ApplicationBindings> {
  const file = store.applicationDataFile;
  try {
    const bindings = BindingSchema.parse(parseYaml(await store.readManagedFile(file)));
    if (bindings.application !== store.config.project.name) {
      throw new Error(`Application data file targets ${bindings.application}, not ${store.config.project.name}.`);
    }
    for (const binding of Object.values(bindings.bindings)) {
      if (binding.secretRef) assertApprovedSecretReference(store, binding.secretRef);
    }
    return bindings;
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, application: store.config.project.name, bindings: {} };
    throw error;
  }
}

export async function bindRequirement(options: {
  store: ArtifactStore;
  requirementId: string;
  alias: string;
  resolver: string;
  value?: string;
  secretRef?: string;
}): Promise<string> {
  const requirement = await findRequirement(options.store, options.requirementId);
  if (!requirement.resolutionStrategies.includes(options.resolver)) {
    throw new Error(`Resolver ${options.resolver} is not approved for ${requirement.id}. Allowed strategies: ${requirement.resolutionStrategies.join(', ')}.`);
  }
  if (isSecretBearingRequirement(requirement)) {
    if (!options.secretRef) throw new Error(`${requirement.classification} must be bound with --secret-ref, not a raw value.`);
  }
  if (options.secretRef && !['secret-reference', 'authenticated-identity'].includes(requirement.classification)) {
    throw new Error(`--secret-ref is only valid for secret-reference or authenticated-identity requirements; ${requirement.id} requires a typed value whose constraints can be checked.`);
  }
  if (options.secretRef) assertApprovedSecretReference(options.store, options.secretRef);
  if (options.value !== undefined && isSensitiveFieldPath(requirement.fieldPath)) {
    throw new Error(`Raw sensitive value is forbidden for ${requirement.fieldPath}; use --secret-ref.`);
  }
  const parsedValue = options.value !== undefined ? parseScalar(options.value) : undefined;
  if (parsedValue !== undefined) {
    const issues = requirementValueIssues(requirement, parsedValue);
    if (issues.length) throw new Error(`Value for ${requirement.fieldPath} violates its source-derived contract: ${issues.join('; ')}.`);
  }
  const current = await readApplicationBindings(options.store);
  current.bindings[options.requirementId] = {
    alias: options.alias,
    ...(parsedValue !== undefined ? { value: parsedValue } : {}),
    ...(options.secretRef ? { secretRef: options.secretRef } : {}),
    resolver: options.resolver,
    requirementDigest: digestRequirement(requirement),
    verified: false,
  };
  return writeApplicationBindings(options.store, current);
}

export async function confirmRequirement(options: {
  store: ArtifactStore;
  requirementId: string;
  reviewer: string;
  confirmedAt?: string;
}): Promise<{ destination: string; confirmation: RequirementConfirmation }> {
  const requirement = await findRequirement(options.store, options.requirementId);
  const current = await readApplicationBindings(options.store);
  const binding = current.bindings[options.requirementId];
  if (!binding) throw new Error(`Data requirement ${options.requirementId} is not bound in the application data file.`);
  const modalityIssue = bindingModalityIssue(binding, requirement);
  if (modalityIssue) throw new Error(`Binding for ${requirement.id} is invalid: ${modalityIssue}`);
  if (!requirement.resolutionStrategies.includes(binding.resolver)) {
    throw new Error(`Resolver ${binding.resolver} is not approved for ${requirement.id}.`);
  }
  const confirmation = ConfirmationSchema.parse({
    reviewer: options.reviewer,
    confirmedAt: options.confirmedAt ?? new Date().toISOString(),
  });
  current.bindings[options.requirementId] = {
    ...binding,
    requirementDigest: digestRequirement(requirement),
    verified: true,
    confirmation,
  };
  const destination = await writeApplicationBindings(options.store, current);
  return { destination, confirmation };
}

export async function verifyVariantData(store: ArtifactStore, variantId: string): Promise<{
  ready: boolean;
  readinessDigest: string;
  generated: string[];
  bound: string[];
  verified: string[];
  unverified: { id: string; fieldPath: string; classification: string; alias: string; resolver: string; reason: string }[];
  missing: { id: string; fieldPath: string; classification: string; strategies: string[] }[];
}> {
  const context = await requirementContext(store);
  const requirements = await readVariantRequirementsWithContext(store, variantId, context);
  const bindings = await readApplicationBindings(store);
  const generated = requirements.filter((requirement) => (
    ['flow-literal', 'synthetic-constrained', 'derived', 'runtime-option'].includes(requirement.classification)
    && requirement.status === 'generated'
    && requirement.representativeValue !== undefined
    && requirementValueIssues(requirement, requirement.representativeValue).length === 0
  )).map((requirement) => requirement.id);
  const external = requirements.filter((requirement) => !generated.includes(requirement.id));
  const bound = external.filter((requirement) => bindings.bindings[requirement.id]).map((requirement) => requirement.id);
  const verified = external.filter((requirement) => {
    const binding = bindings.bindings[requirement.id];
    return binding?.verified === true && bindingMatchesRequirement(binding, requirement);
  }).map((requirement) => requirement.id);
  const unverified = external.flatMap((requirement) => {
    const binding = bindings.bindings[requirement.id];
    if (!binding || (binding.verified && bindingMatchesRequirement(binding, requirement))) return [];
    const modalityIssue = bindingModalityIssue(binding, requirement);
    return [{
      id: requirement.id,
      fieldPath: requirement.fieldPath,
      classification: requirement.classification,
      alias: binding.alias,
      resolver: binding.resolver,
      reason: modalityIssue ?? (binding.verified
        ? (requirement.resolutionStrategies.includes(binding.resolver)
          ? 'The requirement contract changed after confirmation.'
          : 'The resolver is not approved by the current requirement contract.')
        : 'The binding has not been confirmed by a named reviewer.'),
    }];
  });
  const missing = external.filter((requirement) => !bindings.bindings[requirement.id]).map((requirement) => ({
    id: requirement.id,
    fieldPath: requirement.fieldPath,
    classification: requirement.classification,
    strategies: requirement.resolutionStrategies,
  }));
  const readinessDigest = sha256(stableJson({
    variantId,
    application: store.config.project.name,
    dataConfigDigest: store.config.dataConfigDigest,
    requirements,
    bindings: Object.fromEntries(external.map((requirement) => [requirement.id, bindings.bindings[requirement.id] ?? null])),
  }));
  return { ready: missing.length === 0 && unverified.length === 0, readinessDigest, generated, bound, verified, unverified, missing };
}

async function findRequirement(store: ArtifactStore, requirementId: string): Promise<DataRequirement> {
  const context = await requirementContext(store);
  const requirements = (await Promise.all(context.variants.data.variants.map((variant) => (
    readVariantRequirementsWithContext(store, variant.id, context)
  )))).flat();
  const requirement = requirements.find((candidate) => candidate.id === requirementId);
  if (!requirement) throw new Error(`Data requirement ${requirementId} not found.`);
  return requirement;
}

async function requirementContext(store: ArtifactStore): Promise<RequirementContext> {
  const [variants, pages, actors, witnesses, behavior, snapshot] = await Promise.all([
    store.read<FlowVariants>('variants'),
    store.read<PageContracts>('pages'),
    store.read<ActorRequirements>('actors'),
    store.read<PathWitnesses>('witnesses'),
    store.read<BehaviorGraph>('behavior'),
    snapshotSources(store.config),
  ]);
  const stale = [variants, pages, actors, witnesses, behavior].find((artifact) => (
    artifact.meta.status === 'stale'
    || artifact.meta.sourceDigest !== snapshot.digest
    || artifact.meta.configDigest !== store.config.configDigest
  ));
  if (stale) {
    throw new Error(`${stale.meta.artifactType} is stale. Run flowctl discover before using application data.`);
  }
  return { variants, pages, actors, witnesses, behavior, currentSourceDigest: snapshot.digest };
}

async function writeApplicationBindings(store: ArtifactStore, bindings: ApplicationBindings): Promise<string> {
  if (bindings.application !== store.config.project.name) {
    throw new Error(`Application data file ${bindings.application} does not match ${store.config.project.name}.`);
  }
  const validated = BindingSchema.parse(bindings);
  const destination = store.applicationDataFile;
  return store.writeManagedFile(destination, stringifyYaml(validated, { lineWidth: 0, sortMapEntries: true }));
}

function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return value;
}

function digestRequirement(requirement: DataRequirement): string {
  return sha256(stableJson(requirement));
}

function bindingMatchesRequirement(
  binding: ApplicationBindings['bindings'][string],
  requirement: DataRequirement,
): boolean {
  return !bindingModalityIssue(binding, requirement)
    && binding.requirementDigest === digestRequirement(requirement)
    && requirement.resolutionStrategies.includes(binding.resolver)
    && (binding.value === undefined || requirementValueIssues(requirement, binding.value).length === 0);
}

function bindingModalityIssue(
  binding: ApplicationBindings['bindings'][string],
  requirement: DataRequirement,
): string | undefined {
  const requiresSecretReference = isSecretBearingRequirement(requirement);
  if (requiresSecretReference) {
    if (!binding.secretRef || binding.value !== undefined) {
      return `${requirement.classification} requires an approved secretRef; a raw value cannot satisfy this requirement.`;
    }
    return undefined;
  }
  if (binding.value === undefined || binding.secretRef) {
    return `${requirement.classification} requires a typed value so its source-derived constraints can be checked; secretRef is not allowed.`;
  }
  return undefined;
}

function requirementValueIssues(
  requirement: DataRequirement,
  value: string | number | boolean | null,
): string[] {
  const issues = evaluateConstraintValue(requirement.constraints, value, 'ui-input').issues;
  if (requirement.expectedValue !== undefined && !Object.is(value, requirement.expectedValue)) {
    issues.push(`the supplied assertion must equal source-required value ${JSON.stringify(requirement.expectedValue)}`);
  }
  return issues;
}

function assertApprovedSecretReference(store: ArtifactStore, value: string): void {
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//)?.[1];
  if (scheme && store.config.data.secretReferenceSchemes.includes(scheme)) return;
  if (store.config.data.allowAwsSecretsManagerArns
    && /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[^\s]+$/i.test(value)) return;
  throw new Error(
    `secretRef must be an approved provider reference using one of (${store.config.data.secretReferenceSchemes.join(', ')})`
    + `${store.config.data.allowAwsSecretsManagerArns ? ' or a valid AWS Secrets Manager ARN' : ''}; raw values are forbidden and arbitrary URLs are forbidden.`,
  );
}
