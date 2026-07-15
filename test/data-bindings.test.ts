import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotSources } from '../src/adapters/source.js';
import { ArtifactStore, artifactEnvelopeDigest } from '../src/core/artifact-store.js';
import { loadConfig } from '../src/core/config.js';
import { sha256, stableJson } from '../src/core/stable.js';
import {
  bindRequirement,
  confirmRequirement,
  readApplicationBindings,
  readVariantRequirements,
  verifyVariantData,
} from '../src/data/bindings.js';
import type { BehaviorGraph, DataRequirement, FlowVariants, PathWitnesses } from '../src/ir/model.js';

const variantId = 'application.submit.joint';
const generatedRequirementId = 'requirement.product-code';
const entityRequirementId = 'requirement.joint-applicant';
const identityRequirementId = 'requirement.application-submitter';
const confirmedAt = '2026-07-15T08:30:00.000Z';

describe('application data binding verification', () => {
  let temporaryRoot: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-data-bindings-'));
    const base = await loadConfig(path.resolve('examples/account-opening/flowctl.config.yaml'));
    const sourceDigest = (await snapshotSources(base)).digest;
    store = new ArtifactStore(
      { ...base, outputRoot: path.join(temporaryRoot, '.flowctl') },
      { applicationDataFile: path.join(temporaryRoot, '.flowctl', 'application-data.local.yaml') },
    );
    await store.initialize();
    const variants: FlowVariants = {
      variants: [{
        id: variantId,
        familyId: 'application.submit',
        label: 'Submit joint application',
        witnessIds: ['witness.joint'],
        behaviorSignature: 'joint-signature',
        actorRequirementIds: ['actor.application-submitter'],
        pathCondition: { kind: 'constant', value: true },
        pageSequence: [],
        actionSequence: [],
        operationIds: ['operation.submit'],
        dataRequirementIds: [generatedRequirementId, entityRequirementId, identityRequirementId],
        feasibility: 'satisfiable',
        evidenceRefs: [],
      }],
    };
    await store.write('variants', store.createEnvelope({
      artifactType: 'flow-variants',
      producer: 'variants:reduce',
      sourceDigest,
      data: variants,
    }));
    await store.write('witnesses', store.createEnvelope({
      artifactType: 'path-witnesses',
      producer: 'paths:search',
      sourceDigest,
      data: {
        witnesses: [{
          id: 'witness.joint', familyId: 'application.submit', nodePath: [], edgePath: [], pageSequence: [], actionSequence: [],
          pathCondition: { kind: 'constant', value: true }, assignments: {}, feasibility: 'satisfiable', evidenceRefs: [],
        }],
      } satisfies PathWitnesses,
    }));
    await store.write('behavior', store.createEnvelope({
      artifactType: 'behavior-graph',
      producer: 'behavior:build',
      sourceDigest,
      data: { nodes: [], edges: [], entryNodeIds: [], successNodeIds: [] } satisfies BehaviorGraph,
    }));
    await store.write('pages', store.createEnvelope({
      artifactType: 'page-contracts',
      producer: 'pages:build',
      sourceDigest,
      data: { pages: [] },
    }));
    await store.write('actors', store.createEnvelope({
      artifactType: 'actor-requirements',
      producer: 'actors:build',
      sourceDigest,
      data: { actors: [] },
    }));
    const requirements: DataRequirement[] = [
      {
        ...requirement(generatedRequirementId, 'productCode', 'runtime-option', ['runtime-option-provider'], 'generated'),
        representativeValue: 'EVERYDAY',
      },
      requirement(entityRequirementId, 'jointApplicantId', 'existing-entity', ['approved-fixture', 'manual-binding']),
      requirement(identityRequirementId, 'actor.principal', 'authenticated-identity', ['approved-identity-catalog', 'secret-reference']),
    ];
    const [variantsEnvelope, witnessesEnvelope, behaviorEnvelope, pagesEnvelope, actorsEnvelope] = await Promise.all([
      store.read<FlowVariants>('variants'),
      store.read<PathWitnesses>('witnesses'),
      store.read<BehaviorGraph>('behavior'),
      store.read('pages'),
      store.read('actors'),
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
      data: { variantId, requirements },
    });
    await fs.writeFile(
      path.join(store.dataRequirementsDirectory, `${variantId}.yaml`),
      stringifyYaml(dataEnvelope),
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it('remains blocked until every external binding is explicitly confirmed', async () => {
    await bindRequirement({
      store,
      requirementId: entityRequirementId,
      alias: 'joint-applicant-uat',
      resolver: 'approved-fixture',
      value: 'customer-42',
    });
    await bindRequirement({
      store,
      requirementId: identityRequirementId,
      alias: 'application-submitter-uat',
      resolver: 'approved-identity-catalog',
      secretRef: 'secret://uat/application-submitter',
    });

    const merelyBound = await verifyVariantData(store, variantId);
    expect(merelyBound).toMatchObject({
      ready: false,
      generated: [generatedRequirementId],
      bound: [entityRequirementId, identityRequirementId],
      verified: [],
      missing: [],
    });
    expect(merelyBound.unverified.map((item) => item.id)).toEqual([entityRequirementId, identityRequirementId]);

    await confirmRequirement({
      store,
      requirementId: entityRequirementId,
      reviewer: 'reviewer@example.test',
      confirmedAt,
    });
    const partiallyConfirmed = await verifyVariantData(store, variantId);
    expect(partiallyConfirmed.ready).toBe(false);
    expect(partiallyConfirmed.verified).toEqual([entityRequirementId]);
    expect(partiallyConfirmed.unverified.map((item) => item.id)).toEqual([identityRequirementId]);

    const result = await confirmRequirement({
      store,
      requirementId: identityRequirementId,
      reviewer: 'reviewer@example.test',
      confirmedAt,
    });
    expect(result.confirmation).toEqual({ reviewer: 'reviewer@example.test', confirmedAt });

    const ready = await verifyVariantData(store, variantId);
    expect(ready).toMatchObject({
      ready: true,
      generated: [generatedRequirementId],
      bound: [entityRequirementId, identityRequirementId],
      verified: [entityRequirementId, identityRequirementId],
      unverified: [],
      missing: [],
    });
    const persisted = await readApplicationBindings(store);
    expect(persisted.bindings[identityRequirementId]).toMatchObject({
      verified: true,
      confirmation: { reviewer: 'reviewer@example.test', confirmedAt },
    });
  });

  it('invalidates prior confirmation when a requirement is rebound', async () => {
    await bindRequirement({
      store,
      requirementId: entityRequirementId,
      alias: 'joint-applicant-uat',
      resolver: 'approved-fixture',
      value: 'customer-42',
    });
    await confirmRequirement({
      store,
      requirementId: entityRequirementId,
      reviewer: 'reviewer@example.test',
      confirmedAt,
    });

    await bindRequirement({
      store,
      requirementId: entityRequirementId,
      alias: 'replacement-joint-applicant',
      resolver: 'approved-fixture',
      value: 'customer-84',
    });

    const persisted = await readApplicationBindings(store);
    expect(persisted.bindings[entityRequirementId]).toMatchObject({
      value: 'customer-84',
      verified: false,
    });
    expect(persisted.bindings[entityRequirementId]?.confirmation).toBeUndefined();
    const verification = await verifyVariantData(store, variantId);
    expect(verification.ready).toBe(false);
    expect(verification.unverified.map((item) => item.id)).toContain(entityRequirementId);
  });

  it('refuses to confirm a missing binding or invalid confirmation metadata', async () => {
    await expect(confirmRequirement({
      store,
      requirementId: entityRequirementId,
      reviewer: 'reviewer@example.test',
      confirmedAt,
    })).rejects.toThrow(`Data requirement ${entityRequirementId} is not bound in the application data file.`);

    await bindRequirement({
      store,
      requirementId: entityRequirementId,
      alias: 'joint-applicant-uat',
      resolver: 'approved-fixture',
      value: 'customer-42',
    });
    await expect(confirmRequirement({
      store,
      requirementId: entityRequirementId,
      reviewer: '   ',
      confirmedAt: 'not-a-timestamp',
    })).rejects.toThrow();
  });

  it('rejects an application data file for a different project', async () => {
    await fs.writeFile(
      store.applicationDataFile,
      stringifyYaml({
        version: 1,
        application: 'another-application',
        bindings: {
          [entityRequirementId]: {
            alias: 'production-customer',
            value: 'customer-prod',
            resolver: 'production-catalog',
            requirementDigest: 'sha256:another-application-requirement',
            verified: true,
            confirmation: { reviewer: 'reviewer@example.test', confirmedAt },
          },
        },
      }),
      'utf8',
    );

    await expect(verifyVariantData(store, variantId)).rejects.toThrow(
      /application data file targets another-application/i,
    );
  });

  it('rejects a raw credential passed as a secret reference', async () => {
    await expect(bindRequirement({
      store,
      requirementId: identityRequirementId,
      alias: 'application-submitter',
      resolver: 'approved-identity-catalog',
      secretRef: 'hunter2',
    })).rejects.toThrow(/provider reference.*raw values are forbidden/i);
  });

  it('does not let a hand-edited raw identity value become data-ready', async () => {
    const requirements = await readVariantRequirements(store, variantId);
    const byId = new Map(requirements.map((item) => [item.id, item]));
    const confirmation = { reviewer: 'reviewer@example.test', confirmedAt };
    await fs.writeFile(store.applicationDataFile, stringifyYaml({
      version: 1,
      application: store.config.project.name,
      bindings: {
        [entityRequirementId]: {
          alias: 'joint-applicant-uat',
          value: 'customer-42',
          resolver: 'approved-fixture',
          requirementDigest: sha256(stableJson(byId.get(entityRequirementId))),
          verified: true,
          confirmation,
        },
        [identityRequirementId]: {
          alias: 'application-submitter-uat',
          value: 'raw-identity-credential',
          resolver: 'approved-identity-catalog',
          requirementDigest: sha256(stableJson(byId.get(identityRequirementId))),
          verified: true,
          confirmation,
        },
      },
    }), 'utf8');

    const verification = await verifyVariantData(store, variantId);
    expect(verification.ready).toBe(false);
    expect(verification.verified).toEqual([entityRequirementId]);
    expect(verification.unverified).toContainEqual(expect.objectContaining({
      id: identityRequirementId,
      reason: expect.stringMatching(/requires an approved secretRef.*raw value cannot satisfy/i),
    }));
    await expect(confirmRequirement({
      store,
      requirementId: identityRequirementId,
      reviewer: 'reviewer@example.test',
      confirmedAt,
    })).rejects.toThrow(/requires an approved secretRef.*raw value cannot satisfy/i);
  });

  it('does not let a secret reference replace a typed application value', async () => {
    const requirements = await readVariantRequirements(store, variantId);
    const byId = new Map(requirements.map((item) => [item.id, item]));
    const confirmation = { reviewer: 'reviewer@example.test', confirmedAt };
    await fs.writeFile(store.applicationDataFile, stringifyYaml({
      version: 1,
      application: store.config.project.name,
      bindings: {
        [entityRequirementId]: {
          alias: 'joint-applicant-uat',
          secretRef: 'vault://fixtures/joint-applicant',
          resolver: 'approved-fixture',
          requirementDigest: sha256(stableJson(byId.get(entityRequirementId))),
          verified: true,
          confirmation,
        },
        [identityRequirementId]: {
          alias: 'application-submitter-uat',
          secretRef: 'vault://identities/application-submitter',
          resolver: 'approved-identity-catalog',
          requirementDigest: sha256(stableJson(byId.get(identityRequirementId))),
          verified: true,
          confirmation,
        },
      },
    }), 'utf8');

    const verification = await verifyVariantData(store, variantId);
    expect(verification.ready).toBe(false);
    expect(verification.verified).toEqual([identityRequirementId]);
    expect(verification.unverified).toContainEqual(expect.objectContaining({
      id: entityRequirementId,
      reason: expect.stringMatching(/requires a typed value.*secretRef is not allowed/i),
    }));
    await expect(confirmRequirement({
      store,
      requirementId: entityRequirementId,
      reviewer: 'reviewer@example.test',
      confirmedAt,
    })).rejects.toThrow(/requires a typed value.*secretRef is not allowed/i);
  });

  it('never treats a secret or identity requirement as safely generated', async () => {
    const requirementsPath = path.join(store.dataRequirementsDirectory, `${variantId}.yaml`);
    const parsed = (await import('yaml')).parse(await fs.readFile(requirementsPath, 'utf8')) as any;
    const identity = parsed.data.requirements.find((item: DataRequirement) => item.id === identityRequirementId);
    identity.status = 'generated';
    identity.representativeValue = 'raw-identity-credential';
    parsed.meta.contentDigest = sha256(stableJson(parsed.data));
    parsed.meta.envelopeDigest = artifactEnvelopeDigest(parsed);
    await fs.writeFile(requirementsPath, stringifyYaml(parsed), 'utf8');

    const verification = await verifyVariantData(store, variantId);
    expect(verification.generated).toEqual([generatedRequirementId]);
    expect(verification.missing.map((item) => item.id)).toContain(identityRequirementId);
    expect(verification.ready).toBe(false);
  });

  it('rejects arbitrary URLs disguised as secret references', async () => {
    await expect(bindRequirement({
      store,
      requirementId: identityRequirementId,
      alias: 'application-submitter',
      resolver: 'approved-identity-catalog',
      secretRef: 'https://example.test/raw-password',
    })).rejects.toThrow(/approved provider reference.*arbitrary URLs are forbidden/i);
  });

  it('rejects a resolver that is not declared by the source-derived requirement', async () => {
    await expect(bindRequirement({
      store,
      requirementId: entityRequirementId,
      alias: 'invented-customer',
      resolver: 'guessed',
      value: 'customer-42',
    })).rejects.toThrow(/resolver guessed is not approved/i);
  });

  it('rejects a concrete binding that violates source-derived constraints', async () => {
    const requirementsPath = path.join(store.dataRequirementsDirectory, `${variantId}.yaml`);
    const original = await fs.readFile(requirementsPath, 'utf8');
    const parsed = (await import('yaml')).parse(original) as any;
    const entity = parsed.data.requirements.find((item: DataRequirement) => item.id === entityRequirementId);
    entity.constraints = [{
      id: 'constraint.customer-id-min',
      fieldPath: 'jointApplicantId',
      kind: 'min',
      value: 5,
      sourceRef: { file: 'CustomerSelect.tsx', line: 1 },
    }];
    parsed.meta.contentDigest = sha256(stableJson(parsed.data));
    parsed.meta.envelopeDigest = artifactEnvelopeDigest(parsed);
    await fs.writeFile(requirementsPath, stringifyYaml(parsed), 'utf8');

    await expect(bindRequirement({
      store,
      requirementId: entityRequirementId,
      alias: 'too-short',
      resolver: 'approved-fixture',
      value: 'x',
    })).rejects.toThrow(/minimum 5 is not satisfied/i);
  });

  it('rejects a rewritten data-requirements body when only contentDigest is recomputed', async () => {
    const requirementsPath = path.join(store.dataRequirementsDirectory, `${variantId}.yaml`);
    const parsed = (await import('yaml')).parse(await fs.readFile(requirementsPath, 'utf8')) as any;
    const entity = parsed.data.requirements.find((item: DataRequirement) => item.id === entityRequirementId);
    entity.resolutionStrategies = ['unreviewed-replacement'];
    parsed.meta.contentDigest = sha256(stableJson(parsed.data));
    await fs.writeFile(requirementsPath, stringifyYaml(parsed), 'utf8');

    await expect(readVariantRequirements(store, variantId)).rejects.toThrow(/invalid envelope digest/i);
  });

  it('rejects current data requirements when their required envelope digest is removed', async () => {
    const requirementsPath = path.join(store.dataRequirementsDirectory, `${variantId}.yaml`);
    const parsed = (await import('yaml')).parse(await fs.readFile(requirementsPath, 'utf8')) as any;
    delete parsed.meta.envelopeDigest;
    await fs.writeFile(requirementsPath, stringifyYaml(parsed), 'utf8');

    await expect(readVariantRequirements(store, variantId)).rejects.toThrow(/invalid envelope digest/i);
  });

  it('rejects data requirements whose page or actor lineage no longer matches', async () => {
    const requirementsPath = path.join(store.dataRequirementsDirectory, `${variantId}.yaml`);
    const parsed = (await import('yaml')).parse(await fs.readFile(requirementsPath, 'utf8')) as any;
    parsed.meta.inputDigests.pages = sha256('different-page-contract');
    parsed.meta.envelopeDigest = artifactEnvelopeDigest(parsed);
    await fs.writeFile(requirementsPath, stringifyYaml(parsed), 'utf8');

    await expect(readVariantRequirements(store, variantId)).rejects.toThrow(/data requirements.*stale/i);
  });

  it('rejects a data-requirements envelope from a noncanonical producer', async () => {
    const requirementsPath = path.join(store.dataRequirementsDirectory, `${variantId}.yaml`);
    const parsed = (await import('yaml')).parse(await fs.readFile(requirementsPath, 'utf8')) as any;
    parsed.meta.producer = 'untrusted:rewrite';
    parsed.meta.envelopeDigest = artifactEnvelopeDigest(parsed);
    await fs.writeFile(requirementsPath, stringifyYaml(parsed), 'utf8');

    await expect(readVariantRequirements(store, variantId)).rejects.toThrow(/invalid or stale artifact envelope/i);
  });
});

function requirement(
  id: string,
  fieldPath: string,
  classification: DataRequirement['classification'],
  resolutionStrategies: string[],
  status: DataRequirement['status'] = 'unresolved',
): DataRequirement {
  return {
    id,
    variantId,
    fieldPath,
    classification,
    constraints: [],
    resolutionStrategies,
    status,
    evidenceRefs: [],
  };
}
