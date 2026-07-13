import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ArtifactStore } from '../core/artifact-store.js';
import { stableJson } from '../core/stable.js';
import type { EvidenceGraph, OperationCatalog } from '../ir/model.js';

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
}

const ProposalSchema = z.object({
  packetId: z.string(),
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

export async function createOperationPacket(store: ArtifactStore, catalog: OperationCatalog): Promise<AgentPacket | undefined> {
  const candidates = catalog.operations.filter((operation) => operation.inclusion !== 'excluded');
  if (!candidates.length) return undefined;
  const packetId = 'packet.operation-semantics.v1';
  const outputPath = path.join(store.workDirectory, 'proposals', `${packetId}.json`);
  const packet: AgentPacket = {
    packetId,
    taskType: 'name-and-group-operations',
    question: 'Propose readable business-command names and semantic family hints for the source-supported terminal operations.',
    allowedEvidenceIds: [...new Set(candidates.flatMap((operation) => operation.evidenceRefs))].sort(),
    allowedOperationIds: candidates.map((operation) => operation.id).sort(),
    allowedOutputFields: ['operationId', 'label', 'machineName', 'aliases', 'familyHint', 'explanation', 'evidenceRefs'],
    forbiddenClaims: ['new predicates', 'new graph edges', 'satisfiability', 'runtime success', 'UAT identifiers', 'credentials'],
    responseSchema: 'agent-operation-proposal-v1',
    outputPath,
  };
  await fs.mkdir(path.join(store.workDirectory, 'packets'), { recursive: true });
  await fs.writeFile(path.join(store.workDirectory, 'packets', `${packetId}.json`), stableJson(packet), 'utf8');
  return packet;
}

export async function inspectPacket(store: ArtifactStore, packetId: string): Promise<AgentPacket> {
  return JSON.parse(await fs.readFile(path.join(store.workDirectory, 'packets', `${packetId}.json`), 'utf8')) as AgentPacket;
}

export async function validatePacketProposal(store: ArtifactStore, packetId: string): Promise<AgentProposal> {
  const packet = await inspectPacket(store, packetId);
  const proposal = ProposalSchema.parse(JSON.parse(await fs.readFile(packet.outputPath, 'utf8')));
  if (proposal.packetId !== packetId) throw new Error(`Proposal packetId ${proposal.packetId} does not match ${packetId}.`);
  const evidence = await store.read<EvidenceGraph>('evidence');
  const evidenceIds = new Set(evidence.data.nodes.map((node) => node.id));
  for (const decision of proposal.decisions) {
    if (!packet.allowedOperationIds.includes(decision.operationId)) throw new Error(`Operation ${decision.operationId} is not allowed by packet ${packetId}.`);
    for (const ref of decision.evidenceRefs) {
      if (!packet.allowedEvidenceIds.includes(ref) || !evidenceIds.has(ref)) throw new Error(`Evidence ${ref} is not allowed or does not exist.`);
    }
  }
  await fs.writeFile(path.join(store.workDirectory, 'proposals', `${packetId}.validated.json`), stableJson(proposal), 'utf8');
  return proposal;
}

export async function approvePacket(store: ArtifactStore, packetId: string, reviewer: string): Promise<string> {
  const proposal = await validatePacketProposal(store, packetId);
  const destination = path.join(store.decisionsDirectory, `${packetId}.approved.json`);
  await fs.mkdir(store.decisionsDirectory, { recursive: true });
  await fs.writeFile(destination, stableJson({ packetId, reviewer, proposal }), 'utf8');
  return destination;
}

export async function applyApprovedOperationDecisions(store: ArtifactStore, catalog: OperationCatalog): Promise<void> {
  const file = path.join(store.decisionsDirectory, 'packet.operation-semantics.v1.approved.json');
  try {
    const approved = JSON.parse(await fs.readFile(file, 'utf8')) as { proposal: AgentProposal };
    for (const decision of approved.proposal.decisions) {
      const operation = catalog.operations.find((candidate) => candidate.id === decision.operationId);
      if (!operation) continue;
      operation.businessCommand = { machineName: decision.machineName, label: decision.label, origin: 'human-reviewed' };
    }
  } catch {
    // Absence of a review decision leaves deterministic names in place.
  }
}

export async function nextPacket(store: ArtifactStore): Promise<AgentPacket | undefined> {
  const packetDirectory = path.join(store.workDirectory, 'packets');
  const files = await fs.readdir(packetDirectory).catch(() => []);
  for (const file of files.filter((candidate) => candidate.endsWith('.json')).sort()) {
    const packet = JSON.parse(await fs.readFile(path.join(packetDirectory, file), 'utf8')) as AgentPacket;
    const approved = path.join(store.decisionsDirectory, `${packet.packetId}.approved.json`);
    try {
      await fs.access(approved);
    } catch {
      return packet;
    }
  }
  return undefined;
}
