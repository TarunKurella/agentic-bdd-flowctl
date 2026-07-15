import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyApprovedOperationDecisions,
  approvePacket,
  createOperationPacket,
  inspectPacket,
  isPacketProposalValidated,
  nextPacket,
} from '../src/agent/packets.js';
import { snapshotSources } from '../src/adapters/source.js';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { loadConfig } from '../src/core/config.js';
import type { EvidenceGraph, OperationCatalog, OperationCatalogEntry } from '../src/ir/model.js';

const packetId = 'packet.operation-semantics.v1';
const evidenceOne = 'evidence.operation-one';
const evidenceTwo = 'evidence.operation-two';

describe('semantic packet freshness', () => {
  let temporaryRoot: string;
  let store: ArtifactStore;
  let initialSourceDigest: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-packet-freshness-'));
    const base = await loadConfig(path.resolve('examples/account-opening/flowctl.config.yaml'));
    await fs.mkdir(path.join(temporaryRoot, 'frontend'), { recursive: true });
    await fs.writeFile(path.join(temporaryRoot, 'frontend', 'source.ts'), 'export const sourceVersion = 1;\n', 'utf8');
    store = new ArtifactStore({
      ...base,
      projectRoot: temporaryRoot,
      configDirectory: temporaryRoot,
      configPath: path.join(temporaryRoot, 'flowctl.config.yaml'),
      sources: {
        ...base.sources,
        frontend: ['frontend'],
        backend: [],
        include: ['**/*.ts'],
      },
      outputRoot: path.join(temporaryRoot, '.flowctl'),
    });
    await store.initialize();
    initialSourceDigest = (await snapshotSources(store.config)).digest;
    await writeEvidence(store, initialSourceDigest);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it('persists packet fingerprints in the approval and applies only the matching decision', async () => {
    const catalog = operationCatalog(operation('operation.one', evidenceOne));
    const packet = await createOperationPacket(store, catalog);
    expect(packet).toMatchObject({
      sourceDigest: initialSourceDigest,
      configDigest: store.config.configDigest,
    });
    expect(packet?.packetDigest).toMatch(/^sha256:/);
    await writeProposal(packet!, 'Reviewed submit application');
    expect(await isPacketProposalValidated(store, packet!)).toBe(false);
    const approvalPath = await approvePacket(store, packetId, 'reviewer@example.test');
    expect(await isPacketProposalValidated(store, packet!)).toBe(true);
    const approval = JSON.parse(await fs.readFile(approvalPath, 'utf8')) as Record<string, unknown>;
    expect(approval).toMatchObject({
      packetId,
      sourceDigest: packet?.sourceDigest,
      configDigest: packet?.configDigest,
      packetDigest: packet?.packetDigest,
    });
    expect(approval.proposalDigest).toMatch(/^sha256:/);
    expect(approval.approvedAt).toEqual(expect.any(String));

    const regenerated = operationCatalog(operation('operation.one', evidenceOne));
    await applyApprovedOperationDecisions(store, regenerated);
    expect(regenerated.operations[0]?.businessCommand).toEqual({
      machineName: 'application.submit.reviewed',
      label: 'Reviewed submit application',
      origin: 'human-reviewed',
    });
    expect(await nextPacket(store)).toBeUndefined();
  });

  it('ignores an approval after the source or configuration fingerprint changes', async () => {
    const initial = operationCatalog(operation('operation.one', evidenceOne));
    const packet = (await createOperationPacket(store, initial))!;
    await writeProposal(packet, 'Reviewed submit application');
    await approvePacket(store, packetId, 'reviewer@example.test');

    await fs.writeFile(path.join(temporaryRoot, 'frontend', 'source.ts'), 'export const sourceVersion = 2;\n', 'utf8');
    const changedSourceDigest = (await snapshotSources(store.config)).digest;
    await writeEvidence(store, changedSourceDigest);
    const sourceChanged = operationCatalog(operation('operation.one', evidenceOne));
    await applyApprovedOperationDecisions(store, sourceChanged);
    expect(sourceChanged.operations[0]?.businessCommand.origin).toBe('deterministic');
    expect((await nextPacket(store))?.packetDigest).toBe(packet.packetDigest);
    const currentPacket = (await createOperationPacket(store, sourceChanged))!;
    expect(currentPacket.sourceDigest).toBe(changedSourceDigest);
    expect((await nextPacket(store))?.packetDigest).toBe(currentPacket.packetDigest);

    const changedConfigStore = new ArtifactStore({
      ...store.config,
      configDigest: 'sha256:changed-config',
      outputRoot: store.config.outputRoot,
    });
    const configChanged = operationCatalog(operation('operation.one', evidenceOne));
    await applyApprovedOperationDecisions(changedConfigStore, configChanged);
    expect(configChanged.operations[0]?.businessCommand.origin).toBe('deterministic');
    expect((await nextPacket(changedConfigStore))?.packetDigest).toBe(currentPacket.packetDigest);
    const configPacket = (await createOperationPacket(changedConfigStore, configChanged))!;
    expect(configPacket.configDigest).toBe('sha256:changed-config');
    expect((await nextPacket(changedConfigStore))?.packetDigest).toBe(configPacket.packetDigest);
  });

  it('ignores approvals when packet scope changes and rejects undigested packet tampering', async () => {
    const initial = operationCatalog(operation('operation.one', evidenceOne));
    const packet = (await createOperationPacket(store, initial))!;
    await writeProposal(packet, 'Reviewed submit application');
    await approvePacket(store, packetId, 'reviewer@example.test');

    const expanded = operationCatalog(
      operation('operation.one', evidenceOne),
      operation('operation.two', evidenceTwo),
    );
    await applyApprovedOperationDecisions(store, expanded);
    expect(expanded.operations[0]?.businessCommand.origin).toBe('deterministic');
    const expandedPacket = (await createOperationPacket(store, expanded))!;
    expect(expandedPacket.packetDigest).not.toBe(packet.packetDigest);
    expect((await nextPacket(store))?.packetDigest).toBe(expandedPacket.packetDigest);

    const packetPath = path.join(store.workDirectory, 'packets', `${packetId}.json`);
    const tampered = JSON.parse(await fs.readFile(packetPath, 'utf8')) as Record<string, unknown>;
    tampered.question = 'A different semantic question';
    await fs.writeFile(packetPath, JSON.stringify(tampered), 'utf8');
    await expect(inspectPacket(store, packetId)).rejects.toThrow('content digest does not match');
  });

  it('treats legacy approvals without fingerprints as pending and never applies them', async () => {
    const catalog = operationCatalog(operation('operation.one', evidenceOne));
    const packet = (await createOperationPacket(store, catalog))!;
    const proposal = proposalFor(packet, 'Legacy reviewed label');
    await fs.mkdir(store.decisionsDirectory, { recursive: true });
    await fs.writeFile(
      path.join(store.decisionsDirectory, `${packetId}.approved.json`),
      JSON.stringify({ packetId, reviewer: 'legacy-reviewer', proposal }),
      'utf8',
    );

    const regenerated = operationCatalog(operation('operation.one', evidenceOne));
    await applyApprovedOperationDecisions(store, regenerated);
    expect(regenerated.operations[0]?.businessCommand.origin).toBe('deterministic');
    expect((await nextPacket(store))?.packetId).toBe(packetId);
  });
});

async function writeEvidence(target: ArtifactStore, sourceDigest: string): Promise<void> {
  const graph: EvidenceGraph = {
    nodes: [evidenceNode(evidenceOne), evidenceNode(evidenceTwo)],
    edges: [],
    diagnostics: [],
  };
  await target.write('evidence', target.createEnvelope({
    artifactType: 'evidence-graph',
    producer: 'evidence:link',
    sourceDigest,
    data: graph,
  }));
}

function evidenceNode(id: string): EvidenceGraph['nodes'][number] {
  return {
    id,
    kind: 'java-endpoint',
    canonicalKey: id,
    label: id,
    attributes: {},
    origin: 'source-extracted',
    confidence: 'exact',
    sourceRefs: [{ file: `${id}.java`, line: 1 }],
  };
}

function operationCatalog(...operations: OperationCatalogEntry[]): OperationCatalog {
  return { operations };
}

function operation(id: string, evidenceRef: string): OperationCatalogEntry {
  return {
    id,
    method: 'POST',
    pathTemplate: `/api/${id}`,
    frontendOperationIds: [`frontend.${id}`],
    backendEndpointId: evidenceRef,
    actorRequirementIds: [],
    validationIds: [],
    terminalEffectIds: [],
    businessCommand: {
      machineName: `${id}.submit`,
      label: `Submit ${id}`,
      origin: 'deterministic',
    },
    inclusion: 'included',
    evidenceRefs: [evidenceRef],
  };
}

async function writeProposal(packet: NonNullable<Awaited<ReturnType<typeof createOperationPacket>>>, label: string): Promise<void> {
  await fs.writeFile(packet.outputPath, JSON.stringify(proposalFor(packet, label)), 'utf8');
}

function proposalFor(packet: NonNullable<Awaited<ReturnType<typeof createOperationPacket>>>, label: string) {
  return {
    packetId: packet.packetId,
    packetDigest: packet.packetDigest,
    decisions: [{
      operationId: packet.allowedOperationIds[0],
      label,
      machineName: 'application.submit.reviewed',
      aliases: [],
      explanation: 'The reviewed endpoint submits an application.',
      evidenceRefs: [packet.allowedEvidenceIds[0]],
    }],
    unresolved: [],
  };
}
