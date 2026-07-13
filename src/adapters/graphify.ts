import fs from 'node:fs/promises';
import path from 'node:path';
import type { FlowctlConfig } from '../core/config.js';
import { stableId } from '../core/stable.js';
import type { Diagnostic, EvidenceEdge, EvidenceEdgeKind, EvidenceNode, EvidenceNodeKind } from '../ir/model.js';

export interface GraphifyImport {
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
  diagnostics: Diagnostic[];
}

export async function importGraphify(config: FlowctlConfig): Promise<GraphifyImport> {
  const graphPath = path.resolve(config.projectRoot, config.graphify.graph);
  try {
    const raw = JSON.parse(await fs.readFile(graphPath, 'utf8')) as Record<string, unknown>;
    const rawNodes = arrayValue(raw.nodes ?? raw.vertices ?? raw.concepts);
    const rawEdges = arrayValue(raw.edges ?? raw.links ?? raw.relationships);
    const idMap = new Map<string, string>();

    const nodes = rawNodes.map((value, index) => {
      const node = recordValue(value);
      const rawId = stringValue(node.id ?? node.key ?? node.name, `node-${index}`);
      const canonicalKey = stringValue(node.qualified_name ?? node.qualifiedName ?? node.name ?? node.label, rawId);
      const id = stableId('graphify', canonicalKey);
      idMap.set(rawId, id);
      const file = stringValue(node.file ?? node.path ?? node.source, config.graphify.graph);
      const line = numberValue(node.line ?? node.start_line ?? node.startLine, 1);
      return {
        id,
        kind: mapNodeKind(stringValue(node.kind ?? node.type ?? node.category, 'concept')),
        canonicalKey,
        label: stringValue(node.label ?? node.name, canonicalKey),
        attributes: node,
        origin: sourceOrigin(node),
        confidence: sourceOrigin(node) === 'graphify-extracted' ? 'exact' as const : 'semantic' as const,
        sourceRefs: [{ file, line }],
      } satisfies EvidenceNode;
    });

    const edges = rawEdges.flatMap((value, index) => {
      const edge = recordValue(value);
      const rawFrom = stringValue(edge.source ?? edge.from ?? edge.start, '');
      const rawTo = stringValue(edge.target ?? edge.to ?? edge.end, '');
      const from = idMap.get(rawFrom);
      const to = idMap.get(rawTo);
      if (!from || !to) return [];
      const kind = mapEdgeKind(stringValue(edge.kind ?? edge.type ?? edge.relationship, 'references'));
      const origin = sourceOrigin(edge);
      return [{
        id: stableId('graphify-edge', `${from}:${kind}:${to}:${index}`),
        from,
        to,
        kind,
        origin,
        confidence: origin === 'graphify-extracted' ? 'exact' as const : 'semantic' as const,
        sourceRefs: [],
      } satisfies EvidenceEdge];
    });

    return { nodes, edges, diagnostics: [] };
  } catch (error) {
    if (config.graphify.required) throw error;
    return {
      nodes: [],
      edges: [],
      diagnostics: [{
        code: 'GRAPHIFY_NOT_AVAILABLE',
        severity: 'info',
        message: `Graphify graph not imported from ${config.graphify.graph}; source adapters continue independently.`,
      }],
    };
  }
}

function sourceOrigin(value: Record<string, unknown>): 'graphify-extracted' | 'graphify-inferred' {
  const raw = stringValue(value.origin ?? value.confidence ?? value.provenance ?? value.tag, '').toLowerCase();
  return raw.includes('extract') || raw === 'exact' ? 'graphify-extracted' : 'graphify-inferred';
}

function mapNodeKind(raw: string): EvidenceNodeKind {
  const value = raw.toLowerCase();
  if (value.includes('file')) return 'source-file';
  if (value.includes('route')) return 'route';
  if (value.includes('component') || value.includes('class') || value.includes('function')) return 'component';
  if (value.includes('endpoint') || value.includes('controller')) return 'java-endpoint';
  if (value.includes('permission') || value.includes('authority')) return 'permission';
  return 'concept';
}

function mapEdgeKind(raw: string): EvidenceEdgeKind {
  const value = raw.toLowerCase();
  if (value.includes('call')) return 'calls';
  if (value.includes('render')) return 'renders';
  if (value.includes('contain')) return 'contains';
  if (value.includes('request')) return 'requests';
  if (value.includes('valid')) return 'validates';
  if (value.includes('guard') || value.includes('require')) return 'requires';
  return 'references';
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : fallback;
}
