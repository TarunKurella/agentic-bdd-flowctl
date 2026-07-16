import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyApprovedRuleDecisions,
  approvePacket,
  createRulePacket,
  validatePacketProposal,
} from '../src/agent/packets.js';
import { snapshotSources } from '../src/adapters/source.js';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { loadConfig } from '../src/core/config.js';
import { solvePredicate } from '../src/ir/predicates.js';
import type { EvidenceGraph, ExtractionBundle } from '../src/ir/model.js';
import { buildActorRequirements } from '../src/pipeline/builders.js';

describe('bounded operation-rule packets', () => {
  let root: string;
  let store: ArtifactStore;
  let bundle: ExtractionBundle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-rule-packet-'));
    await fs.mkdir(path.join(root, 'backend'), { recursive: true });
    await fs.writeFile(path.join(root, 'backend', 'ApplicationController.java'), 'class ApplicationController {}\n');
    const base = await loadConfig(path.resolve('examples/account-opening/flowctl.config.yaml'));
    const outputRoot = path.join(root, '.flowctl');
    store = new ArtifactStore({
      ...base,
      projectRoot: root,
      configDirectory: root,
      configPath: path.join(root, 'flowctl.config.yaml'),
      sources: { ...base.sources, frontend: [], backend: ['backend'], include: ['**/*.java'] },
      outputRoot,
      applicationDataPath: path.join(outputRoot, 'application-data.local.yaml'),
    });
    await store.initialize();
    const sourceDigest = (await snapshotSources(store.config)).digest;
    bundle = extractionBundle(sourceDigest);
    await writeEvidence(store, sourceDigest);
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  it('compiles only a validated, human-approved rule proposal into canonical endpoint facts', async () => {
    const packet = (await createRulePacket(store, bundle))!;
    await fs.writeFile(packet.outputPath, JSON.stringify({
      packetId: packet.packetId,
      packetDigest: packet.packetDigest,
      resolutions: [{
        endpointId: 'endpoint.submit',
        authorization: { status: 'exact', authoritiesAll: ['APPLICATION_CREATE'] },
        successPredicateExpression: 'productCode != null',
        explanation: 'The endpoint requires the create authority and accepts a request with a product code.',
        evidenceRefs: ['endpoint.submit', 'source.security'],
      }],
      unresolved: [],
    }));

    await validatePacketProposal(store, packet.packetId);
    await approvePacket(store, packet.packetId, 'reviewer@example.test');
    await applyApprovedRuleDecisions(store, bundle);

    expect(bundle.endpoints[0]?.authorization.status).toBe('exact');
    expect(bundle.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ authority: 'APPLICATION_CREATE', origin: 'human-reviewed' }),
    ]));
    expect(solvePredicate(bundle.endpoints[0]!.domainGuard).status).toBe('satisfiable');
    expect(bundle.endpoints[0]?.semanticResolution).toMatchObject({
      packetId: packet.packetId,
      reviewer: 'reviewer@example.test',
      evidenceRefs: ['endpoint.submit', 'source.security'],
    });
  });

  it('rejects a predicate path that was not extracted as an allowed request field', async () => {
    const packet = (await createRulePacket(store, bundle))!;
    await fs.writeFile(packet.outputPath, JSON.stringify({
      packetId: packet.packetId,
      packetDigest: packet.packetDigest,
      resolutions: [{
        endpointId: 'endpoint.submit',
        authorization: { status: 'anonymous' },
        successPredicateExpression: 'inventedEligibility == true',
        explanation: 'This path is not source-grounded.',
        evidenceRefs: ['endpoint.submit'],
      }],
      unresolved: [],
    }));
    await expect(validatePacketProposal(store, packet.packetId)).rejects.toThrow('unapproved path');
  });

  it('rejects authority values that are absent from the extracted authorization expression', async () => {
    const packet = (await createRulePacket(store, bundle))!;
    await fs.writeFile(packet.outputPath, JSON.stringify({
      packetId: packet.packetId,
      packetDigest: packet.packetDigest,
      resolutions: [{
        endpointId: 'endpoint.submit',
        authorization: { status: 'exact', authoritiesAll: ['INVENTED_ADMIN'] },
        successPredicateExpression: 'productCode != null',
        explanation: 'The authority is not in the source expression.',
        evidenceRefs: ['endpoint.submit'],
      }],
      unresolved: [],
    }));
    await expect(validatePacketProposal(store, packet.packetId)).rejects.toThrow('unapproved authority');
  });

  it('rejects literal predicate values not extracted from the endpoint constraints', async () => {
    const packet = (await createRulePacket(store, bundle))!;
    await fs.writeFile(packet.outputPath, JSON.stringify({
      packetId: packet.packetId,
      packetDigest: packet.packetDigest,
      resolutions: [{
        endpointId: 'endpoint.submit',
        successPredicateExpression: 'productCode == "INVENTED_PRODUCT"',
        explanation: 'The field exists, but this value has no source evidence.',
        evidenceRefs: ['endpoint.submit', 'source.security'],
      }],
      unresolved: [{ endpointId: 'endpoint.submit', question: 'Authorization remains unresolved.', evidenceRefs: ['endpoint.submit'] }],
    }));
    await expect(validatePacketProposal(store, packet.packetId)).rejects.toThrow('unapproved literal value');
  });

  it('preserves authenticated-without-authority as a required actor contract', async () => {
    const packet = (await createRulePacket(store, bundle))!;
    await fs.writeFile(packet.outputPath, JSON.stringify({
      packetId: packet.packetId,
      packetDigest: packet.packetDigest,
      resolutions: [{
        endpointId: 'endpoint.submit',
        authorization: { status: 'authenticated' },
        explanation: 'The operation requires any authenticated principal.',
        evidenceRefs: ['endpoint.submit', 'source.security'],
      }],
      unresolved: [{ endpointId: 'endpoint.submit', question: 'The success predicate remains unresolved.', evidenceRefs: ['endpoint.submit'] }],
    }));
    await approvePacket(store, packet.packetId, 'reviewer@example.test');
    await applyApprovedRuleDecisions(store, bundle);
    const catalog = { operations: [{
      id: 'operation.submit', method: 'POST', pathTemplate: '/api/applications', frontendOperationIds: ['http.submit'],
      backendEndpointId: 'endpoint.submit', actorRequirementIds: [], validationIds: [], terminalEffectIds: ['effect.application-created'],
      businessCommand: { machineName: 'application.submit', label: 'Submit application', origin: 'deterministic' as const },
      inclusion: 'included' as const, requestContractIds: [], evidenceRefs: ['endpoint.submit'],
    }] };
    const actors = buildActorRequirements(bundle, catalog);
    expect(actors.actors[0]).toMatchObject({ authentication: 'required', authoritiesAll: [], label: 'authenticated principal' });
  });
});

function extractionBundle(sourceDigest: string): ExtractionBundle {
  return {
    sourceDigest,
    sourceFiles: [{ file: 'backend/ApplicationController.java', line: 1 }],
    routes: [], pages: [], handlers: [], actions: [], fields: [], httpOperations: [], navigations: [], permissions: [],
    endpoints: [{
      id: 'endpoint.submit', method: 'POST', pathTemplate: '/api/applications', controller: 'ApplicationController', handler: 'submit',
      requestType: 'ApplicationRequest',
      authorization: { status: 'conditional', sourceExpression: "hasAuthority('APPLICATION_CREATE') || hasRole('ADMIN')", reason: 'global security unresolved', sourceRefs: [{ file: 'backend/ApplicationController.java', line: 1 }] },
      domainGuard: { kind: 'opaque', sourceExpression: 'eligibilityPolicy.accepts(request)', reason: 'delegated rule' },
      permissionIds: [], validationIds: ['validation.product-code'], terminalEffectIds: ['effect.application-created'],
      sourceRef: { file: 'backend/ApplicationController.java', line: 1 },
    }],
    validations: [{ id: 'validation.product-code', fieldPath: 'productCode', kind: 'required', value: true, sourceRef: { file: 'backend/ApplicationController.java', line: 1 } }],
    effects: [{ id: 'effect.application-created', entity: 'application', kind: 'entity-created', sourceRef: { file: 'backend/ApplicationController.java', line: 1 } }],
    wikiConcepts: [], graphifyNodes: [], graphifyEdges: [],
    diagnostics: [
      { code: 'JAVA_AUTHORIZATION_CONDITIONAL', severity: 'warning', message: 'auth', evidenceRefs: ['endpoint.submit'] },
      { code: 'JAVA_DOMAIN_GUARD_CONDITIONAL', severity: 'warning', message: 'domain', evidenceRefs: ['endpoint.submit'] },
    ],
  };
}

async function writeEvidence(store: ArtifactStore, sourceDigest: string): Promise<void> {
  const data: EvidenceGraph = {
    nodes: [
      { id: 'endpoint.submit', kind: 'java-endpoint', canonicalKey: 'endpoint.submit', label: 'POST /api/applications', attributes: {}, origin: 'source-extracted', confidence: 'exact', sourceRefs: [{ file: 'backend/ApplicationController.java', line: 1 }] },
      { id: 'source.security', kind: 'source-file', canonicalKey: 'backend/SecurityConfig.java', label: 'SecurityConfig.java', attributes: {}, origin: 'source-extracted', confidence: 'exact', sourceRefs: [{ file: 'backend/SecurityConfig.java', line: 1 }] },
    ],
    edges: [], diagnostics: [],
  };
  await store.write('evidence', store.createEnvelope({ artifactType: 'evidence-graph', producer: 'evidence:link', sourceDigest, data }));
}
