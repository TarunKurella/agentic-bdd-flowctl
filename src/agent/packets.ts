import path from 'node:path';
import { z } from 'zod';
import { snapshotSources } from '../adapters/source.js';
import type { ArtifactStore } from '../core/artifact-store.js';
import { safeChildPath, safeFileSegment } from '../core/paths.js';
import { sha256, stableId, stableJson } from '../core/stable.js';
import { predicateFromExpression, solvePredicate } from '../ir/predicates.js';
import type { EvidenceGraph, ExtractionBundle, OperationCatalog, Predicate } from '../ir/model.js';

const OPERATION_PACKET_ID = 'packet.operation-semantics.v1';
const RULE_PACKET_ID = 'packet.operation-rules.v1';

export interface RuleGap {
  endpointId: string;
  gapKinds: Array<'authorization' | 'success-predicate'>;
  allowedPredicatePaths: string[];
  allowedAuthorities: string[];
}

export interface AgentPacket {
  packetId: string;
  taskType: 'name-and-group-operations' | 'resolve-operation-rules';
  question: string;
  allowedEvidenceIds: string[];
  allowedOperationIds: string[];
  allowedEndpointIds?: string[];
  ruleGaps?: RuleGap[];
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
  taskType: z.enum(['name-and-group-operations', 'resolve-operation-rules']),
  question: z.string(),
  allowedEvidenceIds: z.array(z.string()),
  allowedOperationIds: z.array(z.string()),
  allowedEndpointIds: z.array(z.string()).optional(),
  ruleGaps: z.array(z.object({
    endpointId: z.string(),
    gapKinds: z.array(z.enum(['authorization', 'success-predicate'])),
    allowedPredicatePaths: z.array(z.string()),
    allowedAuthorities: z.array(z.string()),
  })).optional(),
  allowedOutputFields: z.array(z.string()),
  forbiddenClaims: z.array(z.string()),
  responseSchema: z.string(),
  outputPath: z.string(),
  sourceDigest: z.string(),
  configDigest: z.string(),
  packetDigest: z.string(),
});

const OperationProposalSchema = z.object({
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

const RuleProposalSchema = z.object({
  packetId: z.string(),
  packetDigest: z.string(),
  resolutions: z.array(z.object({
    endpointId: z.string(),
    authorization: z.discriminatedUnion('status', [
      z.object({ status: z.literal('anonymous') }),
      z.object({ status: z.literal('authenticated') }),
      z.object({ status: z.literal('exact'), authoritiesAll: z.array(z.string().trim().min(1)).min(1) }),
    ]).optional(),
    successPredicateExpression: z.string().trim().min(1).optional(),
    explanation: z.string().trim().min(1),
    evidenceRefs: z.array(z.string()).min(1),
  })),
  unresolved: z.array(z.object({
    endpointId: z.string().optional(),
    question: z.string().trim().min(1),
    evidenceRefs: z.array(z.string()),
  })).default([]),
});

const ProposalSchema = z.union([OperationProposalSchema, RuleProposalSchema]);

export type AgentProposal = z.infer<typeof ProposalSchema>;

export function proposalImpact(proposal: AgentProposal): {
  changedFacts: string[];
  recompiles: string[];
  executableOnlyAfterApproval: true;
} {
  if ('decisions' in proposal) return {
    changedFacts: proposal.decisions.map((decision) => `business-command:${decision.operationId}`),
    recompiles: ['operation-catalog', 'flow-families', 'flow-variants', 'BDD wording'],
    executableOnlyAfterApproval: true,
  };
  return {
    changedFacts: proposal.resolutions.flatMap((resolution) => [
      ...(resolution.authorization ? [`authorization:${resolution.endpointId}`] : []),
      ...(resolution.successPredicateExpression ? [`success-predicate:${resolution.endpointId}`] : []),
    ]),
    recompiles: ['evidence-graph', 'operation-catalog', 'actor-requirements', 'behavior-graph', 'path-witnesses', 'flow-variants', 'data-requirements', 'BDD'],
    executableOnlyAfterApproval: true,
  };
}

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

export async function createRulePacket(store: ArtifactStore, bundle: ExtractionBundle): Promise<AgentPacket | undefined> {
  const packet = await buildRulePacket(store, bundle);
  if (!packet) {
    await Promise.all([
      store.removeManagedFile(packetFile(store, RULE_PACKET_ID)),
      store.removeManagedFile(proposalFile(store, RULE_PACKET_ID)),
      store.removeManagedFile(validatedProposalFile(store, RULE_PACKET_ID)),
    ]);
    return undefined;
  }
  await store.writeManagedFile(packetFile(store, packet.packetId), stableJson(packet));
  return packet;
}

async function buildRulePacket(store: ArtifactStore, bundle: ExtractionBundle): Promise<AgentPacket | undefined> {
  const ruleGaps: RuleGap[] = bundle.endpoints
    .filter((endpoint) => store.config.analysis.includeHttpMethods.includes(endpoint.method.toUpperCase()) && endpoint.terminalEffectIds.length)
    .map((endpoint): RuleGap | undefined => {
      const gapKinds: RuleGap['gapKinds'] = [];
      if (endpoint.authorization.status === 'conditional') gapKinds.push('authorization');
      if (solvePredicate(endpoint.domainGuard).status === 'conditional') gapKinds.push('success-predicate');
      if (!gapKinds.length) return undefined;
      const validationPaths = [...new Set(bundle.validations
        .filter((validation) => endpoint.validationIds.includes(validation.id))
        .map((validation) => validation.fieldPath))];
      const leafCounts = validationPaths.reduce<Record<string, number>>((counts, value) => {
        const leaf = value.split('.').at(-1)!;
        counts[leaf] = (counts[leaf] ?? 0) + 1;
        return counts;
      }, {});
      return {
        endpointId: endpoint.id,
        gapKinds,
        allowedPredicatePaths: [...new Set([
          ...validationPaths,
          ...validationPaths.map((value) => value.split('.').at(-1)!).filter((leaf) => leafCounts[leaf] === 1),
        ])].sort(),
        allowedAuthorities: authorityCandidates(endpoint.authorization.sourceExpression),
      };
    })
    .filter((gap): gap is RuleGap => Boolean(gap));
  if (!ruleGaps.length) return undefined;
  const evidence = await store.read<EvidenceGraph>('evidence');
  const endpointIds = ruleGaps.map((gap) => gap.endpointId).sort();
  const candidateFactIds = new Set(bundle.endpoints
    .filter((endpoint) => endpointIds.includes(endpoint.id))
    .flatMap((endpoint) => [...endpoint.validationIds, ...endpoint.terminalEffectIds]));
  const backendEvidenceIds = evidence.data.nodes.filter((node) => (
    endpointIds.includes(node.id)
    || candidateFactIds.has(node.id)
    || (node.kind === 'source-file' && node.sourceRefs.some((ref) => ref.file.endsWith('.java')))
  )).map((node) => node.id);
  const content: Omit<AgentPacket, 'packetDigest'> = {
    packetId: RULE_PACKET_ID,
    taskType: 'resolve-operation-rules',
    question: 'Resolve only the listed authorization and successful-acceptance gaps by reconciling independent endpoint, security, service and DTO evidence. Leave any rule unresolved when the evidence does not support one exact interpretation.',
    allowedEvidenceIds: [...new Set([...endpointIds, ...backendEvidenceIds])].sort(),
    allowedOperationIds: [],
    allowedEndpointIds: endpointIds,
    ruleGaps,
    allowedOutputFields: ['endpointId', 'authorization', 'successPredicateExpression', 'explanation', 'evidenceRefs'],
    forbiddenClaims: ['new graph edges', 'new validation values', 'runtime success', 'UAT identifiers', 'credentials', 'predicates outside allowedPredicatePaths', 'human approval'],
    responseSchema: 'agent-rule-proposal-v1',
    outputPath: proposalFile(store, RULE_PACKET_ID),
    sourceDigest: evidence.meta.sourceDigest,
    configDigest: store.config.configDigest,
  };
  return { ...content, packetDigest: digestPacketContent(content) };
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
  const packet = PacketSchema.parse(JSON.parse(await store.readManagedFile(packetFile(store, packetId)))) as AgentPacket;
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
  if (packet.taskType === 'name-and-group-operations') {
    if (!('decisions' in proposal)) throw new Error(`Packet ${packetId} requires an operation semantic proposal.`);
    for (const decision of proposal.decisions) {
      if (!packet.allowedOperationIds.includes(decision.operationId)) throw new Error(`Operation ${decision.operationId} is not allowed by packet ${packetId}.`);
      assertEvidenceRefs(packet, evidenceIds, decision.evidenceRefs);
    }
    for (const unresolved of proposal.unresolved) {
      if (unresolved.operationId && !packet.allowedOperationIds.includes(unresolved.operationId)) {
        throw new Error(`Unresolved operation ${unresolved.operationId} is not allowed by packet ${packetId}.`);
      }
      assertEvidenceRefs(packet, evidenceIds, unresolved.evidenceRefs);
    }
  } else {
    if (!('resolutions' in proposal)) throw new Error(`Packet ${packetId} requires an operation-rule proposal.`);
    validateRuleProposal(packet, proposal, evidenceIds, evidence.data.nodes);
  }
  await store.writeManagedFile(validatedProposalFile(store, packetId), stableJson({
    packetId,
    packetDigest: packet.packetDigest,
    proposalDigest: digestProposal(proposal),
    proposal,
  }));
  return proposal;
}

function validateRuleProposal(
  packet: AgentPacket,
  proposal: z.infer<typeof RuleProposalSchema>,
  evidenceIds: Set<string>,
  evidenceNodes: EvidenceGraph['nodes'],
): void {
  const gaps = new Map((packet.ruleGaps ?? []).map((gap) => [gap.endpointId, gap]));
  const seen = new Set<string>();
  for (const resolution of proposal.resolutions) {
    const gap = gaps.get(resolution.endpointId);
    if (!gap || !(packet.allowedEndpointIds ?? []).includes(resolution.endpointId)) {
      throw new Error(`Endpoint ${resolution.endpointId} is not allowed by packet ${packet.packetId}.`);
    }
    if (seen.has(resolution.endpointId)) throw new Error(`Endpoint ${resolution.endpointId} is resolved more than once.`);
    seen.add(resolution.endpointId);
    if (!resolution.authorization && !resolution.successPredicateExpression) {
      throw new Error(`Resolution ${resolution.endpointId} does not resolve any listed gap.`);
    }
    if (resolution.authorization && !gap.gapKinds.includes('authorization')) {
      throw new Error(`Endpoint ${resolution.endpointId} has no authorization gap.`);
    }
    if (resolution.authorization?.status === 'exact') {
      const invented = resolution.authorization.authoritiesAll.filter((authority) => !gap.allowedAuthorities.includes(authority));
      if (invented.length) throw new Error(`Authorization for ${resolution.endpointId} uses unapproved authority value(s): ${invented.join(', ')}.`);
    }
    if (resolution.successPredicateExpression) {
      if (!gap.gapKinds.includes('success-predicate')) throw new Error(`Endpoint ${resolution.endpointId} has no success-predicate gap.`);
      const predicate = predicateFromExpression(resolution.successPredicateExpression);
      if (predicate.kind === 'opaque' || (predicate.kind === 'constant' && predicate.value) || solvePredicate(predicate).status === 'conditional') {
        throw new Error(`Success predicate for ${resolution.endpointId} is outside the supported exact predicate subset.`);
      }
      const unapprovedPaths = predicatePaths(predicate).filter((value) => !gap.allowedPredicatePaths.includes(value));
      if (unapprovedPaths.length) throw new Error(`Success predicate for ${resolution.endpointId} uses unapproved path(s): ${unapprovedPaths.join(', ')}.`);
    }
    if (!resolution.evidenceRefs.includes(resolution.endpointId)) {
      throw new Error(`Resolution ${resolution.endpointId} must cite its endpoint evidence ID.`);
    }
    const endpointFiles = new Set(evidenceNodes.find((node) => node.id === resolution.endpointId)?.sourceRefs.map((ref) => ref.file) ?? []);
    const independentlySupported = resolution.evidenceRefs.some((ref) => (
      ref !== resolution.endpointId
      && evidenceNodes.find((node) => node.id === ref)?.sourceRefs.some((sourceRef) => !endpointFiles.has(sourceRef.file))
    ));
    if (!independentlySupported) {
      throw new Error(`Resolution ${resolution.endpointId} must cite independent evidence from a different source file.`);
    }
    assertEvidenceRefs(packet, evidenceIds, resolution.evidenceRefs);
  }
  for (const unresolved of proposal.unresolved) {
    if (unresolved.endpointId && !gaps.has(unresolved.endpointId)) {
      throw new Error(`Unresolved endpoint ${unresolved.endpointId} is not allowed by packet ${packet.packetId}.`);
    }
    assertEvidenceRefs(packet, evidenceIds, unresolved.evidenceRefs);
  }
  for (const gap of gaps.values()) {
    const resolution = proposal.resolutions.find((candidate) => candidate.endpointId === gap.endpointId);
    const explicitlyUnresolved = proposal.unresolved.some((candidate) => candidate.endpointId === gap.endpointId);
    for (const kind of gap.gapKinds) {
      const addressed = kind === 'authorization'
        ? Boolean(resolution?.authorization)
        : Boolean(resolution?.successPredicateExpression);
      if (!addressed && !explicitlyUnresolved) {
        throw new Error(`Gap ${kind} for ${gap.endpointId} must be resolved or explicitly listed as unresolved.`);
      }
    }
  }
}

function authorityCandidates(expression?: string): string[] {
  if (!expression) return [];
  const values: string[] = [];
  for (const match of expression.matchAll(/hasAuthority\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1]) values.push(match[1]);
  }
  for (const match of expression.matchAll(/hasRole\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1]) values.push(match[1].startsWith('ROLE_') ? match[1] : `ROLE_${match[1]}`);
  }
  return [...new Set(values)].sort();
}

function assertEvidenceRefs(packet: AgentPacket, evidenceIds: Set<string>, refs: string[]): void {
  for (const ref of refs) {
    if (!packet.allowedEvidenceIds.includes(ref) || !evidenceIds.has(ref)) {
      throw new Error(`Evidence ${ref} is not allowed or does not exist.`);
    }
  }
}

function predicatePaths(predicate: Predicate): string[] {
  const paths: string[] = [];
  const value = (candidate: { kind: string; path?: string }): void => {
    if (candidate.kind === 'path' && candidate.path) paths.push(candidate.path);
  };
  const visit = (candidate: Predicate): void => {
    if (candidate.kind === 'not') visit(candidate.operand);
    else if (candidate.kind === 'all' || candidate.kind === 'any') candidate.operands.forEach(visit);
    else if (candidate.kind === 'exists') value(candidate.value);
    else if (candidate.kind === 'compare') { value(candidate.left); value(candidate.right); }
    else if (candidate.kind === 'member-of') { value(candidate.value); candidate.values.forEach(value); }
  };
  visit(predicate);
  return [...new Set(paths)].sort();
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
  if (!('decisions' in approved.proposal)) return;
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

export async function applyApprovedRuleDecisions(store: ArtifactStore, bundle: ExtractionBundle): Promise<void> {
  const expectedPacket = await buildRulePacket(store, bundle);
  if (!expectedPacket) return;
  const approved = await readApproval(store, expectedPacket.packetId);
  if (!approved || !approvalMatchesPacket(approved, expectedPacket) || !('resolutions' in approved.proposal)) return;
  for (const resolution of approved.proposal.resolutions) {
    const endpoint = bundle.endpoints.find((candidate) => candidate.id === resolution.endpointId);
    if (!endpoint) continue;
    if (resolution.authorization) {
      endpoint.permissionIds = [];
      if (resolution.authorization.status === 'anonymous') {
        endpoint.authorization = { status: 'anonymous', sourceRefs: [endpoint.sourceRef] };
      } else if (resolution.authorization.status === 'authenticated') {
        endpoint.authorization = { status: 'authenticated', sourceRefs: [endpoint.sourceRef] };
      } else {
        const permissions = resolution.authorization.authoritiesAll.map((authority) => ({
          id: stableId('permission', `reviewed:${endpoint.id}:${authority}`),
          authority,
          layer: 'backend' as const,
          origin: 'human-reviewed' as const,
          sourceRef: endpoint.sourceRef,
        }));
        bundle.permissions.push(...permissions.filter((permission) => !bundle.permissions.some((candidate) => candidate.id === permission.id)));
        endpoint.permissionIds = permissions.map((permission) => permission.id);
        endpoint.authorization = { status: 'exact', sourceRefs: [endpoint.sourceRef] };
      }
      bundle.diagnostics = bundle.diagnostics.filter((diagnostic) => !(
        diagnostic.code === 'JAVA_AUTHORIZATION_CONDITIONAL'
        && diagnostic.evidenceRefs?.includes(endpoint.id)
      ));
    }
    if (resolution.successPredicateExpression) {
      endpoint.domainGuard = predicateFromExpression(resolution.successPredicateExpression);
      bundle.diagnostics = bundle.diagnostics.filter((diagnostic) => !(
        diagnostic.code === 'JAVA_DOMAIN_GUARD_CONDITIONAL'
        && diagnostic.evidenceRefs?.includes(endpoint.id)
      ));
    }
    endpoint.semanticResolution = {
      packetId: expectedPacket.packetId,
      reviewer: approved.reviewer,
      approvedAt: approved.approvedAt,
      proposalDigest: approved.proposalDigest,
      evidenceRefs: resolution.evidenceRefs,
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

function digestPacketContent(content: object): string {
  return sha256(stableJson(content));
}

function digestProposal(proposal: AgentProposal): string {
  return sha256(stableJson(proposal));
}
