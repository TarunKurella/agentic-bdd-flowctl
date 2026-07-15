import path from 'node:path';
import { z } from 'zod';
import { snapshotSources } from '../adapters/source.js';
import type { ArtifactStore } from '../core/artifact-store.js';
import { safeChildPath, safeFileSegment } from '../core/paths.js';
import { sha256, stableJson } from '../core/stable.js';
import type { EvidenceGraph, OperationCatalog } from '../ir/model.js';

const OPERATION_PACKET_ID = 'packet.operation-semantics.v1';

export interface AgentPacket {
  packetId: string;
  taskType: 'name-and-group-operations';
  question: string;
  allowedEvidenceIds: string[];
  allowedOperationIds: string[];
  allowedOutputFields: string[];
  forbiddenClaims: string[];
  responseSchema: string;
  outputPath: string;
  sourceDigest: string;
  configDigest: string;
  packetDigest: string;
}

const PacketSchema = z.object({
  packetId: z.string(),
  taskType: z.literal('name-and-group-operations'),
  question: z.string(),
  allowedEvidenceIds: z.array(z.string()),
  allowedOperationIds: z.array(z.string()),
  allowedOutputFields: z.array(z.string()),
  forbiddenClaims: z.array(z.string()),
  responseSchema: z.string(),
  outputPath: z.string(),
  sourceDigest: z.string(),
  configDigest: z.string(),
  packetDigest: z.string(),
});

const ProposalSchema = z.object({
  packetId: z.string(),
  packetDigest: z.string(),
  decisions: z.array(z.object({
    operationId: z.string(),
    label: z.string().min(1),
    machineName: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    aliases: z.array(z.string()).default([]),
    familyHint: z.string().optional(),
    explanation: z.string().min(1),
    evidenceRefs: z.array(z.string()).min(1),
  })),
  unresolved: z.array(z.object({
    operationId: z.string().optional(),
    question: z.string(),
    evidenceRefs: z.array(z.string()),
  })).default([]),
});

export type AgentProposal = z.infer<typeof ProposalSchema>;

const ApprovalSchema = z.object({
  packetId: z.string(),
  reviewer: z.string().trim().min(1),
  approvedAt: z.string().datetime({ offset: true }),
  sourceDigest: z.string(),
  configDigest: z.string(),
  packetDigest: z.string(),
  proposalDigest: z.string(),
  proposal: ProposalSchema,
});

type AgentApproval = z.infer<typeof ApprovalSchema>;

const ValidatedProposalSchema = z.object({
  packetId: z.string(),
  packetDigest: z.string(),
  proposalDigest: z.string(),
  proposal: ProposalSchema,
});

export async function createOperationPacket(store: ArtifactStore, catalog: OperationCatalog): Promise<AgentPacket | undefined> {
  const packet = await buildOperationPacket(store, catalog);
  if (!packet) return undefined;
  await store.writeManagedFile(packetFile(store, packet.packetId), stableJson(packet));
  return packet;
}

async function buildOperationPacket(store: ArtifactStore, catalog: OperationCatalog): Promise<AgentPacket | undefined> {
  const candidates = catalog.operations.filter((operation) => operation.inclusion !== 'excluded');
  if (!candidates.length) return undefined;
  const evidence = await store.read<EvidenceGraph>('evidence');
  const packetId = OPERATION_PACKET_ID;
  const outputPath = proposalFile(store, packetId);
  const content: Omit<AgentPacket, 'packetDigest'> = {
    packetId,
    taskType: 'name-and-group-operations',
    question: 'Propose readable business-command names and semantic family hints for the source-supported terminal operations.',
    allowedEvidenceIds: [...new Set(candidates.flatMap((operation) => operation.evidenceRefs))].sort(),
    allowedOperationIds: candidates.map((operation) => operation.id).sort(),
    allowedOutputFields: ['operationId', 'label', 'machineName', 'aliases', 'familyHint', 'explanation', 'evidenceRefs'],
    forbiddenClaims: ['new predicates', 'new graph edges', 'satisfiability', 'runtime success', 'UAT identifiers', 'credentials'],
    responseSchema: 'agent-operation-proposal-v1',
    outputPath,
    sourceDigest: evidence.meta.sourceDigest,
    configDigest: store.config.configDigest,
  };
  return { ...content, packetDigest: digestPacketContent(content) };
}

export async function inspectPacket(store: ArtifactStore, packetId: string): Promise<AgentPacket> {
  const packet = PacketSchema.parse(JSON.parse(await store.readManagedFile(packetFile(store, packetId))));
  const { packetDigest, ...content } = packet;
  if (packetDigest !== digestPacketContent(content)) throw new Error(`Packet ${packetId} content digest does not match its contents.`);
  if (path.resolve(packet.outputPath) !== proposalFile(store, packet.packetId)) {
    throw new Error(`Packet ${packetId} output path escapes the bounded proposals directory.`);
  }
  return packet;
}

export async function validatePacketProposal(store: ArtifactStore, packetId: string): Promise<AgentProposal> {
  const packet = await inspectPacket(store, packetId);
  await assertPacketCurrent(store, packet);
  const proposal = ProposalSchema.parse(JSON.parse(await store.readManagedFile(packet.outputPath)));
  if (proposal.packetId !== packetId) throw new Error(`Proposal packetId ${proposal.packetId} does not match ${packetId}.`);
  if (proposal.packetDigest !== packet.packetDigest) throw new Error(`Proposal packetDigest does not match current packet ${packetId}.`);
  const evidence = await store.read<EvidenceGraph>('evidence');
  const evidenceIds = new Set(evidence.data.nodes.map((node) => node.id));
  for (const decision of proposal.decisions) {
    if (!packet.allowedOperationIds.includes(decision.operationId)) throw new Error(`Operation ${decision.operationId} is not allowed by packet ${packetId}.`);
    for (const ref of decision.evidenceRefs) {
      if (!packet.allowedEvidenceIds.includes(ref) || !evidenceIds.has(ref)) throw new Error(`Evidence ${ref} is not allowed or does not exist.`);
    }
  }
  for (const unresolved of proposal.unresolved) {
    if (unresolved.operationId && !packet.allowedOperationIds.includes(unresolved.operationId)) {
      throw new Error(`Unresolved operation ${unresolved.operationId} is not allowed by packet ${packetId}.`);
    }
    for (const ref of unresolved.evidenceRefs) {
      if (!packet.allowedEvidenceIds.includes(ref) || !evidenceIds.has(ref)) throw new Error(`Unresolved evidence ${ref} is not allowed or does not exist.`);
    }
  }
  await store.writeManagedFile(validatedProposalFile(store, packetId), stableJson({
    packetId,
    packetDigest: packet.packetDigest,
    proposalDigest: digestProposal(proposal),
    proposal,
  }));
  return proposal;
}

export async function isPacketProposalValidated(store: ArtifactStore, packet: AgentPacket): Promise<boolean> {
  try {
    const validation = ValidatedProposalSchema.parse(JSON.parse(await store.readManagedFile(
      validatedProposalFile(store, packet.packetId),
    )));
    const proposal = ProposalSchema.parse(JSON.parse(await store.readManagedFile(packet.outputPath)));
    return validation.packetId === packet.packetId
      && validation.packetDigest === packet.packetDigest
      && validation.proposalDigest === digestProposal(proposal)
      && proposal.packetDigest === packet.packetDigest;
  } catch {
    return false;
  }
}

export async function approvePacket(store: ArtifactStore, packetId: string, reviewer: string): Promise<string> {
  const proposal = await validatePacketProposal(store, packetId);
  const packet = await inspectPacket(store, packetId);
  await assertPacketCurrent(store, packet);
  const destination = approvalFile(store, packetId);
  const approval: AgentApproval = ApprovalSchema.parse({
    packetId,
    reviewer,
    approvedAt: new Date().toISOString(),
    sourceDigest: packet.sourceDigest,
    configDigest: packet.configDigest,
    packetDigest: packet.packetDigest,
    proposalDigest: digestProposal(proposal),
    proposal,
  });
  await store.writeManagedFile(destination, stableJson(approval));
  if (await store.exists('operations')) {
    const operations = await store.read<OperationCatalog>('operations');
    await store.write('operations', store.createEnvelope({
      artifactType: operations.meta.artifactType,
      producer: 'review:invalidate-operation-model',
      sourceDigest: operations.meta.sourceDigest,
      inputDigests: operations.meta.inputDigests,
      data: operations.data,
      status: 'stale',
      unresolved: [{
        code: 'APPROVED_SEMANTICS_NOT_COMPILED',
        severity: 'blocked',
        message: `Approved packet ${packetId} must be compiled through downstream artifacts.`,
      }],
    }));
  }
  return destination;
}

export async function applyApprovedOperationDecisions(store: ArtifactStore, catalog: OperationCatalog): Promise<void> {
  const expectedPacket = await buildOperationPacket(store, catalog);
  if (!expectedPacket) return;
  const approved = await readApproval(store, expectedPacket.packetId);
  if (!approved || !approvalMatchesPacket(approved, expectedPacket)) return;
  for (const decision of approved.proposal.decisions) {
    const operation = catalog.operations.find((candidate) => candidate.id === decision.operationId);
    if (!operation) continue;
    operation.businessCommand = {
      machineName: decision.machineName,
      label: decision.label,
      ...(decision.aliases?.length ? { aliases: decision.aliases } : {}),
      ...(decision.familyHint ? { familyHint: decision.familyHint } : {}),
      origin: 'human-reviewed',
    };
  }
}

export async function nextPacket(store: ArtifactStore): Promise<AgentPacket | undefined> {
  const packetDirectory = path.join(store.workDirectory, 'packets');
  const files = await store.listManagedDirectory(packetDirectory);
  for (const file of files.filter((candidate) => candidate.isFile() && candidate.name.endsWith('.json')).map((candidate) => candidate.name).sort()) {
    const packet = await inspectPacket(store, path.basename(file, '.json'));
    if (!(await packetMatchesCurrent(store, packet))) return packet;
    const approved = await readApproval(store, packet.packetId);
    if (!approved || !approvalMatchesPacket(approved, packet)) return packet;
  }
  return undefined;
}

async function assertPacketCurrent(store: ArtifactStore, packet: AgentPacket): Promise<void> {
  const evidence = await store.read<EvidenceGraph>('evidence');
  const currentSourceDigest = (await snapshotSources(store.config)).digest;
  if (packet.sourceDigest !== evidence.meta.sourceDigest || evidence.meta.sourceDigest !== currentSourceDigest) {
    throw new Error(`Packet ${packet.packetId} is stale because its source digest no longer matches the evidence graph.`);
  }
  if (packet.configDigest !== store.config.configDigest) {
    throw new Error(`Packet ${packet.packetId} is stale because its configuration digest no longer matches.`);
  }
}

async function packetMatchesCurrent(store: ArtifactStore, packet: AgentPacket): Promise<boolean> {
  const evidence = await store.read<EvidenceGraph>('evidence');
  const currentSourceDigest = (await snapshotSources(store.config)).digest;
  return packet.sourceDigest === evidence.meta.sourceDigest
    && evidence.meta.sourceDigest === currentSourceDigest
    && packet.configDigest === store.config.configDigest;
}

async function readApproval(store: ArtifactStore, packetId: string): Promise<AgentApproval | undefined> {
  try {
    const file = approvalFile(store, packetId);
    return ApprovalSchema.parse(JSON.parse(await store.readManagedFile(file)));
  } catch {
    // Missing, malformed and legacy approvals are all untrusted and therefore pending.
    return undefined;
  }
}

function approvalMatchesPacket(approval: AgentApproval, packet: AgentPacket): boolean {
  return approval.packetId === packet.packetId
    && approval.sourceDigest === packet.sourceDigest
    && approval.configDigest === packet.configDigest
    && approval.packetDigest === packet.packetDigest
    && approval.proposal.packetId === packet.packetId
    && approval.proposal.packetDigest === packet.packetDigest
    && approval.proposalDigest === digestProposal(approval.proposal);
}

function packetFile(store: ArtifactStore, packetId: string): string {
  const safePacketId = safeFileSegment(packetId, 'Packet ID');
  return safeChildPath(path.join(store.workDirectory, 'packets'), `${safePacketId}.json`);
}

function proposalFile(store: ArtifactStore, packetId: string): string {
  const safePacketId = safeFileSegment(packetId, 'Packet ID');
  return safeChildPath(path.join(store.workDirectory, 'proposals'), `${safePacketId}.json`);
}

function validatedProposalFile(store: ArtifactStore, packetId: string): string {
  const safePacketId = safeFileSegment(packetId, 'Packet ID');
  return safeChildPath(path.join(store.workDirectory, 'proposals'), `${safePacketId}.validated.json`);
}

function approvalFile(store: ArtifactStore, packetId: string): string {
  const safePacketId = safeFileSegment(packetId, 'Packet ID');
  return safeChildPath(store.decisionsDirectory, `${safePacketId}.approved.json`);
}

function digestPacketContent(content: Omit<AgentPacket, 'packetDigest'>): string {
  return sha256(stableJson(content));
}

function digestProposal(proposal: AgentProposal): string {
  return sha256(stableJson(proposal));
}
