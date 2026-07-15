import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotSources } from '../src/adapters/source.js';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { loadConfig } from '../src/core/config.js';
import { sha256, stableJson } from '../src/core/stable.js';
import type { ActorRequirements, BehaviorGraph, DataRequirement, FlowVariants, PageContracts, PathWitnesses, RuntimeBindings } from '../src/ir/model.js';
import { compileExecutionPlan } from '../src/runtime/execution-plan.js';
import {
  buildManifestSteps,
  findPendingGroundingManifest,
  prepareGrounding,
  recordGrounding,
  resolveRuntimeValueBindings,
  type GroundingManifest,
  type RuntimeValueBinding,
} from '../src/runtime/grounding.js';
import { loadAdapterManifest } from '../src/runtime/adapters.js';
import { planRuntimeAdapters, verifyRuntimeAdapters } from '../src/runtime/adapter-plan.js';
import { buildRunnerEnvironment, planGroundingRunner, runGrounding } from '../src/runtime/runner.js';
import { readApplicationBindings, readVariantRequirements } from '../src/data/bindings.js';

const environment = 'local';
const variantId = 'application.submit.multi-action';
const actorId = 'actor.operator';
const fieldRequirementId = 'requirement.existing-customer';
const actorRequirementId = 'requirement.operator-identity';
const actorAttributeRequirementId = 'requirement.operator-region';
let sourceDigest: string;

describe('complete runtime interaction grounding', () => {
  let temporaryRoot: string;
  let store: ArtifactStore;
  let runnerObservationTemplate: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-runtime-'));
    const projectRoot = path.join(temporaryRoot, 'account-opening');
    const fixtureRoot = path.resolve('examples/account-opening');
    await fs.cp(fixtureRoot, projectRoot, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(fixtureRoot, source);
        return relative !== '.flowctl' && !relative.startsWith(`.flowctl${path.sep}`);
      },
    });
    await fs.mkdir(path.join(projectRoot, 'runtime'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, 'runtime', 'flowctl-adapters.ts'),
      "export const flowctlAdapters = { 'actor-session': async () => {}, 'screen-probe': async () => {}, 'native-button': async () => {}, 'customer-select': async () => {} };\n",
      'utf8',
    );
    await fs.writeFile(path.join(projectRoot, 'runtime', 'adapters.json'), stableJson({
      version: 1,
      implementation: 'runtime/flowctl-adapters.ts',
      adapters: [
        { id: 'actor-session', targets: ['actor-session'] },
        { id: 'screen-probe', targets: ['screen-state'] },
        { id: 'native-button', targets: ['action'] },
        { id: 'customer-select', targets: ['field'], controlKinds: ['CustomerSelect'] },
      ],
    }), 'utf8');
    const runnerScript = path.join(temporaryRoot, 'fake-grounding-runner.cjs');
    runnerObservationTemplate = path.join(temporaryRoot, 'runner-observation-template.json');
    await fs.writeFile(runnerScript, [
      "const fs = require('node:fs');",
      'const [, , manifest, observation, template] = process.argv;',
      'JSON.parse(fs.readFileSync(manifest, \'utf8\'));',
      'fs.copyFileSync(template, observation);',
      '',
    ].join('\n'), 'utf8');
    const loaded = await loadConfig(path.join(projectRoot, 'flowctl.config.yaml'));
    const runtime = {
      ...loaded.runtime,
      adapterManifest: 'runtime/adapters.json',
      runner: {
        command: process.execPath,
        args: [runnerScript, '{manifest}', '{observation}', runnerObservationTemplate],
        timeoutMs: 30_000,
        envAllowlist: [],
      },
    };
    const base = {
      ...loaded,
      runtime,
      runtimeConfigDigest: sha256(stableJson({
        analysisConfigDigest: loaded.analysisConfigDigest,
        dataConfigDigest: loaded.dataConfigDigest,
        runtime,
      })),
    };
    sourceDigest = (await snapshotSources(base)).digest;
    store = new ArtifactStore(base);
    await store.initialize();
    await writeRuntimeArtifacts(store);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it('rejects an environment label that is not the configured runtime target', async () => {
    await expect(prepareGrounding(store, variantId, 'uat')).rejects.toThrow(/does not match configured runtime\.environment local/i);
    await expect(compileExecutionPlan(store, variantId, 'uat')).rejects.toThrow(/does not match configured runtime\.environment local/i);
  });

  it('blocks preparation until every field and actor identity value is verified', async () => {
    await writeApplicationBindings(store, false);
    await expect(prepareGrounding(store, variantId, environment)).rejects.toThrow(/required application data is not verified.*unverified/i);
  });

  it('blocks runtime readiness clearly when success has no source-supported screen probe', async () => {
    await writeApplicationBindings(store, true);
    const behavior = await store.read<BehaviorGraph>('behavior');
    const witnesses = await store.read<PathWitnesses>('witnesses');
    const terminalBehavior: BehaviorGraph = {
      ...behavior.data,
      nodes: behavior.data.nodes.filter((node) => node.id !== 'page.success'),
      edges: behavior.data.edges.filter((candidate) => candidate.to !== 'page.success'),
      successNodeIds: ['operation.submit'],
    };
    const terminalWitnesses: PathWitnesses = {
      witnesses: witnesses.data.witnesses.map((witness) => ({
        ...witness,
        nodePath: witness.nodePath.filter((id) => id !== 'page.success'),
        edgePath: witness.edgePath.filter((id) => id !== 'edge.6'),
        pageSequence: witness.pageSequence.filter((id) => id !== 'page.success'),
      })),
    };
    await store.write('behavior', store.createEnvelope({ artifactType: 'behavior-graph', producer: 'behavior:build', sourceDigest, data: terminalBehavior }));
    await store.write('witnesses', store.createEnvelope({ artifactType: 'path-witnesses', producer: 'paths:search', sourceDigest, data: terminalWitnesses }));
    await refreshDataRequirementLineage(store);

    await expect(prepareGrounding(store, variantId, environment)).rejects.toThrow(/source flow may still be valid.*operation-response\/outcome runtime probes are not implemented/i);
  });

  it('orders actor setup, screen probes, active fields and actions and binds field value digests', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);

    expect(manifest.sourceDigest).toBe(sourceDigest);
    expect(manifest.witnessId).toBe('witness.multi-action');
    expect(manifest.expectedSuccessScreenId).toBe('page.success');
    expect(manifest.steps).toMatchObject([
      {
        targetKind: 'actor-session', sequence: 1, actorRequirementIds: [actorId],
        actorDataRequirementIds: [actorRequirementId, actorAttributeRequirementId],
        actorDataResolutions: {
          [actorRequirementId]: {
            requirementId: actorRequirementId,
            logicalAlias: 'approved-operator',
            strategy: 'secret-reference',
            secretHandle: 'vault://identities/operator',
          },
          [actorAttributeRequirementId]: {
            requirementId: actorAttributeRequirementId,
            logicalAlias: 'approved-operator-region',
            strategy: 'approved-actor-fixture',
          },
        },
      },
      { targetKind: 'screen-state', sequence: 2, screenId: 'page.start', screenStatePhase: 'entry' },
      { targetKind: 'action', sequence: 3, actionId: 'action.first', screenId: 'page.start', expectedOperationIds: [] },
      { targetKind: 'action', sequence: 4, actionId: 'action.second', screenId: 'page.start', expectedNextScreenId: 'page.middle', expectedOperationIds: [] },
      { targetKind: 'screen-state', sequence: 5, screenId: 'page.middle', screenStatePhase: 'intermediate' },
      {
        targetKind: 'field', sequence: 6, fieldId: 'field.customer', screenId: 'page.middle',
        dataRequirementId: fieldRequirementId, valueAvailability: 'application-value',
      },
      {
        targetKind: 'action', sequence: 7, actionId: 'action.submit', screenId: 'page.middle',
        expectedNextScreenId: 'page.success', expectedOperationIds: ['operation.submit'],
      },
      { targetKind: 'screen-state', sequence: 8, screenId: 'page.success', screenStatePhase: 'success' },
    ]);
    const field = manifest.steps.find((step) => step.targetKind === 'field');
    expect(field).toMatchObject({
      dataRequirementDigest: expect.stringMatching(/^sha256:/),
      valueBindingDigest: expect.stringMatching(/^sha256:/),
      valueResolutionDigest: expect.stringMatching(/^sha256:/),
      valueResolution: {
        source: 'application-data',
        requirementId: fieldRequirementId,
        logicalAlias: 'eligible-customer',
        strategy: 'approved-fixture',
        lookupFile: '.flowctl/application-data.local.yaml',
        lookupKey: fieldRequirementId,
      },
    });
    expect(stableJson(manifest)).not.toContain('CUSTOMER-TEST');
    expect(stableJson(manifest)).toContain('vault://identities/operator');
    expect(stableJson(manifest)).not.toContain('operator-password');
  });

  it('keeps pre-action fields occurrence-specific and treats terminal success fields as probe-only', async () => {
    const behavior: BehaviorGraph = {
      nodes: [
        { id: 'page.a', kind: 'screen-state', label: 'A', attributes: {} },
        { id: 'action.next', kind: 'action', label: 'Next', attributes: {} },
        { id: 'page.b', kind: 'screen-state', label: 'B', attributes: {} },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', attributes: {} },
        { id: 'page.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [
        edge('same.1', 'page.a', 'action.next'),
        edge('same.2', 'action.next', 'page.b'),
        edge('same.3', 'page.b', 'action.submit'),
        edge('same.4', 'action.submit', 'operation.submit'),
        edge('same.5', 'operation.submit', 'page.success', 'success'),
      ],
      entryNodeIds: ['page.a'],
      successNodeIds: ['page.success'],
    };
    const witness: PathWitnesses['witnesses'][number] = {
      id: 'witness.same-path', familyId: 'family.same-path',
      nodePath: ['page.a', 'action.next', 'page.b', 'action.submit', 'operation.submit', 'page.success'],
      edgePath: ['same.1', 'same.2', 'same.3', 'same.4', 'same.5'],
      pageSequence: ['page.a', 'page.b', 'page.success'], actionSequence: ['action.next', 'action.submit'],
      pathCondition: { kind: 'constant', value: true }, assignments: {}, feasibility: 'satisfiable', evidenceRefs: [],
    };
    const variant: FlowVariants['variants'][number] = {
      id: 'variant.same-path', familyId: 'family.same-path', label: 'Same path', witnessIds: [witness.id], behaviorSignature: 'same',
      actorRequirementIds: [], pathCondition: witness.pathCondition, pageSequence: witness.pageSequence, actionSequence: witness.actionSequence,
      operationIds: ['operation.submit'], dataRequirementIds: ['requirement.a', 'requirement.b'], feasibility: 'satisfiable', evidenceRefs: [],
    };
    const pages: PageContracts = { pages: [
      pageWithCustomer('page.a', 'field.a.customer'),
      pageWithCustomer('page.b', 'field.b.customer'),
      pageWithCustomer('page.success', 'field.success.customer'),
    ] };
    const requirements = [
      generatedRequirement('requirement.a', variant.id, 'page.a', 'field.a.customer', 'A'),
      generatedRequirement('requirement.b', variant.id, 'page.b', 'field.b.customer', 'B'),
    ];
    const valueBindings = new Map<string, RuntimeValueBinding>(requirements.map((requirement) => [
      requirement.id,
      generatedValueBinding(requirement),
    ]));
    const steps = buildManifestSteps(variant, witness, behavior, pages, { actors: [] }, requirements, valueBindings, await loadAdapterManifest(store));
    expect(steps.filter((step) => step.targetKind === 'field').map((step) => (
      step.targetKind === 'field' ? [step.screenId, step.fieldId, step.dataRequirementId] : []
    ))).toEqual([
      ['page.a', 'field.a.customer', 'requirement.a'],
      ['page.b', 'field.b.customer', 'requirement.b'],
    ]);
  });

  it('hands a secret requirement to the runner by alias, approved strategy and secret handle only', async () => {
    await writeApplicationBindings(store, true);
    const secretRequirement: DataRequirement = {
      id: 'requirement.field-secret',
      variantId,
      pageId: 'page.middle',
      fieldId: 'field.secret',
      fieldPath: 'accessCode',
      classification: 'secret-reference',
      constraints: [],
      resolutionStrategies: ['corporate-secret-store'],
      status: 'unresolved',
      evidenceRefs: ['field.secret'],
    };
    const applicationData = await readApplicationBindings(store);
    applicationData.bindings[secretRequirement.id] = {
      alias: 'approved-access-code',
      secretRef: 'vault://application/access-code',
      resolver: 'corporate-secret-store',
      requirementDigest: sha256(stableJson(secretRequirement)),
      verified: true,
      confirmation: { reviewer: 'runtime-test', confirmedAt: '2026-07-15T00:00:00.000Z' },
    };
    await fs.writeFile(store.applicationDataFile, stringifyYaml(applicationData), 'utf8');

    const resolution = (await resolveRuntimeValueBindings(store, [secretRequirement])).get(secretRequirement.id)!;
    expect(resolution.valueAvailability).toBe('secret-reference');
    expect(resolution.valueResolution).toEqual({
      source: 'application-data',
      requirementId: secretRequirement.id,
      logicalAlias: 'approved-access-code',
      strategy: 'corporate-secret-store',
      lookupFile: '.flowctl/application-data.local.yaml',
      lookupKey: secretRequirement.id,
      secretHandle: 'vault://application/access-code',
    });
    expect(resolution.valueResolutionDigest).toMatch(/^sha256:/);
    expect(resolution.valueResolution).not.toHaveProperty('value');
  });

  it('hands a statically enumerated runtime option to the runner as a canonical representative', async () => {
    const requirement: DataRequirement = {
      id: 'requirement.static-product',
      variantId,
      pageId: 'page.middle',
      fieldId: 'field.product',
      fieldPath: 'productCode',
      classification: 'runtime-option',
      representativeValue: 'EVERYDAY',
      constraints: [{
        id: 'constraint.product-options', fieldPath: 'productCode', kind: 'enum', domain: 'value-set',
        value: ['EVERYDAY'], sourceRef: { file: 'ProductSelect.tsx', line: 1 },
      }],
      resolutionStrategies: ['runtime-option-provider'],
      status: 'generated',
      evidenceRefs: ['field.product'],
    };

    const resolution = (await resolveRuntimeValueBindings(store, [requirement])).get(requirement.id)!;
    expect(resolution).toMatchObject({
      valueAvailability: 'representative-value',
      valueResolution: {
        source: 'canonical-representative',
        requirementId: requirement.id,
        strategy: 'runtime-option-provider',
      },
    });
  });

  it('produces an actionable adapter scaffold, exact target inventory and validation gate', async () => {
    const plan = await planRuntimeAdapters(store, variantId);
    expect(plan.targets.map((target) => target.targetKind)).toEqual(expect.arrayContaining([
      'actor-session', 'screen-state', 'field', 'action',
    ]));
    expect(plan.targets.find((target) => target.targetKind === 'actor-session')).toMatchObject({
      dataRequirementIds: [actorRequirementId, actorAttributeRequirementId],
    });
    expect(plan.targets.find((target) => target.targetKind === 'field')).toMatchObject({
      targetId: 'field.customer',
      controlKind: 'CustomerSelect',
      dataRequirementIds: [fieldRequirementId],
    });
    expect(plan.targets).not.toContainEqual(expect.objectContaining({
      targetKind: 'field',
      targetId: 'field.success.customer',
    }));
    expect(await fs.readFile(plan.scaffoldImplementationPath, 'utf8')).toContain("'flowctl-actor-session': undefined");
    expect(plan.validationCommand).toContain('ground adapters verify');
    await expect(verifyRuntimeAdapters(store, variantId)).resolves.toMatchObject({ valid: true });
  });

  it('scaffolds the no-shell external runner protocol with both path placeholders', async () => {
    const plan = await planGroundingRunner(store);
    expect(plan.configTemplate.runtime.runner.args).toEqual([
      '--manifest', '{manifest}', '--observation', '{observation}',
    ]);
    expect(plan.configTemplate.runtime.runner.envAllowlist).toEqual([]);
    expect(plan.protocol.join(' ')).toMatch(/shell disabled/i);
    expect(plan.protocol.join(' ')).toMatch(/minimal OS\/runtime variables.*explicitly approved/i);
    expect(await fs.readFile(plan.scaffoldPath, 'utf8')).toContain('{observation}');
  });

  it('passes only minimal runtime variables and explicitly allowlisted names to the runner', () => {
    const runnerEnvironment = buildRunnerEnvironment(['FLOWCTL_APPROVED_RUNNER_SETTING'], {
      PATH: '/approved/bin',
      HOME: '/approved/home',
      FLOWCTL_APPROVED_RUNNER_SETTING: 'approved',
      NODE_OPTIONS: '--require=/tmp/unapproved-hook.cjs',
      GITHUB_TOKEN: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
      APPLICATION_CUSTOMER_ID: 'application-data-does-not-belong-here',
    });

    expect(runnerEnvironment).toEqual({
      PATH: '/approved/bin',
      HOME: '/approved/home',
      FLOWCTL_APPROVED_RUNNER_SETTING: 'approved',
    });
  });

  it('does not silently reuse one field value across repeated visits to the same screen', async () => {
    const behavior: BehaviorGraph = {
      nodes: [
        { id: 'page.repeat', kind: 'screen-state', label: 'Repeat', attributes: {} },
        { id: 'action.again', kind: 'action', label: 'Again', attributes: {} },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', attributes: {} },
        { id: 'page.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [
        edge('repeat.1', 'page.repeat', 'action.again'),
        edge('repeat.2', 'action.again', 'page.repeat'),
        edge('repeat.3', 'page.repeat', 'action.submit'),
        edge('repeat.4', 'action.submit', 'operation.submit'),
        edge('repeat.5', 'operation.submit', 'page.success', 'success'),
      ],
      entryNodeIds: ['page.repeat'], successNodeIds: ['page.success'],
    };
    const witness: PathWitnesses['witnesses'][number] = {
      id: 'witness.repeat', familyId: 'family.repeat',
      nodePath: ['page.repeat', 'action.again', 'page.repeat', 'action.submit', 'operation.submit', 'page.success'],
      edgePath: ['repeat.1', 'repeat.2', 'repeat.3', 'repeat.4', 'repeat.5'],
      pageSequence: ['page.repeat', 'page.repeat', 'page.success'], actionSequence: ['action.again', 'action.submit'],
      pathCondition: { kind: 'constant', value: true }, assignments: {}, feasibility: 'satisfiable', evidenceRefs: [],
    };
    const requirement = generatedRequirement('requirement.repeat', 'variant.repeat', 'page.repeat', 'field.repeat.customer', 'A');
    const variant: FlowVariants['variants'][number] = {
      id: 'variant.repeat', familyId: witness.familyId, label: 'Repeat', witnessIds: [witness.id], behaviorSignature: 'repeat',
      actorRequirementIds: [], pathCondition: witness.pathCondition, pageSequence: witness.pageSequence, actionSequence: witness.actionSequence,
      operationIds: ['operation.submit'], dataRequirementIds: [requirement.id], feasibility: 'satisfiable', evidenceRefs: [],
    };
    const value = generatedValueBinding(requirement);
    const adapters = await loadAdapterManifest(store);
    expect(() => buildManifestSteps(
      variant,
      witness,
      behavior,
      { pages: [
        pageWithCustomer('page.repeat', 'field.repeat.customer'),
        { id: 'page.success', name: 'Success', routePatterns: ['/success'], fields: [], actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [] },
      ] },
      { actors: [] },
      [requirement],
      new Map([[requirement.id, value]]),
      adapters,
    )).toThrow(/visit-specific value contracts are not implemented/i);
  });

  it('does not demand values or field adapters for read-only controls and blocks conditional writability', async () => {
    const behavior: BehaviorGraph = {
      nodes: [
        { id: 'page.mode', kind: 'screen-state', label: 'Mode', attributes: {} },
        { id: 'action.mode-submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.mode-submit', kind: 'operation', label: 'Submit', attributes: {} },
        { id: 'page.mode-success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [
        edge('mode.1', 'page.mode', 'action.mode-submit'),
        edge('mode.2', 'action.mode-submit', 'operation.mode-submit'),
        edge('mode.3', 'operation.mode-submit', 'page.mode-success', 'success'),
      ],
      entryNodeIds: ['page.mode'],
      successNodeIds: ['page.mode-success'],
    };
    const witness: PathWitnesses['witnesses'][number] = {
      id: 'witness.mode', familyId: 'family.mode',
      nodePath: ['page.mode', 'action.mode-submit', 'operation.mode-submit', 'page.mode-success'],
      edgePath: ['mode.1', 'mode.2', 'mode.3'], pageSequence: ['page.mode', 'page.mode-success'],
      actionSequence: ['action.mode-submit'], pathCondition: { kind: 'constant', value: true }, assignments: {},
      feasibility: 'satisfiable', evidenceRefs: [],
    };
    const variant: FlowVariants['variants'][number] = {
      id: 'variant.mode', familyId: witness.familyId, label: 'Mode', witnessIds: [witness.id], behaviorSignature: 'mode',
      actorRequirementIds: [], pathCondition: witness.pathCondition, pageSequence: witness.pageSequence,
      actionSequence: witness.actionSequence, operationIds: ['operation.mode-submit'], dataRequirementIds: [],
      feasibility: 'satisfiable', evidenceRefs: [],
    };
    const modePage = pageWithCustomer('page.mode', 'field.mode');
    modePage.fields[0]!.inputMode = 'read-only';
    const successPage: PageContracts['pages'][number] = {
      id: 'page.mode-success', name: 'Success', routePatterns: ['/success'], fields: [], actions: [], entryConditions: [],
      completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [],
    };
    const adapters = await loadAdapterManifest(store);
    const readOnlySteps = buildManifestSteps(
      variant, witness, behavior, { pages: [modePage, successPage] }, { actors: [] }, [], new Map(), adapters,
    );
    expect(readOnlySteps.some((step) => step.targetKind === 'field')).toBe(false);

    modePage.fields[0]!.inputMode = 'conditional';
    expect(() => buildManifestSteps(
      variant, witness, behavior, { pages: [modePage, successPage] }, { actors: [] }, [], new Map(), adapters,
    )).toThrow(/input mode is conditional.*cannot prove.*write/i);
  });

  it('does not collapse multiple actor contracts into one implicit session', async () => {
    const [behavior, witnesses, variants, pages] = await Promise.all([
      store.read<BehaviorGraph>('behavior'),
      store.read<PathWitnesses>('witnesses'),
      store.read<FlowVariants>('variants'),
      store.read<PageContracts>('pages'),
    ]);
    const variant = { ...variants.data.variants[0]!, actorRequirementIds: ['actor.one', 'actor.two'] };
    const actors: ActorRequirements = { actors: ['actor.one', 'actor.two'].map((id) => ({
      id,
      authentication: 'required' as const,
      authoritiesAll: [], rolesAll: [], attributePredicates: [], relationships: [], label: id, evidenceRefs: [],
    })) };
    const adapters = await loadAdapterManifest(store);
    expect(() => buildManifestSteps(
      variant,
      witnesses.data.witnesses[0]!,
      behavior.data,
      pages.data,
      actors,
      [],
      new Map(),
      adapters,
    )).toThrow(/multi-actor session scheduling is not implemented/i);
  });

  it('blocks actor-session grounding when actor data is not scoped by actorRequirementId', async () => {
    const [behavior, witnesses, variants, pages, actors, requirements] = await Promise.all([
      store.read<BehaviorGraph>('behavior'),
      store.read<PathWitnesses>('witnesses'),
      store.read<FlowVariants>('variants'),
      store.read<PageContracts>('pages'),
      store.read<ActorRequirements>('actors'),
      readVariantRequirements(store, variantId),
    ]);
    const orphan: DataRequirement = {
      id: 'requirement.orphan-actor-attribute',
      variantId,
      fieldPath: 'actor.region',
      classification: 'actor-attribute',
      expectedValue: 'IN',
      constraints: [],
      resolutionStrategies: ['approved-actor-fixture'],
      status: 'unresolved',
      evidenceRefs: [],
    };
    const adapters = await loadAdapterManifest(store);
    expect(() => buildManifestSteps(
      variants.data.variants[0]!,
      witnesses.data.witnesses[0]!,
      behavior.data,
      pages.data,
      actors.data,
      [...requirements, orphan],
      new Map(),
      adapters,
    )).toThrow(/requires actorRequirementId.*orphan-actor-attribute/i);
  });

  it('finds and resumes the newest valid grounding manifest instead of preparing another one', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);

    const pending = await findPendingGroundingManifest(store, variantId, environment);
    expect(pending).toMatchObject({
      runId: manifest.runId,
      manifestDigest: manifest.manifestDigest,
      observationExists: false,
      stepCount: manifest.steps.length,
    });
    await fs.writeFile(pending!.observationPath, stableJson(completeObservation(manifest)), 'utf8');
    expect(await findPendingGroundingManifest(store, variantId, environment)).toMatchObject({
      runId: manifest.runId,
      observationExists: true,
    });
  });

  it('rejects empty, partial and out-of-order observations', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    const complete = completeObservation(manifest);

    const empty = await writeObservation(temporaryRoot, 'empty.json', { ...complete, observations: [] });
    await expect(recordGrounding(store, manifest.runId, empty)).rejects.toThrow();

    const partial = await writeObservation(temporaryRoot, 'partial.json', { ...complete, observations: complete.observations.slice(0, 2) });
    await expect(recordGrounding(store, manifest.runId, partial)).rejects.toThrow(/partial: expected 8 ordered observations, received 2/i);

    const reordered = [complete.observations[1]!, complete.observations[0]!, ...complete.observations.slice(2)];
    const outOfOrder = await writeObservation(temporaryRoot, 'out-of-order.json', { ...complete, observations: reordered });
    await expect(recordGrounding(store, manifest.runId, outOfOrder)).rejects.toThrow(/must ground actor-session/i);
  });

  it('rejects a hand-edited field value-binding digest', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    const complete = completeObservation(manifest);
    const field = complete.observations.find((item) => item.targetKind === 'field')!;
    field.valueBindingDigest = sha256('different-value');
    const destination = await writeObservation(temporaryRoot, 'wrong-value.json', complete);
    await expect(recordGrounding(store, manifest.runId, destination)).rejects.toThrow(/exact requirement and value-binding digests/i);
  });

  it('rejects raw resolved values in runtime observations', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    const complete = completeObservation(manifest);
    const field = complete.observations.find((item) => item.targetKind === 'field')!;
    field.resolvedValue = 'CUSTOMER-TEST';
    const destination = await writeObservation(temporaryRoot, 'raw-observation-value.json', complete);
    await expect(recordGrounding(store, manifest.runId, destination)).rejects.toThrow();
  });

  it('requires every declared adapter to have a static callable implementation', async () => {
    const manifestPath = path.join(store.config.projectRoot, 'runtime', 'adapters.json');
    const declared = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { adapters: Array<Record<string, unknown>> };
    declared.adapters.push({ id: 'missing-screen-implementation', targets: ['screen-state'] });
    await fs.writeFile(manifestPath, stableJson(declared), 'utf8');
    await writeApplicationBindings(store, true);
    await expect(prepareGrounding(store, variantId, environment)).rejects.toThrow(/missing callable adapter.*missing-screen-implementation/i);
  });

  it('invalidates a prepared manifest when adapter implementation bytes change', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    await fs.appendFile(path.join(store.config.projectRoot, 'runtime', 'flowctl-adapters.ts'), '\n// changed after prepare\n', 'utf8');
    const destination = await writeObservation(temporaryRoot, 'adapter-stale.json', completeObservation(manifest));
    await expect(recordGrounding(store, manifest.runId, destination)).rejects.toThrow(/adapter manifest or implementation changed/i);
  });

  it('rejects observations from another environment or a stale source manifest', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    const complete = completeObservation(manifest);
    const wrongEnvironment = await writeObservation(temporaryRoot, 'wrong-environment.json', { ...complete, environment: 'other-environment' });
    await expect(recordGrounding(store, manifest.runId, wrongEnvironment)).rejects.toThrow(/does not match manifest environment/i);

    const behavior = await store.read<BehaviorGraph>('behavior');
    await store.write('behavior', store.createEnvelope({
      artifactType: 'behavior-graph',
      producer: 'behavior:build',
      sourceDigest: sha256('changed-runtime-grounding-source'),
      data: behavior.data,
    }));
    const stale = await writeObservation(temporaryRoot, 'stale.json', complete);
    await expect(recordGrounding(store, manifest.runId, stale)).rejects.toThrow(/stale or inconsistent/i);
  });

  it('records every target and produces only a ready-for-playwright-run plan', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    const observationFile = await writeObservation(temporaryRoot, 'complete.json', completeObservation(manifest));

    const runtime = await recordGrounding(store, manifest.runId, observationFile);
    expect(runtime.bindings.map((binding) => binding.targetKind)).toEqual([
      'actor-session', 'screen-state', 'action', 'action', 'screen-state', 'field', 'action', 'screen-state',
    ]);
    expect(runtime.bindings.every((binding) => (
      binding.groundingRunId === manifest.runId
      && binding.groundingManifestDigest === manifest.manifestDigest
      && binding.observationProducer === 'flowctl-playwright-adapter-runner'
    ))).toBe(true);
    const { plan } = await compileExecutionPlan(store, variantId, environment);
    expect(plan.readiness).toBe('ready-for-playwright-run');
    expect(plan.missingRuntimeTargets).toEqual([]);
    expect(plan.steps).toHaveLength(8);
    expect(plan.steps.every((step) => step.runtimeBindingId)).toBe(true);
    expect(plan.steps.every((step) => step.runtimeAdapterId && step.permittedAdapterIds.includes(step.runtimeAdapterId))).toBe(true);
    expect(plan.rules.join(' ')).toMatch(/not evidence that the run happened or passed/i);
  });

  it('executes the configured no-shell runner and records its validated observation', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    await fs.writeFile(runnerObservationTemplate, stableJson(completeObservation(manifest)), 'utf8');

    const result = await runGrounding(store, manifest.runId);
    expect(result).toMatchObject({
      runId: manifest.runId,
      variantId,
      environment,
      recordedBindings: manifest.steps.length,
    });
    expect((await store.read<RuntimeBindings>('runtime')).data.bindings).toHaveLength(manifest.steps.length);
  });

  it('does not reuse recorded bindings after the configured runtime target changes', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    const observation = await writeObservation(temporaryRoot, 'runtime-change-observation.json', completeObservation(manifest));
    await recordGrounding(store, manifest.runId, observation);

    store.config.runtime.baseUrl = 'http://localhost:4000';
    store.config.runtimeConfigDigest = sha256(stableJson({ changedRuntimeTarget: true }));
    const { plan } = await compileExecutionPlan(store, variantId, environment);

    expect(plan.readiness).toBe('blocked-runtime');
    expect(plan.steps.every((step) => !step.runtimeBindingId)).toBe(true);
  });

  it('removes a runner observation that attempts to persist a resolved value', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    const observation = completeObservation(manifest);
    observation.observations.find((item) => item.targetKind === 'field')!.resolvedValue = 'CUSTOMER-TEST';
    await fs.writeFile(runnerObservationTemplate, stableJson(observation), 'utf8');

    await expect(runGrounding(store, manifest.runId)).rejects.toThrow(/observation was rejected and removed/i);
    await expect(fs.access(path.join(store.workDirectory, 'runtime', `${manifest.runId}.observation.json`))).rejects.toThrow();
  });

  it('returns a bounded runner stderr tail when the external process fails', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    const failureScript = path.join(temporaryRoot, 'failing-grounding-runner.cjs');
    await fs.writeFile(failureScript, "console.error('selector target was not actionable'); process.exit(17);\n", 'utf8');
    store.config.runtime.runner = {
      command: process.execPath,
      args: [failureScript, '{manifest}', '{observation}'],
      timeoutMs: 30_000,
      envAllowlist: [],
    };

    await expect(runGrounding(store, manifest.runId)).rejects.toThrow(/code 17.*stderr tail.*selector target was not actionable/is);
  });

  it('does not launder bindings whose upstream artifact lineage differs', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    await store.write('runtime', store.createEnvelope({
      artifactType: 'runtime-bindings',
      producer: 'runtime:record',
      sourceDigest,
      inputDigests: { behavior: sha256('old-behavior') },
      status: 'grounded',
      data: {
        bindings: [{
          id: 'runtime-binding.stale',
          witnessId: 'another-witness',
          sequence: 1,
          groundingRunId: 'old-run',
          groundingManifestDigest: sha256('old-manifest'),
          observationProducer: 'flowctl-playwright-adapter-runner',
          targetKind: 'action',
          actionId: 'action.stale',
          screenId: 'page.stale',
          environment,
          locator: { strategy: 'test-id', value: 'stale' },
          componentAdapter: 'native-button',
          adapterManifestDigest: manifest.adapterManifestDigest,
          unique: true,
          actionable: true,
          evidenceRefs: [],
        }],
      },
    }));
    const destination = await writeObservation(temporaryRoot, 'fresh-over-stale.json', completeObservation(manifest));
    const recorded = await recordGrounding(store, manifest.runId, destination);
    expect(recorded.bindings).toHaveLength(manifest.steps.length);
    expect(recorded.bindings.some((binding) => binding.id === 'runtime-binding.stale')).toBe(false);
  });

  it('keeps the plan blocked when even one success-screen binding is absent', async () => {
    await writeApplicationBindings(store, true);
    const manifest = await prepareAndReadManifest(store);
    const observationFile = await writeObservation(temporaryRoot, 'complete-for-removal.json', completeObservation(manifest));
    await recordGrounding(store, manifest.runId, observationFile);
    const runtime = await store.read<RuntimeBindings>('runtime');
    await store.write('runtime', store.createEnvelope({
      artifactType: 'runtime-bindings',
      producer: 'runtime:record',
      sourceDigest: runtime.meta.sourceDigest,
      inputDigests: runtime.meta.inputDigests,
      status: 'grounded',
      data: { bindings: runtime.data.bindings.filter((binding) => binding.screenStatePhase !== 'success') },
    }));

    const { plan } = await compileExecutionPlan(store, variantId, environment);
    expect(plan.readiness).toBe('blocked-runtime');
    expect(plan.missingScreenStateBindings).toEqual(['screen-state:success:page.success']);
    expect(plan.missingRuntimeTargets).toContain('screen-state:success:page.success');
  });
});

async function writeRuntimeArtifacts(store: ArtifactStore): Promise<void> {
  const behavior: BehaviorGraph = {
    nodes: [
      { id: 'page.start', kind: 'screen-state', label: 'Start', attributes: {} },
      { id: 'action.first', kind: 'action', label: 'First action', attributes: {} },
      { id: 'action.second', kind: 'action', label: 'Second action', attributes: {} },
      { id: 'page.middle', kind: 'screen-state', label: 'Middle', attributes: {} },
      { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
      { id: 'operation.submit', kind: 'operation', label: 'Submit operation', attributes: {} },
      { id: 'page.success', kind: 'screen-state', label: 'Success', attributes: {} },
    ],
    edges: [
      edge('edge.1', 'page.start', 'action.first'),
      edge('edge.2', 'action.first', 'action.second'),
      edge('edge.3', 'action.second', 'page.middle'),
      edge('edge.4', 'page.middle', 'action.submit'),
      edge('edge.5', 'action.submit', 'operation.submit'),
      edge('edge.6', 'operation.submit', 'page.success', 'success'),
    ],
    entryNodeIds: ['page.start'],
    successNodeIds: ['page.success'],
  };
  const witnesses: PathWitnesses = { witnesses: [{
    id: 'witness.multi-action',
    familyId: 'application.submit',
    nodePath: ['page.start', 'action.first', 'action.second', 'page.middle', 'action.submit', 'operation.submit', 'page.success'],
    edgePath: ['edge.1', 'edge.2', 'edge.3', 'edge.4', 'edge.5', 'edge.6'],
    pageSequence: ['page.start', 'page.middle', 'page.success'],
    actionSequence: ['action.first', 'action.second', 'action.submit'],
    pathCondition: { kind: 'constant', value: true },
    assignments: {},
    feasibility: 'satisfiable',
    evidenceRefs: [],
  }] };
  const variants: FlowVariants = { variants: [{
    id: variantId,
    familyId: 'application.submit',
    label: 'Submit a multi-action application',
    witnessIds: ['witness.multi-action'],
    behaviorSignature: 'multi-action',
    actorRequirementIds: [actorId],
    pathCondition: { kind: 'constant', value: true },
    pageSequence: ['page.start', 'page.middle', 'page.success'],
    actionSequence: ['action.first', 'action.second', 'action.submit'],
    operationIds: ['operation.submit'],
    dataRequirementIds: [fieldRequirementId, actorRequirementId, actorAttributeRequirementId],
    feasibility: 'satisfiable',
    evidenceRefs: [],
  }] };
  const actors: ActorRequirements = { actors: [{
    id: actorId,
    authentication: 'required',
    authoritiesAll: ['APPLICATION_WRITE'],
    rolesAll: [],
    attributePredicates: [],
    relationships: [],
    label: 'application operator',
    evidenceRefs: ['permission.application-write'],
  }] };
  const pages: PageContracts = { pages: [{
    id: 'page.start', name: 'Start', routePatterns: ['/start'], fields: [], actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [],
  }, {
    id: 'page.middle', name: 'Middle', routePatterns: ['/middle'], actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: ['field.customer'],
    fields: [{
      id: 'field.customer', pageId: 'page.middle', dataPath: 'customerId', label: 'Customer', controlKind: 'CustomerSelect',
      visibleWhen: [{ kind: 'constant', value: true }], requiredWhen: [{ kind: 'constant', value: true }], constraints: [],
      sourceRef: { file: 'Middle.tsx', line: 1 },
    }],
  }, pageWithCustomer('page.success', 'field.success.customer')] };
  const runtime: RuntimeBindings = { bindings: [] };

  await store.write('behavior', store.createEnvelope({ artifactType: 'behavior-graph', producer: 'behavior:build', sourceDigest, data: behavior }));
  await store.write('witnesses', store.createEnvelope({ artifactType: 'path-witnesses', producer: 'paths:search', sourceDigest, data: witnesses }));
  await store.write('variants', store.createEnvelope({ artifactType: 'flow-variants', producer: 'variants:reduce', sourceDigest, data: variants }));
  await store.write('pages', store.createEnvelope({ artifactType: 'page-contracts', producer: 'pages:build', sourceDigest, data: pages }));
  await store.write('actors', store.createEnvelope({ artifactType: 'actor-requirements', producer: 'actors:build', sourceDigest, data: actors }));
  await store.write('runtime', store.createEnvelope({ artifactType: 'runtime-bindings', producer: 'runtime:initialize', sourceDigest, data: runtime }));

  const [variantsEnvelope, witnessesEnvelope, behaviorEnvelope, pagesEnvelope, actorsEnvelope] = await Promise.all([
    store.read<FlowVariants>('variants'),
    store.read<PathWitnesses>('witnesses'),
    store.read<BehaviorGraph>('behavior'),
    store.read<PageContracts>('pages'),
    store.read<ActorRequirements>('actors'),
  ]);
  const dataEnvelope = store.createEnvelope({
    artifactType: 'data-requirements',
    producer: 'data:plan',
    sourceDigest,
    inputDigests: {
      variants: variantsEnvelope.meta.contentDigest,
      witnesses: witnessesEnvelope.meta.contentDigest,
      behavior: behaviorEnvelope.meta.contentDigest,
      pages: pagesEnvelope.meta.contentDigest,
      actors: actorsEnvelope.meta.contentDigest,
    },
    data: {
      variantId,
      requirements: [{
        id: fieldRequirementId,
        variantId,
        pageId: 'page.middle',
        fieldId: 'field.customer',
        fieldPath: 'customerId',
        classification: 'existing-entity',
        constraints: [],
        resolutionStrategies: ['approved-fixture'],
        status: 'unresolved',
        evidenceRefs: [],
      }, {
        id: actorRequirementId,
        variantId,
        actorRequirementId: actorId,
        fieldPath: 'actor.principal',
        classification: 'authenticated-identity',
        constraints: [],
        resolutionStrategies: ['secret-reference'],
        status: 'unresolved',
        evidenceRefs: [],
      }, {
        id: actorAttributeRequirementId,
        variantId,
        actorRequirementId: actorId,
        fieldPath: 'actor.region',
        classification: 'actor-attribute',
        expectedValue: 'IN',
        constraints: [],
        resolutionStrategies: ['approved-actor-fixture'],
        status: 'unresolved',
        evidenceRefs: ['actor.region'],
      }],
    },
  });
  await fs.writeFile(path.join(store.dataRequirementsDirectory, `${variantId}.yaml`), stringifyYaml(dataEnvelope), 'utf8');
}

async function writeApplicationBindings(store: ArtifactStore, verified: boolean): Promise<void> {
  const requirements = await readVariantRequirements(store, variantId);
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const confirmation = verified ? { confirmation: { reviewer: 'runtime-test', confirmedAt: '2026-07-15T00:00:00.000Z' } } : {};
  await fs.writeFile(store.applicationDataFile, stringifyYaml({
    version: 1,
    application: store.config.project.name,
    bindings: {
      [fieldRequirementId]: {
        alias: 'eligible-customer',
        value: 'CUSTOMER-TEST',
        resolver: 'approved-fixture',
        requirementDigest: sha256(stableJson(byId.get(fieldRequirementId))),
        verified,
        ...confirmation,
      },
      [actorRequirementId]: {
        alias: 'approved-operator',
        secretRef: 'vault://identities/operator',
        resolver: 'secret-reference',
        requirementDigest: sha256(stableJson(byId.get(actorRequirementId))),
        verified,
        ...confirmation,
      },
      [actorAttributeRequirementId]: {
        alias: 'approved-operator-region',
        value: 'IN',
        resolver: 'approved-actor-fixture',
        requirementDigest: sha256(stableJson(byId.get(actorAttributeRequirementId))),
        verified,
        ...confirmation,
      },
    },
  }), 'utf8');
}

async function refreshDataRequirementLineage(store: ArtifactStore): Promise<void> {
  const destination = path.join(store.dataRequirementsDirectory, `${variantId}.yaml`);
  const current = parseYaml(await fs.readFile(destination, 'utf8')) as { data: { variantId: string; requirements: DataRequirement[] } };
  const [variants, witnesses, behavior, pages, actors] = await Promise.all([
    store.read<FlowVariants>('variants'),
    store.read<PathWitnesses>('witnesses'),
    store.read<BehaviorGraph>('behavior'),
    store.read<PageContracts>('pages'),
    store.read<ActorRequirements>('actors'),
  ]);
  const envelope = store.createEnvelope({
    artifactType: 'data-requirements',
    producer: 'data:plan',
    sourceDigest,
    inputDigests: {
      variants: variants.meta.contentDigest,
      witnesses: witnesses.meta.contentDigest,
      behavior: behavior.meta.contentDigest,
      pages: pages.meta.contentDigest,
      actors: actors.meta.contentDigest,
    },
    data: current.data,
  });
  await fs.writeFile(destination, stringifyYaml(envelope), 'utf8');
}

async function prepareAndReadManifest(store: ArtifactStore): Promise<GroundingManifest> {
  const prepared = await prepareGrounding(store, variantId, environment);
  return JSON.parse(await fs.readFile(prepared.path, 'utf8')) as GroundingManifest;
}

function completeObservation(manifest: GroundingManifest): { runId: string; manifestDigest: string; adapterManifestDigest: string; producer: string; environment: string; observations: Array<Record<string, unknown>> } {
  return {
    runId: manifest.runId,
    manifestDigest: manifest.manifestDigest,
    adapterManifestDigest: manifest.adapterManifestDigest,
    producer: 'flowctl-playwright-adapter-runner',
    environment: manifest.environment,
    observations: manifest.steps.map((step): Record<string, unknown> => {
      const evidenceRefs = [`runtime:${manifest.runId}`];
      if (step.targetKind === 'actor-session') return {
        targetKind: step.targetKind,
        actorRequirementIds: step.actorRequirementIds,
        actorRequirementsDigest: step.actorRequirementsDigest,
        identityBindingDigests: step.identityBindingDigests,
        actorDataRequirementIds: step.actorDataRequirementIds,
        actorDataBindingDigests: step.actorDataBindingDigests,
        actorDataResolutionDigests: step.actorDataResolutionDigests,
        componentAdapter: 'actor-session',
        probe: { sessionEstablished: true },
        evidenceRefs,
      };
      if (step.targetKind === 'screen-state') return {
        targetKind: step.targetKind,
        screenId: step.screenId,
        screenStatePhase: step.screenStatePhase,
        locator: { strategy: 'test-id', value: step.screenId },
        componentAdapter: 'screen-probe',
        unique: true,
        probe: { matchCount: 1, visible: true },
        evidenceRefs,
      };
      if (step.targetKind === 'field') return {
        targetKind: step.targetKind,
        screenId: step.screenId,
        fieldId: step.fieldId,
        dataRequirementId: step.dataRequirementId,
        dataRequirementDigest: step.dataRequirementDigest,
        valueBindingDigest: step.valueBindingDigest,
        valueAvailability: step.valueAvailability,
        valueResolutionDigest: step.valueResolutionDigest,
        locator: { strategy: 'label', name: 'Customer' },
        componentAdapter: 'customer-select',
        unique: true,
        actionable: true,
        probe: { matchCount: 1, visible: true, enabled: true, writable: true, valueAvailable: true, valueAccepted: true },
        evidenceRefs,
      };
      return {
        targetKind: step.targetKind,
        screenId: step.screenId,
        actionId: step.actionId,
        locator: { strategy: 'role-and-name', role: 'button', name: step.actionLabel },
        componentAdapter: 'native-button',
        unique: true,
        actionable: true,
        probe: { matchCount: 1, visible: true, enabled: true },
        ...(step.expectedOperationIds[0] ? { observedOperationId: step.expectedOperationIds[0] } : {}),
        ...(step.expectedNextScreenId ? { observedNextStateId: step.expectedNextScreenId } : {}),
        evidenceRefs,
      };
    }),
  };
}

async function writeObservation(root: string, name: string, value: unknown): Promise<string> {
  const destination = path.join(root, name);
  await fs.writeFile(destination, stableJson(value), 'utf8');
  return destination;
}

function edge(id: string, from: string, to: string, outcome: 'neutral' | 'success' = 'neutral'): BehaviorGraph['edges'][number] {
  return {
    id,
    from,
    to,
    guard: { kind: 'constant', value: true },
    effects: [],
    outcome,
    evidenceRefs: [id],
  };
}

function pageWithCustomer(pageId: string, fieldId: string): PageContracts['pages'][number] {
  return {
    id: pageId,
    name: pageId,
    routePatterns: [`/${pageId}`],
    actions: [],
    entryConditions: [],
    completeness: 'exact',
    unresolvedChildComponentRefs: [],
    evidenceRefs: [fieldId],
    fields: [{
      id: fieldId,
      pageId,
      dataPath: 'customerId',
      label: 'Customer',
      controlKind: 'CustomerSelect',
      visibleWhen: [{ kind: 'constant', value: true }],
      requiredWhen: [{ kind: 'constant', value: true }],
      constraints: [],
      sourceRef: { file: `${pageId}.tsx`, line: 1 },
    }],
  };
}

function generatedRequirement(
  id: string,
  variantId: string,
  pageId: string,
  fieldId: string,
  representativeValue: string,
): DataRequirement {
  return {
    id,
    variantId,
    pageId,
    fieldId,
    fieldPath: 'customerId',
    classification: 'flow-literal',
    representativeValue,
    constraints: [],
    resolutionStrategies: ['path-assignment'],
    status: 'generated',
    evidenceRefs: [fieldId],
  };
}

function generatedValueBinding(requirement: DataRequirement): RuntimeValueBinding {
  const valueResolution = {
    source: 'canonical-representative' as const,
    requirementId: requirement.id,
    logicalAlias: `source-derived:${requirement.id}`,
    strategy: requirement.resolutionStrategies[0]!,
    lookupFile: `.flowctl/artifacts/data-requirements/${requirement.variantId}.yaml`,
    lookupKey: requirement.id,
  };
  return {
    dataRequirementId: requirement.id,
    dataRequirementDigest: sha256(stableJson(requirement)),
    valueBindingDigest: sha256(stableJson({ requirement: requirement.id, value: requirement.representativeValue })),
    valueAvailability: 'representative-value',
    valueResolution,
    valueResolutionDigest: sha256(stableJson(valueResolution)),
  };
}
