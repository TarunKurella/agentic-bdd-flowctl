import path from 'node:path';
import { snapshotSources } from '../adapters/source.js';
import type { ArtifactStore } from '../core/artifact-store.js';
import { assertArtifactLineage } from '../core/freshness.js';
import { safeFileSegment } from '../core/paths.js';
import { stableJson } from '../core/stable.js';
import { readVariantRequirements } from '../data/bindings.js';
import { isSecretBearingRequirement } from '../data/sensitivity.js';
import type { ActorRequirements, BehaviorGraph, DataRequirement, FlowFamilies, FlowVariants, OperationCatalog, PageContracts, PathWitnesses } from '../ir/model.js';

export async function generateBdd(store: ArtifactStore, requestedFamily?: string): Promise<string[]> {
  const families = await store.read<FlowFamilies>('families');
  const variants = await store.read<FlowVariants>('variants');
  const behavior = await store.read<BehaviorGraph>('behavior');
  const witnesses = await store.read<PathWitnesses>('witnesses');
  const pages = await store.read<PageContracts>('pages');
  const actors = await store.read<ActorRequirements>('actors');
  const operations = await store.read<OperationCatalog>('operations');
  await assertArtifactLineage(store, [
    { name: 'families', envelope: families },
    { name: 'variants', envelope: variants },
    { name: 'behavior', envelope: behavior },
    { name: 'witnesses', envelope: witnesses },
    { name: 'pages', envelope: pages },
    { name: 'actors', envelope: actors },
    { name: 'operations', envelope: operations },
  ]);
  const currentSourceDigest = (await snapshotSources(store.config)).digest;
  const inputs = [families, variants, behavior, witnesses, pages, actors, operations];
  const stale = inputs.find((artifact) => (
    artifact.meta.status === 'stale'
    || artifact.meta.sourceDigest !== currentSourceDigest
    || artifact.meta.configDigest !== store.config.configDigest
  ));
  if (stale) throw new Error(`${stale.meta.artifactType} is stale. Run flowctl analyze --through coverage before generating BDD.`);
  const journeyDirectory = path.join(store.generatedDirectory, 'features', 'journeys');
  const legacyContractDirectory = path.join(store.generatedDirectory, 'features', 'page-contracts');
  const reviewDirectory = path.join(store.generatedDirectory, 'review');
  const contractDirectory = path.join(reviewDirectory, 'page-contracts');
  const conditionalDirectory = path.join(reviewDirectory, 'conditional-journeys');
  await store.ensureManagedDirectory(journeyDirectory);
  await store.ensureManagedDirectory(contractDirectory);
  await store.ensureManagedDirectory(conditionalDirectory);
  const generated: string[] = [];
  const stepPlan: Record<string, unknown>[] = [];
  const planPath = path.join(store.generatedDirectory, 'step-plan.json');
  const traceabilityPath = path.join(store.generatedDirectory, 'bdd-traceability.json');
  const traceability: {
    version: 1;
    sourceDigest: string;
    configDigest: string;
    inputDigests: Record<string, string>;
    journeys: Record<string, unknown>[];
    pageContracts: Record<string, unknown>[];
  } = {
    version: 1,
    sourceDigest: variants.meta.sourceDigest,
    configDigest: store.config.configDigest,
    inputDigests: {
      families: families.meta.contentDigest,
      variants: variants.meta.contentDigest,
      behavior: behavior.meta.contentDigest,
      witnesses: witnesses.meta.contentDigest,
      pages: pages.meta.contentDigest,
      actors: actors.meta.contentDigest,
      operations: operations.meta.contentDigest,
    },
    journeys: [],
    pageContracts: [],
  };
  let preserveOtherJourneyFiles = !requestedFamily;

  if (requestedFamily && !families.data.families.some((candidate) => candidate.id === requestedFamily)) {
    throw new Error(`Unknown flow family ${requestedFamily}. Run flowctl flows list.`);
  }

  if (requestedFamily) {
    try {
      const existing = JSON.parse(await store.readManagedFile(traceabilityPath)) as typeof traceability;
      if (generationMatches(existing, traceability)) {
        traceability.journeys = existing.journeys.filter((journey) => journey.familyId !== requestedFamily);
        preserveOtherJourneyFiles = true;
      }
    } catch {
      // A missing or incompatible trace starts a fresh source-scoped ledger.
    }
    try {
      const existing = JSON.parse(await store.readManagedFile(planPath)) as {
        sourceDigest?: string;
        configDigest?: string;
        inputDigests?: Record<string, string>;
        steps?: Record<string, unknown>[];
      };
      if (generationMatches(existing, traceability)) {
        stepPlan.push(...(existing.steps ?? []).filter((step) => step.familyId !== requestedFamily));
      }
    } catch {
      // A missing or incompatible step plan starts a fresh source-scoped plan.
    }
  }

  for (const family of families.data.families.filter((candidate) => !requestedFamily || candidate.id === requestedFamily)) {
    const familyVariants = variants.data.variants.filter((variant) => variant.familyId === family.id);
    const executableVariants = familyVariants.filter((variant) => variant.feasibility === 'satisfiable');
    const conditionalVariants = familyVariants.filter((variant) => variant.feasibility === 'conditional');
    const destination = path.join(journeyDirectory, `${safeFileSegment(family.id, 'Flow family ID')}.feature`);
    const conditionalDestination = path.join(conditionalDirectory, `${safeFileSegment(family.id, 'Flow family ID')}.feature.txt`);
    const familyLabel = gherkinText(family.label);
    const lines = [`@source-derived @journey @implementation-required`, `Feature: ${familyLabel}`, '', `  Runnable source-derived journeys whose supported constraints have a concrete model.`, ''];
    const variantTraces: Record<string, unknown>[] = [];
    for (const variant of executableVariants) {
      const witness = witnesses.data.witnesses.find((candidate) => candidate.id === variant.witnessIds[0]);
      if (!witness) throw new Error(`Variant ${variant.id} has no readable path witness.`);
      const statements: Array<{ keyword: string; text: string; kind: string; referenceIds: string[] }> = [];
      const addStatement = (keyword: string, text: string, kind: string, referenceIds: string[]) => {
        lines.push(`    ${keyword} ${text}`);
        statements.push({ keyword, text, kind, referenceIds: [...new Set(referenceIds)].sort() });
      };
      const scenarioTag = `@variant:${gherkinTag(variant.id)}`;
      lines.push(`  ${scenarioTag}`);
      lines.push(`  Scenario: ${gherkinText(variant.label)}`);
      addStatement('Given', `data requirements for ${gherkinString(variant.id)} are satisfied`, 'data-precondition', [variant.id, ...variant.dataRequirementIds]);
      const requirements = await readVariantRequirements(store, variant.id);
      for (const requirement of requirements.filter((candidate) => bddSafeSourceValue(candidate, candidate.representativeValue) !== undefined)) {
        const representativeValue = bddSafeSourceValue(requirement, requirement.representativeValue);
        addStatement(
          'And',
          `flow choice for requirement ${gherkinString(requirement.id)} is ${gherkinString(String(representativeValue))}`,
          'flow-assignment',
          [variant.id, witness.id, requirement.id, ...requirement.evidenceRefs],
        );
      }
      if (variant.actorRequirementIds.length) {
        const actorLabels = variant.actorRequirementIds.map((id) => actors.data.actors.find((actor) => actor.id === id)?.label ?? id);
        addStatement('And', `an actor satisfying ${gherkinString(actorLabels.join(', '))} with requirement IDs ${gherkinString(variant.actorRequirementIds.join(','))} starts the journey`, 'actor-precondition', variant.actorRequirementIds);
      }
      let emittedWhen = false;
      for (const [nodeIndex, nodeId] of witness.nodePath.slice(0, -1).entries()) {
        const behaviorNode = behavior.data.nodes.find((node) => node.id === nodeId);
        if (!behaviorNode) continue;
        if (behaviorNode.kind === 'screen-state') {
          const page = pages.data.pages.find((candidate) => candidate.id === nodeId);
          if (!page) continue;
          const pageRequirements = requirements.filter((requirement) => requirement.pageId === page.id && requirement.fieldId);
          for (const requirement of pageRequirements) {
            addStatement(
              emittedWhen ? 'And' : 'When',
              `a source-valid value is entered for ${gherkinString(requirement.fieldPath)} using field ID ${gherkinString(requirement.fieldId!)} on page ID ${gherkinString(page.id)}`,
              'valid-field-input',
              [page.id, requirement.fieldId!, requirement.id, ...requirement.evidenceRefs],
            );
            emittedWhen = true;
            for (const constraint of requirement.constraints) {
              const sourceValue = bddSafeSourceValue(requirement, constraint.value);
              addStatement(
                'And',
                `the value for field ID ${gherkinString(requirement.fieldId!)} satisfies constraint ID ${gherkinString(constraint.id)} of kind ${gherkinString(constraint.kind)} in domain ${gherkinString(constraint.domain ?? 'unspecified')}${sourceValue !== undefined ? ` with source value ${gherkinString(JSON.stringify(sourceValue))}` : ''}`,
                'constraint-satisfied',
                [page.id, requirement.fieldId!, requirement.id, constraint.id],
              );
            }
          }
          addStatement(emittedWhen ? 'And' : 'When', `the actor completes page ID ${gherkinString(page.id)} named ${gherkinString(page.name)}`, 'complete-page', [page.id, ...page.evidenceRefs]);
          emittedWhen = true;
        }
        if (behaviorNode.kind === 'action') {
          const adjacentEdges = [witness.edgePath[nodeIndex - 1], witness.edgePath[nodeIndex]].filter((id): id is string => Boolean(id));
          const edgeEvidence = behavior.data.edges.filter((edge) => adjacentEdges.includes(edge.id)).flatMap((edge) => edge.evidenceRefs);
          addStatement(emittedWhen ? 'And' : 'When', `the actor performs action ID ${gherkinString(behaviorNode.id)} named ${gherkinString(behaviorNode.label)}`, 'perform-action', [behaviorNode.id, ...adjacentEdges, ...edgeEvidence]);
          emittedWhen = true;
        }
      }
      const variantOperations = operations.data.operations.filter((operation) => variant.operationIds.includes(operation.id));
      addStatement('Then', `${gherkinString(family.label)} with operation IDs ${gherkinString(variant.operationIds.join(','))} should succeed`, 'operation-success', [
        ...variant.operationIds,
        ...variantOperations.flatMap((operation) => operation.evidenceRefs),
      ]);
      const terminalNode = behavior.data.nodes.find((node) => node.id === witness.nodePath.at(-1));
      const successPage = terminalNode?.kind === 'screen-state'
        ? pages.data.pages.find((page) => page.id === terminalNode.id)
        : undefined;
      if (successPage) addStatement('And', `page ID ${gherkinString(successPage.id)} named ${gherkinString(successPage.name)} should be displayed`, 'success-page', [successPage.id, ...successPage.evidenceRefs]);
      lines.push('');
      variantTraces.push({
        variantId: variant.id,
        scenarioTag,
        witnessId: witness.id,
        behaviorSignature: variant.behaviorSignature,
        feasibility: variant.feasibility,
        pathCondition: witness.pathCondition,
        assignments: witness.assignments,
        nodePath: witness.nodePath,
        edgePath: witness.edgePath,
        statements,
      });
      stepPlan.push({
        variantId: variant.id,
        familyId: family.id,
        witnessId: witness.id,
        nodePath: witness.nodePath,
        edgePath: witness.edgePath,
        pathCondition: witness.pathCondition,
        assignments: witness.assignments,
        pageSequence: variant.pageSequence,
        actionSequence: variant.actionSequence,
        dataRequirementIds: variant.dataRequirementIds,
        evidenceRefs: variant.evidenceRefs,
      });
    }
    if (executableVariants.length) {
      await store.writeManagedFile(destination, `${lines.join('\n').trim()}\n`);
      generated.push(destination);
    } else {
      await store.removeManagedFile(destination);
    }
    if (conditionalVariants.length) {
      const reviewLines = [
        '@source-derived @conditional @review-only',
        `Feature: ${familyLabel} conditional candidates`,
        '',
        '  Review specification only. This .txt file is intentionally outside Playwright-BDD feature discovery.',
        '',
      ];
      for (const variant of conditionalVariants) {
        const witness = witnesses.data.witnesses.find((candidate) => candidate.id === variant.witnessIds[0]);
        const reviewStatements = [
          {
            keyword: 'Given',
            text: `unresolved source conditions for variant ${gherkinString(variant.id)} are reviewed`,
            kind: 'review-unresolved-conditions',
            referenceIds: [variant.id, ...variant.evidenceRefs],
          },
          {
            keyword: 'When',
            text: `its witness ${gherkinString(witness?.id ?? 'missing')} is made executable`,
            kind: 'review-witness',
            referenceIds: witness ? [witness.id, ...witness.evidenceRefs] : [variant.id],
          },
          {
            keyword: 'Then',
            text: `${gherkinString(family.label)} may become a runnable journey`,
            kind: 'review-outcome',
            referenceIds: [family.id, ...family.operationIds],
          },
        ];
        reviewLines.push(`  @variant:${gherkinTag(variant.id)} @conditional @review-only`);
        reviewLines.push(`  Scenario: ${gherkinText(variant.label)}`);
        reviewStatements.forEach((statement) => reviewLines.push(`    ${statement.keyword} ${statement.text}`));
        reviewLines.push('');
        variantTraces.push({
          variantId: variant.id,
          witnessId: witness?.id,
          behaviorSignature: variant.behaviorSignature,
          feasibility: 'conditional',
          executable: false,
          reviewReason: 'One or more source predicates, backend guards, value proofs, or runtime prerequisites are unresolved.',
          pathCondition: witness?.pathCondition ?? variant.pathCondition,
          assignments: witness?.assignments ?? {},
          nodePath: witness?.nodePath ?? [],
          edgePath: witness?.edgePath ?? [],
          statements: reviewStatements.map((statement) => ({
            ...statement,
            referenceIds: [...new Set(statement.referenceIds)].sort(),
          })),
        });
      }
      await store.writeManagedFile(conditionalDestination, `${reviewLines.join('\n').trim()}\n`);
      generated.push(conditionalDestination);
    } else {
      await store.removeManagedFile(conditionalDestination);
    }
    traceability.journeys.push({
      familyId: family.id,
      ...(executableVariants.length ? { featurePath: portablePath(store, destination) } : {}),
      ...(conditionalVariants.length ? { reviewPath: portablePath(store, conditionalDestination) } : {}),
      variants: variantTraces,
    });
  }

  for (const page of pages.data.pages) {
    const editableFields = page.fields.filter((field) => (field.inputMode ?? 'editable') === 'editable');
    if (!editableFields.length) continue;
    const lines = [
      '@source-derived @page-contract @review-only',
      `Feature: ${gherkinText(page.name)} field contracts`,
      '',
      '  Frontend-only reusable contract specification. Backend/operation-specific constraints are emitted in concrete journey scenarios. This .txt file is intentionally not a standalone runnable journey because page-state guards need a concrete flow variant.',
      '',
    ];
    const scenarioTraces: Record<string, unknown>[] = [];
    for (const field of editableFields) {
      lines.push(`  Scenario: Provide a valid value for ${gherkinText(field.label ?? field.dataPath)}`);
      lines.push(`    Given the actor is on page ID ${gherkinString(page.id)} named ${gherkinString(page.name)}`);
      lines.push(`    When a source-valid value is entered for ${gherkinString(field.dataPath)} using field ID ${gherkinString(field.id)} on page ID ${gherkinString(page.id)}`);
      lines.push(`    Then field ID ${gherkinString(field.id)} should satisfy its active validation contract`);
      lines.push('');
      scenarioTraces.push({
        name: `Provide a valid value for ${gherkinText(field.label ?? field.dataPath)}`,
        kind: 'valid-field-contract',
        fieldId: field.id,
        referenceIds: [field.id, ...field.constraints.map((constraint) => constraint.id)],
        statements: [
          { keyword: 'Given', kind: 'page-precondition', referenceIds: [page.id] },
          { keyword: 'When', kind: 'valid-field-input', referenceIds: [field.id] },
          { keyword: 'Then', kind: 'active-validation-contract', referenceIds: [field.id, ...field.constraints.map((constraint) => constraint.id)] },
        ],
      });
      const uniqueConstraints = new Map(field.constraints.map((constraint) => [
        JSON.stringify({ kind: constraint.kind, value: constraint.value, domain: constraint.domain }),
        constraint,
      ])).values();
      for (const constraint of uniqueConstraints) {
        lines.push(`  Scenario: Enforce ${gherkinText(constraint.kind)} validation for ${gherkinText(field.label ?? field.dataPath)}`);
        lines.push(`    Given the actor is on page ID ${gherkinString(page.id)} named ${gherkinString(page.name)}`);
        lines.push(`    When field ID ${gherkinString(field.id)} on page ID ${gherkinString(page.id)} violates constraint ID ${gherkinString(constraint.id)}`);
        lines.push(`    Then validation should prevent the page from continuing`);
        lines.push('');
        scenarioTraces.push({
          name: `Enforce ${gherkinText(constraint.kind)} validation for ${gherkinText(field.label ?? field.dataPath)}`,
          kind: 'validation-contract',
          fieldId: field.id,
          constraintId: constraint.id,
          referenceIds: [field.id, constraint.id],
          statements: [
            { keyword: 'Given', kind: 'page-precondition', referenceIds: [page.id] },
            { keyword: 'When', kind: 'constraint-violation', referenceIds: [field.id, constraint.id] },
            { keyword: 'Then', kind: 'progress-blocked', referenceIds: [field.id, constraint.id] },
          ],
        });
      }
    }
    const destination = path.join(contractDirectory, `${safeFileSegment(page.id, 'Page ID')}.feature.txt`);
    await store.writeManagedFile(destination, `${lines.join('\n').trim()}\n`);
    generated.push(destination);
    traceability.pageContracts.push({
      pageId: page.id,
      featurePath: portablePath(store, destination),
      scenarios: scenarioTraces,
    });
  }

  await pruneObsoleteFeatures(
    store,
    journeyDirectory,
    new Set((preserveOtherJourneyFiles
      ? families.data.families
      : families.data.families.filter((family) => family.id === requestedFamily)
    ).filter((family) => variants.data.variants.some((variant) => (
      variant.familyId === family.id && variant.feasibility === 'satisfiable'
    ))).map((family) => path.join(journeyDirectory, `${safeFileSegment(family.id, 'Flow family ID')}.feature`))),
  );
  await pruneObsoleteFiles(
    store,
    contractDirectory,
    new Set(pages.data.pages.filter((page) => page.fields.some((field) => (field.inputMode ?? 'editable') === 'editable')).map((page) => path.join(contractDirectory, `${safeFileSegment(page.id, 'Page ID')}.feature.txt`))),
    '.feature.txt',
  );
  await pruneObsoleteFeatures(store, legacyContractDirectory, new Set());
  await pruneObsoleteFiles(
    store,
    conditionalDirectory,
    new Set((preserveOtherJourneyFiles
      ? families.data.families
      : families.data.families.filter((family) => family.id === requestedFamily)
    ).filter((family) => variants.data.variants.some((variant) => (
      variant.familyId === family.id && variant.feasibility === 'conditional'
    ))).map((family) => path.join(conditionalDirectory, `${safeFileSegment(family.id, 'Flow family ID')}.feature.txt`))),
    '.feature.txt',
  );

  traceability.journeys.sort((left, right) => String(left.familyId).localeCompare(String(right.familyId)));
  stepPlan.sort((left, right) => (
    String(left.familyId).localeCompare(String(right.familyId))
    || String(left.variantId).localeCompare(String(right.variantId))
  ));
  await store.writeManagedFile(traceabilityPath, stableJson(traceability));
  generated.push(traceabilityPath);

  await store.writeManagedFile(planPath, stableJson({
    version: 1,
    sourceDigest: traceability.sourceDigest,
    configDigest: traceability.configDigest,
    inputDigests: traceability.inputDigests,
    steps: stepPlan,
  }));
  generated.push(planPath);

  const stepsDirectory = path.join(store.generatedDirectory, 'steps');
  const stepDefinitionsPath = path.join(stepsDirectory, 'flowctl.steps.generated.ts');
  await store.writeManagedFile(stepDefinitionsPath, generatedStepDefinitions());
  generated.push(stepDefinitionsPath);
  return generated;
}

function portablePath(store: ArtifactStore, value: string): string {
  const relative = path.relative(store.config.projectRoot, value);
  return relative.startsWith('..') ? value : relative || '.';
}

export function gherkinText(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function gherkinString(value: unknown): string {
  const normalized = gherkinText(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${normalized}"`;
}

export function bddSafeSourceValue(requirement: Pick<DataRequirement, 'classification'>, value: unknown): unknown {
  return isSecretBearingRequirement(requirement) ? undefined : value;
}

function gherkinTag(value: unknown): string {
  return gherkinText(value).replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

function generationMatches(
  candidate: { sourceDigest?: string; configDigest?: string; inputDigests?: Record<string, string> },
  expected: { sourceDigest: string; configDigest: string; inputDigests: Record<string, string> },
): boolean {
  return candidate.sourceDigest === expected.sourceDigest
    && candidate.configDigest === expected.configDigest
    && stableJson(candidate.inputDigests ?? {}) === stableJson(expected.inputDigests);
}

async function pruneObsoleteFeatures(store: ArtifactStore, directory: string, expected: Set<string>): Promise<void> {
  return pruneObsoleteFiles(store, directory, expected, '.feature');
}

async function pruneObsoleteFiles(store: ArtifactStore, directory: string, expected: Set<string>, suffix: string): Promise<void> {
  await store.ensureManagedDirectory(directory);
  const entries = await store.listManagedDirectory(directory);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => path.join(directory, entry.name))
    .filter((file) => !expected.has(file))
    .map((file) => store.removeManagedFile(file)));
}

function generatedStepDefinitions(): string {
  return `// Generated by flowctl. Regenerate this file; do not hand-edit it.
export interface FlowRuntime {
  prepareData(variantId: string): Promise<void>;
  applyFlowAssignment(requirementId: string, value: string): Promise<void>;
  startJourney(actorLabel: string, actorRequirementIds: string[]): Promise<void>;
  ensurePageDisplayed(pageId: string, pageName: string): Promise<void>;
  completePage(pageId: string, pageName: string): Promise<void>;
  performAction(actionId: string, actionName: string): Promise<void>;
  expectOperationSucceeded(operationName: string, operationIds: string[]): Promise<void>;
  expectPageDisplayed(pageId: string, pageName: string): Promise<void>;
  enterValidFieldValue(fieldPath: string, fieldId: string, pageId: string): Promise<void>;
  expectFieldConstraintSatisfied(fieldId: string, constraintId: string, kind: string, domain: string, sourceValue?: string): Promise<void>;
  expectFieldSatisfiesActiveValidation(fieldId: string): Promise<void>;
  violateFieldConstraint(fieldId: string, pageId: string, constraintId: string, value?: string): Promise<void>;
  expectValidationBlocksProgress(): Promise<void>;
}

export interface StepRegistrar {
  Given(pattern: string, implementation: (...args: any[]) => Promise<void>): void;
  When(pattern: string, implementation: (...args: any[]) => Promise<void>): void;
  Then(pattern: string, implementation: (...args: any[]) => Promise<void>): void;
}

export function registerFlowctlSteps(bdd: StepRegistrar, runtime: FlowRuntime): void {
  bdd.Given('data requirements for {string} are satisfied', async (variantId: string) => runtime.prepareData(variantId));
  bdd.Given('flow choice for requirement {string} is {string}', async (requirementId: string, value: string) => runtime.applyFlowAssignment(requirementId, value));
  bdd.Given('an actor satisfying {string} with requirement IDs {string} starts the journey', async (actor: string, ids: string) => runtime.startJourney(actor, splitIds(ids)));
  bdd.Given('the actor is on page ID {string} named {string}', async (pageId: string, page: string) => runtime.ensurePageDisplayed(pageId, page));
  bdd.When('the actor completes page ID {string} named {string}', async (pageId: string, page: string) => runtime.completePage(pageId, page));
  bdd.When('the actor performs action ID {string} named {string}', async (actionId: string, action: string) => runtime.performAction(actionId, action));
  bdd.When('a source-valid value is entered for {string} using field ID {string} on page ID {string}', async (field: string, fieldId: string, pageId: string) => runtime.enterValidFieldValue(field, fieldId, pageId));
  bdd.When('the value for field ID {string} satisfies constraint ID {string} of kind {string} in domain {string} with source value {string}', async (fieldId: string, constraintId: string, kind: string, domain: string, sourceValue: string) => runtime.expectFieldConstraintSatisfied(fieldId, constraintId, kind, domain, sourceValue));
  bdd.When('the value for field ID {string} satisfies constraint ID {string} of kind {string} in domain {string}', async (fieldId: string, constraintId: string, kind: string, domain: string) => runtime.expectFieldConstraintSatisfied(fieldId, constraintId, kind, domain));
  bdd.When('field ID {string} on page ID {string} violates constraint ID {string} with {string}', async (fieldId: string, pageId: string, constraintId: string, value: string) => runtime.violateFieldConstraint(fieldId, pageId, constraintId, value));
  bdd.When('field ID {string} on page ID {string} violates constraint ID {string}', async (fieldId: string, pageId: string, constraintId: string) => runtime.violateFieldConstraint(fieldId, pageId, constraintId));
  bdd.Then('{string} with operation IDs {string} should succeed', async (operation: string, ids: string) => runtime.expectOperationSucceeded(operation, splitIds(ids)));
  bdd.Then('page ID {string} named {string} should be displayed', async (pageId: string, page: string) => runtime.expectPageDisplayed(pageId, page));
  bdd.Then('field ID {string} should satisfy its active validation contract', async (fieldId: string) => runtime.expectFieldSatisfiesActiveValidation(fieldId));
  bdd.Then('validation should prevent the page from continuing', async () => runtime.expectValidationBlocksProgress());
}

function splitIds(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}
`;
}
