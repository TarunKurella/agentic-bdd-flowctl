import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactStore } from '../core/artifact-store.js';
import { stableJson } from '../core/stable.js';
import type { ActorRequirements, BehaviorGraph, FlowFamilies, FlowVariants, PageContracts, PathWitnesses } from '../ir/model.js';

export async function generateBdd(store: ArtifactStore, requestedFamily?: string): Promise<string[]> {
  const families = await store.read<FlowFamilies>('families');
  const variants = await store.read<FlowVariants>('variants');
  const behavior = await store.read<BehaviorGraph>('behavior');
  const witnesses = await store.read<PathWitnesses>('witnesses');
  const pages = await store.read<PageContracts>('pages');
  const actors = await store.read<ActorRequirements>('actors');
  const journeyDirectory = path.join(store.generatedDirectory, 'features', 'journeys');
  const contractDirectory = path.join(store.generatedDirectory, 'features', 'page-contracts');
  await fs.mkdir(journeyDirectory, { recursive: true });
  await fs.mkdir(contractDirectory, { recursive: true });
  const generated: string[] = [];
  const stepPlan: Record<string, unknown>[] = [];

  for (const family of families.data.families.filter((candidate) => !requestedFamily || candidate.id === requestedFamily)) {
    const familyVariants = variants.data.variants.filter((variant) => variant.familyId === family.id);
    const lines = [`@source-derived @journey`, `Feature: ${family.label}`, '', `  Successful source-supported variants of ${family.label}.`, ''];
    for (const variant of familyVariants) {
      const witness = witnesses.data.witnesses.find((candidate) => candidate.id === variant.witnessIds[0]);
      if (!witness) throw new Error(`Variant ${variant.id} has no readable path witness.`);
      lines.push(`  @variant:${variant.id}`);
      lines.push(`  Scenario: ${variant.label}`);
      lines.push(`    Given data requirements for "${variant.id}" are satisfied`);
      if (variant.actorRequirementIds.length) {
        const actorLabels = variant.actorRequirementIds.map((id) => actors.data.actors.find((actor) => actor.id === id)?.label ?? id);
        lines.push(`    And an actor satisfying "${actorLabels.join(', ')}" starts the journey`);
      }
      let emittedWhen = false;
      for (const nodeId of witness.nodePath.slice(0, -1)) {
        const behaviorNode = behavior.data.nodes.find((node) => node.id === nodeId);
        if (!behaviorNode) continue;
        if (behaviorNode.kind === 'screen-state') {
          const page = pages.data.pages.find((candidate) => candidate.id === nodeId);
          if (!page?.fields.length) continue;
          lines.push(`    ${emittedWhen ? 'And' : 'When'} the actor completes the "${page.name}" page`);
          emittedWhen = true;
        }
        if (behaviorNode.kind === 'action') {
          lines.push(`    ${emittedWhen ? 'And' : 'When'} the actor performs "${behaviorNode.label}"`);
          emittedWhen = true;
        }
      }
      lines.push(`    Then "${family.label}" should succeed`);
      const successPage = pages.data.pages.find((page) => page.id === variant.pageSequence.at(-1));
      if (successPage) lines.push(`    And the "${successPage.name}" page should be displayed`);
      lines.push('');
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
    const destination = path.join(journeyDirectory, `${family.id}.feature`);
    await fs.writeFile(destination, `${lines.join('\n').trim()}\n`, 'utf8');
    generated.push(destination);
  }

  for (const page of pages.data.pages) {
    if (!page.fields.length) continue;
    const lines = [`@source-derived @page-contract`, `Feature: ${page.name} field contracts`, ''];
    for (const field of page.fields) {
      lines.push(`  Scenario: Provide a valid value for ${field.label ?? field.dataPath}`);
      lines.push(`    Given the actor is on the "${page.name}" page`);
      lines.push(`    When a source-valid value is entered for "${field.dataPath}"`);
      lines.push(`    Then "${field.dataPath}" should satisfy its active validation contract`);
      lines.push('');
      const uniqueConstraints = new Map(field.constraints.map((constraint) => [
        JSON.stringify({ kind: constraint.kind, value: constraint.value }),
        constraint,
      ])).values();
      for (const constraint of uniqueConstraints) {
        lines.push(`  Scenario: Enforce ${constraint.kind} validation for ${field.label ?? field.dataPath}`);
        lines.push(`    Given the actor is on the "${page.name}" page`);
        lines.push(`    When "${field.dataPath}" violates the "${constraint.kind}" constraint${constraint.value !== undefined ? ` "${String(constraint.value)}"` : ''}`);
        lines.push(`    Then validation should prevent the page from continuing`);
        lines.push('');
      }
    }
    const destination = path.join(contractDirectory, `${page.id}.feature`);
    await fs.writeFile(destination, `${lines.join('\n').trim()}\n`, 'utf8');
    generated.push(destination);
  }

  const planPath = path.join(store.generatedDirectory, 'step-plan.json');
  await fs.writeFile(planPath, stableJson({ version: 1, steps: stepPlan }), 'utf8');
  generated.push(planPath);

  const stepsDirectory = path.join(store.generatedDirectory, 'steps');
  await fs.mkdir(stepsDirectory, { recursive: true });
  const stepDefinitionsPath = path.join(stepsDirectory, 'flowctl.steps.generated.ts');
  await fs.writeFile(stepDefinitionsPath, generatedStepDefinitions(), 'utf8');
  generated.push(stepDefinitionsPath);
  return generated;
}

function generatedStepDefinitions(): string {
  return `// Generated by flowctl. Regenerate this file; do not hand-edit it.
export interface FlowRuntime {
  prepareData(variantId: string): Promise<void>;
  startJourney(actorRequirement: string): Promise<void>;
  ensurePageDisplayed(pageName: string): Promise<void>;
  completePage(pageName: string): Promise<void>;
  performAction(actionName: string): Promise<void>;
  expectOperationSucceeded(operationName: string): Promise<void>;
  expectPageDisplayed(pageName: string): Promise<void>;
  enterValidFieldValue(fieldPath: string): Promise<void>;
  violateFieldConstraint(fieldPath: string, constraint: string, value?: string): Promise<void>;
  expectValidationBlocksProgress(): Promise<void>;
}

export interface StepRegistrar {
  Given(pattern: string, implementation: (...args: any[]) => Promise<void>): void;
  When(pattern: string, implementation: (...args: any[]) => Promise<void>): void;
  Then(pattern: string, implementation: (...args: any[]) => Promise<void>): void;
}

export function registerFlowctlSteps(bdd: StepRegistrar, runtime: FlowRuntime): void {
  bdd.Given('data requirements for {string} are satisfied', async (variantId: string) => runtime.prepareData(variantId));
  bdd.Given('an actor satisfying {string} starts the journey', async (actor: string) => runtime.startJourney(actor));
  bdd.Given('the actor is on the {string} page', async (page: string) => runtime.ensurePageDisplayed(page));
  bdd.When('the actor completes the {string} page', async (page: string) => runtime.completePage(page));
  bdd.When('the actor performs {string}', async (action: string) => runtime.performAction(action));
  bdd.When('a source-valid value is entered for {string}', async (field: string) => runtime.enterValidFieldValue(field));
  bdd.When('{string} violates the {string} constraint {string}', async (field: string, constraint: string, value: string) => runtime.violateFieldConstraint(field, constraint, value));
  bdd.When('{string} violates the {string} constraint', async (field: string, constraint: string) => runtime.violateFieldConstraint(field, constraint));
  bdd.Then('{string} should succeed', async (operation: string) => runtime.expectOperationSucceeded(operation));
  bdd.Then('the {string} page should be displayed', async (page: string) => runtime.expectPageDisplayed(page));
  bdd.Then('validation should prevent the page from continuing', async () => runtime.expectValidationBlocksProgress());
}
`;
}
