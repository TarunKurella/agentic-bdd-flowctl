import { Lang, parse } from '@ast-grep/napi';
import { snapshotSources, type SourceFile } from '../adapters/source.js';
import type { ArtifactStore } from '../core/artifact-store.js';
import type {
  CoverageReport,
  Diagnostic,
  EvidenceGraph,
  EvidenceNode,
  OperationCatalog,
  SourceRef,
} from '../ir/model.js';

type MissingStage = NonNullable<CoverageReport['operationCoverage'][number]['missingStage']>;

export interface SourceRepairPlan {
  schemaVersion: 'flowctl.source-repair.v1';
  sourceDigest: string;
  status: 'source-repair-required' | 'no-source-repair-required';
  rules: string[];
  gaps: Array<{
    operationId: string;
    businessCommand: string;
    method: string;
    pathTemplate: string;
    missingStage: MissingStage;
    repairQuestion: string;
    searchTruncationReasons: string[];
    evidence: Array<{
      id: string;
      kind: EvidenceNode['kind'];
      label: string;
      confidence: EvidenceNode['confidence'];
      sourceRefs: SourceRef[];
    }>;
    agentHints: Array<{
      origin: 'ast-grep-hint';
      file: string;
      line: number;
      kind: string;
      excerpt: string;
      reason: string;
    }>;
    diagnostics: Diagnostic[];
  }>;
}

const REPAIR_QUESTIONS: Record<MissingStage, string> = {
  'frontend-client-join': 'Can exact source evidence prove that a React HTTP request and this endpoint have the same normalized method and path?',
  'action-operation-join': 'Can exact source evidence connect a rendered control through its callback/component chain to the matched HTTP request?',
  'success-continuation': 'Can exact backend and UI evidence prove a successful terminal effect and the state or outcome reached after it?',
  'flow-family': 'Can the successful operation be assigned to a deterministic business-command family without inventing domain meaning?',
  'entry-success-witness': 'Can source-derived routes, composed controls and satisfiable guards connect a configured entry route to this success?',
  'behavior-variant': 'Can the witness be reduced to a distinct actor, page, action, validation and outcome signature?',
};

export async function buildSourceRepairPlan(store: ArtifactStore): Promise<SourceRepairPlan> {
  const [coverage, catalog, evidence, snapshot] = await Promise.all([
    store.read<CoverageReport>('coverage'),
    store.read<OperationCatalog>('operations'),
    store.read<EvidenceGraph>('evidence'),
    snapshotSources(store.config),
  ]);
  if (snapshot.digest !== coverage.meta.sourceDigest) {
    throw new Error('Source repair cannot use stale coverage; rerun discovery before building the repair plan.');
  }
  const operations = new Map(catalog.data.operations.map((operation) => [operation.id, operation]));
  const nodes = new Map(evidence.data.nodes.map((node) => [node.id, node]));

  const gaps = coverage.data.operationCoverage
    .filter((row): row is typeof row & { missingStage: MissingStage } => row.status === 'uncovered' && row.missingStage !== undefined)
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
    .map((row) => {
      const operation = operations.get(row.operationId);
      if (!operation) throw new Error(`Coverage references missing operation ${row.operationId}.`);
      const seedIds = new Set([
        ...operation.evidenceRefs,
        operation.backendEndpointId,
        ...operation.frontendOperationIds,
        ...operation.terminalEffectIds,
      ]);
      const neighborhood = expandEvidenceNeighborhood(evidence.data, seedIds, 2, 80);
      const relatedIds = new Set([operation.id, ...seedIds, ...neighborhood]);
      const relatedDiagnostics = [...evidence.data.diagnostics, ...coverage.data.unresolved]
        .filter((diagnostic) => diagnostic.scope === operation.id
          || (diagnostic.evidenceRefs ?? []).some((reference) => relatedIds.has(reference)))
        .filter((diagnostic, index, all) => all.findIndex((candidate) => diagnosticKey(candidate) === diagnosticKey(diagnostic)) === index)
        .sort((left, right) => diagnosticKey(left).localeCompare(diagnosticKey(right)))
        .slice(0, 40);
      return {
        operationId: operation.id,
        businessCommand: operation.businessCommand.machineName,
        method: operation.method,
        pathTemplate: operation.pathTemplate,
        missingStage: row.missingStage,
        repairQuestion: REPAIR_QUESTIONS[row.missingStage],
        searchTruncationReasons: [...(row.searchTruncationReasons ?? [])],
        evidence: [...neighborhood]
          .map((id) => nodes.get(id))
          .filter((node): node is EvidenceNode => node !== undefined)
          .filter((node) => node.sourceRefs.length > 0)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((node) => ({
            id: node.id,
            kind: node.kind,
            label: node.label,
            confidence: node.confidence,
            sourceRefs: node.sourceRefs,
          })),
        agentHints: buildAstGrepHints(snapshot.files, operation.method, operation.pathTemplate, operation.businessCommand.machineName),
        diagnostics: relatedDiagnostics,
      };
    });

  return {
    schemaVersion: 'flowctl.source-repair.v1',
    sourceDigest: coverage.meta.sourceDigest,
    status: gaps.length ? 'source-repair-required' : 'no-source-repair-required',
    rules: [
      'Treat this as a bounded compiler-evidence task, not permission to edit the application into passing a test.',
      'Use the cited source spans to prove a missing edge; do not infer canonical behavior from Graphify, Wiki text, runtime clicks or naming alone.',
      'The assistant may use ast-grep or repository search to find nearby candidate patterns, but those matches are investigation hints and never canonical graph edges.',
      'Prefer an extractor or join improvement that generalizes to the source pattern. Change configuration only when a reviewed application contract proves the value.',
      'After a repair, rerun discovery and require a source-to-success witness before generating executable BDD.',
    ],
    gaps,
  };
}

export function renderSourceRepairPlan(plan: SourceRepairPlan): string {
  const lines = [
    'FLOWCTL SOURCE REPAIR',
    '',
    `Status  ${plan.status}`,
    `Gaps    ${plan.gaps.length}`,
  ];
  for (const gap of plan.gaps) {
    lines.push(
      '',
      `${gap.businessCommand} · ${gap.method} ${gap.pathTemplate}`,
      `Stopped at: ${gap.missingStage}`,
      `Question: ${gap.repairQuestion}`,
      `Evidence: ${gap.evidence.length} source-backed node(s) · ${gap.agentHints.length} ast-grep hint(s) · ${gap.diagnostics.length} related diagnostic(s)`,
    );
    gap.evidence.slice(0, 8).forEach((item) => {
      const locations = item.sourceRefs.map((source) => `${source.file}:${source.line}`).join(', ');
      lines.push(`- ${item.kind} ${item.label} — ${locations}`);
    });
    gap.agentHints.slice(0, 5).forEach((hint) => lines.push(`- hint ${hint.kind} — ${hint.file}:${hint.line} — ${hint.excerpt}`));
  }
  lines.push('', 'RULES', ...plan.rules.map((rule) => `- ${rule}`));
  return lines.join('\n');
}

function buildAstGrepHints(
  files: SourceFile[],
  method: string,
  pathTemplate: string,
  businessCommand: string,
  limit = 24,
): SourceRepairPlan['gaps'][number]['agentHints'] {
  const entityTerms = [...new Set([
    ...pathTemplate.split('/').filter((part) => part && part !== 'api' && !part.startsWith('{')),
    businessCommand.split('.')[0] ?? '',
  ].map((term) => term.replace(/[^A-Za-z0-9_$-]/g, '')).filter((term) => term.length >= 3))];
  const actionTerms = [...new Set([
    businessCommand.split('.').at(-1) ?? '',
    method.toLowerCase(),
  ].filter((term) => term.length >= 3))];
  if (!entityTerms.length) return [];
  const regex = `(?i)(?:${entityTerms.map(escapeRegex).join('|')})`;
  const candidates: Array<SourceRepairPlan['gaps'][number]['agentHints'][number] & { score: number }> = [];
  for (const file of files.filter((candidate) => candidate.language === 'typescript')) {
    let root;
    try {
      root = parse(file.relativePath.endsWith('.tsx') ? Lang.Tsx : Lang.TypeScript, file.contents).root();
    } catch {
      continue;
    }
    for (const kind of ['call_expression', 'string'] as const) {
      for (const node of root.findAll({ rule: { kind, regex } })) {
        const excerpt = node.text().replace(/\s+/g, ' ').trim().slice(0, 240);
        if (!excerpt) continue;
        candidates.push({
          origin: 'ast-grep-hint',
          file: file.relativePath,
          line: node.range().start.line + 1,
          kind,
          excerpt,
          reason: `Structural search matched entity term(s) ${entityTerms.join(', ')}${actionTerms.length ? ` near action term(s) ${actionTerms.join(', ')}` : ''}. Inspect only; this match cannot create a graph edge.`,
          score: actionTerms.some((term) => excerpt.toLowerCase().includes(term.toLowerCase())) ? 2 : 1,
        });
      }
    }
  }
  return candidates
    .sort((left, right) => right.score - left.score
      || left.file.localeCompare(right.file)
      || left.line - right.line
      || left.kind.localeCompare(right.kind)
      || left.excerpt.localeCompare(right.excerpt))
    .filter((candidate, index, all) => all.findIndex((value) => (
      value.file === candidate.file && value.line === candidate.line && value.kind === candidate.kind && value.excerpt === candidate.excerpt
    )) === index)
    .slice(0, limit)
    .map(({ score: _score, ...hint }) => hint);
}

function expandEvidenceNeighborhood(graph: EvidenceGraph, seeds: Set<string>, depth: number, limit: number): Set<string> {
  const visited = new Set([...seeds]);
  let frontier = [...seeds].sort();
  for (let level = 0; level < depth && frontier.length && visited.size < limit; level += 1) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (frontier.includes(edge.from) && !visited.has(edge.to)) next.add(edge.to);
      if (frontier.includes(edge.to) && !visited.has(edge.from)) next.add(edge.from);
    }
    frontier = [...next].sort().slice(0, Math.max(0, limit - visited.size));
    frontier.forEach((id) => visited.add(id));
  }
  return visited;
}

function diagnosticKey(diagnostic: Diagnostic): string {
  return `${diagnostic.code}\u0000${diagnostic.scope ?? ''}\u0000${diagnostic.message}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
