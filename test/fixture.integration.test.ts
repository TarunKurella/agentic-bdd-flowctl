import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { analyze } from '../src/pipeline/analyze.js';
import { generateBdd } from '../src/bdd/generate.js';
import { prepareGrounding } from '../src/runtime/grounding.js';
import { compileExecutionPlan } from '../src/runtime/execution-plan.js';
import { inspectPacket, validatePacketProposal } from '../src/agent/packets.js';
import type {
  ActorRequirements,
  BehaviorGraph,
  CoverageReport,
  EvidenceGraph,
  FlowVariants,
  OperationCatalog,
  PageContracts,
  PathWitnesses,
} from '../src/ir/model.js';

const configPath = path.resolve('examples/account-opening/flowctl.config.yaml');
let store: ArtifactStore;

beforeAll(async () => {
  const config = await loadConfig(configPath);
  store = new ArtifactStore(config);
  await analyze(config, 'coverage');
});

describe('account-opening golden fixture', () => {
  it('links UI, HTTP and Java terminal evidence', async () => {
    const evidence = await store.read<EvidenceGraph>('evidence');
    const operations = await store.read<OperationCatalog>('operations');
    expect(evidence.data.nodes.some((node) => node.kind === 'control' && /^Submit .*application$/i.test(node.label))).toBe(true);
    expect(evidence.data.edges.some((edge) => edge.kind === 'handled-by')).toBe(true);
    expect(evidence.data.edges.every((edge) => edge.sourceRefs.length > 0)).toBe(true);
    expect(operations.data.operations).toHaveLength(1);
    expect(operations.data.operations[0]).toMatchObject({
      method: 'POST',
      pathTemplate: '/api/applications',
      businessCommand: { machineName: 'application.submit' },
      inclusion: 'included',
    });
  });

  it('retains page fields, backend validation and actor authority', async () => {
    const pages = await store.read<PageContracts>('pages');
    const actors = await store.read<ActorRequirements>('actors');
    const evidence = await store.read<EvidenceGraph>('evidence');
    const operations = await store.read<OperationCatalog>('operations');
    const productFields = pages.data.pages.flatMap((page) => page.fields).filter((field) => field.dataPath === 'productCode');
    expect(productFields.some((field) => field.constraints.some((constraint) => constraint.kind === 'min' && constraint.value === 3))).toBe(true);
    expect(productFields.some((field) => field.constraints.some((constraint) => constraint.kind === 'max' && constraint.value === 12))).toBe(false);
    expect(evidence.data.nodes.some((node) => (
      node.kind === 'validation'
      && node.attributes.fieldPath === 'ApplicationRequest.productCode'
      && node.attributes.kind === 'max'
      && node.attributes.value === 12
    ))).toBe(true);
    expect(actors.data.actors[0]?.authoritiesAll).toContain('APPLICATION_CREATE');
    expect(operations.data.operations[0]?.actorRequirementIds).toEqual([actors.data.actors[0]?.id]);
  });

  it('discovers two distinct successful variants with witnesses', async () => {
    const variants = await store.read<FlowVariants>('variants');
    const witnesses = await store.read<PathWitnesses>('witnesses');
    const behavior = await store.read<BehaviorGraph>('behavior');
    expect(variants.data.variants.map((variant) => variant.id)).toEqual([
      'application.submit.joint',
      'application.submit.personal',
    ]);
    expect(new Set(variants.data.variants.map((variant) => variant.behaviorSignature)).size).toBe(2);
    expect(witnesses.data.witnesses).toHaveLength(2);
    for (const variant of variants.data.variants) {
      expect(variant.witnessIds.length).toBeGreaterThan(0);
      expect(variant.pageSequence.at(-1)).toBe(behavior.data.successNodeIds[0]);
      expect(variant.feasibility).toBe('satisfiable');
    }
  });

  it('does not invent actor or existing applicant bindings', async () => {
    const joint = path.join(store.dataRequirementsDirectory, 'application.submit.joint.yaml');
    const text = await fs.readFile(joint, 'utf8');
    expect(text).toContain('classification: existing-entity');
    expect(text).toContain('classification: authenticated-identity');
    expect(text).toContain('status: unresolved');
    expect(text).not.toMatch(/password:|token:|customerId:\s*[A-Z0-9-]+/i);
  });

  it('generates journey and detailed page-contract BDD', async () => {
    const generated = await generateBdd(store, 'application.submit');
    const journey = generated.find((file) => file.endsWith('application.submit.feature'))!;
    const text = await fs.readFile(journey, 'utf8');
    expect(text).toContain('@variant:application.submit.joint');
    expect(text).toContain('@variant:application.submit.personal');
    expect(text).toMatch(/Then "Submit Application" with operation IDs ".+" should succeed/);
    const pageFeature = generated.find((file) => file.includes('page-contracts') && file.endsWith('.feature.txt'))!;
    expect(await fs.readFile(pageFeature, 'utf8')).toContain('active validation contract');
    const jointPageFeature = generated.find((file) => file.includes('joint-applicant-page') && file.endsWith('.feature.txt'))!;
    const jointPageText = await fs.readFile(jointPageFeature, 'utf8');
    expect(jointPageText.match(/Enforce required validation for Joint applicant/g)).toHaveLength(1);
    expect(jointPageText.match(/Enforce min validation for Product code/g)).toHaveLength(1);
    expect(jointPageText).not.toMatch(/violates constraint ID .* with /);
    const steps = generated.find((file) => file.endsWith('flowctl.steps.generated.ts'))!;
    const stepText = await fs.readFile(steps, 'utf8');
    expect(stepText).toContain('registerFlowctlSteps');
    expect(stepText).toContain('ensurePageDisplayed');
    const planFile = generated.find((file) => file.endsWith('step-plan.json'))!;
    const plan = JSON.parse(await fs.readFile(planFile, 'utf8')) as { steps: Array<{ witnessId: string; nodePath: string[] }> };
    expect(plan.steps.every((step) => step.witnessId && step.nodePath.length > 0)).toBe(true);
  });

  it('refuses runtime grounding until required application data is verified', async () => {
    await expect(prepareGrounding(store, 'application.submit.joint', 'local')).rejects.toThrow(/required application data is not verified/i);
  });

  it('refuses executable status while application data and actions are unbound', async () => {
    const { plan } = await compileExecutionPlan(store, 'application.submit.joint', 'local');
    expect(plan.readiness).toBe('blocked-data');
    expect(plan.data.missing.some((item) => item.classification === 'existing-entity')).toBe(true);
    expect(plan.missingActionBindings.length).toBeGreaterThan(0);
  });

  it('reports modeled and runtime coverage separately', async () => {
    const coverage = await store.read<CoverageReport>('coverage');
    expect(coverage.data.counts.variants).toBe(2);
    expect(coverage.data.counts.pathWitnesses).toBe(2);
    expect(coverage.data.counts.runtimeBindings).toBe(0);
    expect(coverage.data.counts.unresolvedDataRequirements).toBeGreaterThan(0);
  });

  it('validates bounded semantic proposals against allowed evidence', async () => {
    const packet = await inspectPacket(store, 'packet.operation-semantics.v1');
    await fs.writeFile(packet.outputPath, JSON.stringify({
      packetId: packet.packetId,
      packetDigest: packet.packetDigest,
      decisions: [{
        operationId: packet.allowedOperationIds[0],
        label: 'Submit application',
        machineName: 'application.submit',
        aliases: ['open application'],
        familyHint: 'application lifecycle',
        explanation: 'The submit handler reaches the application mutation.',
        evidenceRefs: [packet.allowedEvidenceIds[0]],
      }],
      unresolved: [],
    }), 'utf8');
    const proposal = await validatePacketProposal(store, packet.packetId);
    expect(proposal.decisions[0]?.machineName).toBe('application.submit');
  });
});
