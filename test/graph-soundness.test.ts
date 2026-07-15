import { describe, expect, it } from 'vitest';
import type { FlowctlConfig } from '../src/core/config.js';
import { buildCoverage, buildEvidenceGraph, buildOperationCatalog, searchPaths } from '../src/pipeline/builders.js';
import type { BehaviorGraph, ExtractionBundle, FlowFamilies } from '../src/ir/model.js';

describe('graph proof soundness', () => {
  it('does not accept a shared success node without traversing the family operation success edge', () => {
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'screen.entry', kind: 'screen-state', label: 'Entry', attributes: {} },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', referenceId: 'operation.submit', attributes: {} },
        { id: 'outcome.success', kind: 'outcome', label: 'Success', attributes: {} },
      ],
      edges: [
        { id: 'edge.shortcut', from: 'screen.entry', to: 'outcome.success', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.action', from: 'screen.entry', to: 'action.submit', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.operation', from: 'action.submit', to: 'operation.submit', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.success', from: 'operation.submit', to: 'outcome.success', guard: { kind: 'constant', value: true }, effects: [], outcome: 'success', evidenceRefs: [] },
      ],
      entryNodeIds: ['screen.entry'],
      successNodeIds: ['outcome.success'],
    };
    const families: FlowFamilies = { families: [{
      id: 'application.submit',
      label: 'Submit application',
      operationIds: ['operation.submit'],
      entryNodeIds: ['screen.entry'],
      successNodeIds: ['outcome.success'],
      actorRequirementIds: [],
      evidenceRefs: [],
    }] };
    const config = { analysis: { entryRoutes: ['/entry'], maxPathDepth: 10, maxStateVisits: 2 } } as FlowctlConfig;

    const result = searchPaths(graph, families, config);

    expect(result.witnesses).toHaveLength(1);
    expect(result.witnesses[0]?.nodePath).toContain('operation.submit');
    expect(result.witnesses[0]?.edgePath.at(-1)).toBe('edge.success');
  });

  it('continues from an entry that is also the post-save success screen', () => {
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'screen.editor', kind: 'screen-state', label: 'Editor', attributes: {} },
        { id: 'action.save', kind: 'action', label: 'Save', attributes: {} },
        { id: 'operation.save', kind: 'operation', label: 'Save', referenceId: 'operation.save', attributes: {} },
      ],
      edges: [
        { id: 'edge.action', from: 'screen.editor', to: 'action.save', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.operation', from: 'action.save', to: 'operation.save', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.success', from: 'operation.save', to: 'screen.editor', guard: { kind: 'constant', value: true }, effects: [], outcome: 'success', evidenceRefs: [] },
      ],
      entryNodeIds: ['screen.editor'],
      successNodeIds: ['screen.editor'],
    };
    const families: FlowFamilies = { families: [{
      id: 'record.save', label: 'Save record', operationIds: ['operation.save'],
      entryNodeIds: ['screen.editor'], successNodeIds: ['screen.editor'], actorRequirementIds: [], evidenceRefs: [],
    }] };
    const config = { analysis: { entryRoutes: ['/editor'], maxPathDepth: 10, maxStateVisits: 2 } } as FlowctlConfig;

    const result = searchPaths(graph, families, config);

    expect(result.witnesses).toHaveLength(1);
    expect(result.witnesses[0]?.nodePath).toEqual(['screen.editor', 'action.save', 'operation.save', 'screen.editor']);
    expect(result.witnesses[0]?.edgePath.at(-1)).toBe('edge.success');
  });

  it('keeps a shortcut that skips a request-bound field review-only', () => {
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'screen.entry', kind: 'screen-state', label: 'Entry', attributes: { fieldIds: [] } },
        { id: 'screen.details', kind: 'screen-state', label: 'Details', attributes: { fieldIds: ['field.product-code'] } },
        { id: 'screen.review', kind: 'screen-state', label: 'Review', attributes: { fieldIds: [] } },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', referenceId: 'operation.submit', attributes: {} },
        { id: 'screen.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [
        { id: 'edge.details', from: 'screen.entry', to: 'screen.details', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.details-review', from: 'screen.details', to: 'screen.review', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.shortcut', from: 'screen.entry', to: 'screen.review', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.action', from: 'screen.review', to: 'action.submit', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        {
          id: 'edge.operation', from: 'action.submit', to: 'operation.submit', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [],
          requestPayloadContracts: [{
            id: 'request.product', status: 'fields-present', certainty: 'exact', dispatchGuard: { kind: 'constant', value: true },
            providedFields: ['productCode'], uiFieldBindings: { productCode: 'field.product-code' }, requiredFields: ['productCode'], missingRequiredFields: [],
          }],
        },
        { id: 'edge.success', from: 'operation.submit', to: 'screen.success', guard: { kind: 'constant', value: true }, effects: [], outcome: 'success', evidenceRefs: [] },
      ],
      entryNodeIds: ['screen.entry'],
      successNodeIds: ['screen.success'],
    };
    const families: FlowFamilies = { families: [{
      id: 'product.submit', label: 'Submit product', operationIds: ['operation.submit'],
      entryNodeIds: ['screen.entry'], successNodeIds: ['screen.success'], actorRequirementIds: [], evidenceRefs: [],
    }] };
    const config = { analysis: { entryRoutes: ['/'], maxPathDepth: 10, maxStateVisits: 2 } } as FlowctlConfig;

    const result = searchPaths(graph, families, config);
    const full = result.witnesses.find((witness) => witness.nodePath.includes('screen.details'));
    const shortcut = result.witnesses.find((witness) => !witness.nodePath.includes('screen.details'));

    expect(full?.feasibility).toBe('satisfiable');
    expect(shortcut?.feasibility).toBe('conditional');
    expect(shortcut?.pathCondition).toMatchObject({ kind: 'opaque' });
  });

  it('keeps structural graph roots review-only when no application entry route is configured', () => {
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'screen.midflow', kind: 'screen-state', label: 'Mid-flow', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', referenceId: 'operation.submit', attributes: {} },
        { id: 'screen.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [
        { id: 'edge.invoke', from: 'screen.midflow', to: 'operation.submit', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.success', from: 'operation.submit', to: 'screen.success', guard: { kind: 'constant', value: true }, effects: [], outcome: 'success', evidenceRefs: [] },
      ],
      entryNodeIds: ['screen.midflow'],
      successNodeIds: ['screen.success'],
    };
    const families: FlowFamilies = { families: [{
      id: 'application.submit', label: 'Submit application', operationIds: ['operation.submit'],
      entryNodeIds: ['screen.midflow'], successNodeIds: ['screen.success'], actorRequirementIds: [], evidenceRefs: [],
    }] };
    const config = { analysis: { entryRoutes: [], maxPathDepth: 10, maxStateVisits: 2 } } as unknown as FlowctlConfig;

    const result = searchPaths(graph, families, config);

    expect(result.witnesses).toHaveLength(1);
    expect(result.witnesses[0]).toMatchObject({ feasibility: 'conditional' });
    expect(result.witnesses[0]?.pathCondition).toMatchObject({ kind: 'opaque', sourceExpression: 'structural-entry:screen.midflow' });
  });

  it('reports exact max-path-depth pruning instead of treating a bounded search as disconnected', () => {
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'screen.entry', kind: 'screen-state', label: 'Entry', attributes: {} },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', referenceId: 'operation.submit', attributes: {} },
        { id: 'screen.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [
        { id: 'edge.action', from: 'screen.entry', to: 'action.submit', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.operation', from: 'action.submit', to: 'operation.submit', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.success', from: 'operation.submit', to: 'screen.success', guard: { kind: 'constant', value: true }, effects: [], outcome: 'success', evidenceRefs: [] },
      ],
      entryNodeIds: ['screen.entry'],
      successNodeIds: ['screen.success'],
    };
    const families: FlowFamilies = { families: [{
      id: 'application.submit', label: 'Submit application', operationIds: ['operation.submit'],
      entryNodeIds: ['screen.entry'], successNodeIds: ['screen.success'], actorRequirementIds: [], evidenceRefs: [],
    }] };
    const config = { analysis: { entryRoutes: ['/entry'], maxPathDepth: 3, maxStateVisits: 2 } } as FlowctlConfig;

    const result = searchPaths(graph, families, config);

    expect(result.witnesses).toEqual([]);
    expect(result.search).toMatchObject({
      bounds: { maxPathDepth: 3, maxStateVisits: 2 },
      enqueuedStates: 4,
      dequeuedStates: 4,
      truncation: {
        occurred: true,
        counts: { maxPathDepth: 1, maxStateVisits: 0 },
        details: [{
          reason: 'max-path-depth',
          familyId: 'application.submit',
          nodeId: 'screen.success',
          limit: 3,
          minimumObserved: 4,
          maximumObserved: 4,
          count: 1,
          sampleNodePath: ['screen.entry', 'action.submit', 'operation.submit', 'screen.success'],
          sampleEdgePath: ['edge.action', 'edge.operation', 'edge.success'],
        }],
      },
    });

    const coverage = buildCoverage(
      {
        sourceDigest: 'sha256:test', sourceFiles: [], routes: [], pages: [], handlers: [], actions: [], fields: [],
        httpOperations: [], navigations: [], permissions: [], endpoints: [], validations: [], effects: [], wikiConcepts: [],
        graphifyNodes: [], graphifyEdges: [], diagnostics: [],
      },
      { operations: [{
        id: 'operation.submit', method: 'POST', pathTemplate: '/applications', frontendOperationIds: ['http.submit'],
        backendEndpointId: 'endpoint.submit', actorRequirementIds: [], validationIds: [], terminalEffectIds: ['effect.submit'],
        businessCommand: { machineName: 'application.submit', label: 'Submit application', origin: 'deterministic' },
        inclusion: 'included', evidenceRefs: [],
      }] },
      { pages: [] },
      { actors: [] },
      graph,
      families,
      result,
      { variants: [] },
      [],
      { bindings: [] },
      config,
    );
    expect(coverage.counts.pathSearchDepthPrunes).toBe(1);
    expect(coverage.operationCoverage[0]).toMatchObject({
      missingStage: 'entry-success-witness',
      searchTruncationReasons: ['max-path-depth'],
    });
    expect(coverage.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PATH_SEARCH_MAX_DEPTH_TRUNCATED', severity: 'warning' }),
      expect.objectContaining({ code: 'IN_SCOPE_OPERATION_UNCOVERED', message: expect.stringContaining('bound-limited') }),
    ]));
  });

  it('reports exact max-state-visits transition pruning while preserving other witnesses', () => {
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'screen.entry', kind: 'screen-state', label: 'Entry', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', referenceId: 'operation.submit', attributes: {} },
        { id: 'screen.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [
        { id: 'edge.loop', from: 'screen.entry', to: 'screen.entry', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.loop.secondary', from: 'screen.entry', to: 'screen.entry', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.operation', from: 'screen.entry', to: 'operation.submit', guard: { kind: 'constant', value: true }, effects: [], outcome: 'neutral', evidenceRefs: [] },
        { id: 'edge.success', from: 'operation.submit', to: 'screen.success', guard: { kind: 'constant', value: true }, effects: [], outcome: 'success', evidenceRefs: [] },
      ],
      entryNodeIds: ['screen.entry'],
      successNodeIds: ['screen.success'],
    };
    const families: FlowFamilies = { families: [{
      id: 'application.submit', label: 'Submit application', operationIds: ['operation.submit'],
      entryNodeIds: ['screen.entry'], successNodeIds: ['screen.success'], actorRequirementIds: [], evidenceRefs: [],
    }] };
    const config = { analysis: { entryRoutes: ['/entry'], maxPathDepth: 10, maxStateVisits: 1 } } as FlowctlConfig;

    const result = searchPaths(graph, families, config);
    const reordered = searchPaths({ ...graph, edges: [...graph.edges].reverse() }, families, config);

    expect(result.witnesses).toHaveLength(1);
    expect(result.search?.truncation.counts).toEqual({ maxPathDepth: 0, maxStateVisits: 2 });
    expect(result.search?.truncation.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: 'max-state-visits', familyId: 'application.submit', nodeId: 'screen.entry', edgeId: 'edge.loop',
        limit: 1, minimumObserved: 2, maximumObserved: 2, count: 1,
        sampleNodePath: ['screen.entry', 'screen.entry'], sampleEdgePath: ['edge.loop'],
      }),
      expect.objectContaining({
        reason: 'max-state-visits', familyId: 'application.submit', nodeId: 'screen.entry', edgeId: 'edge.loop.secondary',
        limit: 1, minimumObserved: 2, maximumObserved: 2, count: 1,
        sampleNodePath: ['screen.entry', 'screen.entry'], sampleEdgePath: ['edge.loop.secondary'],
      }),
    ]));
    expect(reordered.search).toEqual(result.search);
  });

  it('carries endpoint source locations onto derived evidence edges', () => {
    const sourceRef = { file: 'ApplicationController.java', line: 42, symbol: 'submit' };
    const bundle: ExtractionBundle = {
      sourceDigest: 'sha256:test',
      sourceFiles: [],
      routes: [],
      pages: [],
      handlers: [],
      actions: [],
      fields: [],
      httpOperations: [{ id: 'http.submit', method: 'POST', pathTemplate: '/api/applications', sourceRef: { file: 'api.ts', line: 10 } }],
      navigations: [],
      permissions: [],
      endpoints: [{
        id: 'endpoint.submit',
        method: 'POST',
        pathTemplate: '/api/applications',
        controller: 'ApplicationController',
        handler: 'submit',
        authorization: { status: 'anonymous', sourceRefs: [] },
        domainGuard: { kind: 'constant', value: true },
        permissionIds: [],
        validationIds: [],
        terminalEffectIds: [],
        sourceRef,
      }],
      validations: [],
      effects: [],
      wikiConcepts: [],
      graphifyNodes: [],
      graphifyEdges: [],
      diagnostics: [],
    };

    const edge = buildEvidenceGraph(bundle).edges.find((candidate) => candidate.kind === 'handled-by');

    expect(edge?.sourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'api.ts', line: 10 }),
      expect.objectContaining(sourceRef),
    ]));
  });

  it('keeps the matched Wiki concept in provenance when it enriches a command label', () => {
    const sourceRef = { file: 'ApplicationController.java', line: 1 };
    const bundle: ExtractionBundle = {
      sourceDigest: 'sha256:test', sourceFiles: [], routes: [], pages: [], handlers: [], actions: [], fields: [],
      httpOperations: [{ id: 'http.open', method: 'POST', pathTemplate: '/api/accounts', sourceRef: { file: 'api.ts', line: 1 } }],
      navigations: [], permissions: [],
      endpoints: [{
        id: 'endpoint.open', method: 'POST', pathTemplate: '/api/accounts', controller: 'AccountController', handler: 'open',
        authorization: { status: 'anonymous', sourceRefs: [] }, domainGuard: { kind: 'constant', value: true },
        permissionIds: [], validationIds: [], terminalEffectIds: ['effect.account'], sourceRef,
      }],
      validations: [],
      effects: [{ id: 'effect.account', entity: 'Account', kind: 'entity-created', sourceRef }],
      wikiConcepts: [{
        id: 'wiki.account', canonicalLabel: 'Customer Account', aliases: ['Account'],
        sourceRef: { file: 'wiki/domain.md', line: 3 },
      }],
      graphifyNodes: [], graphifyEdges: [], diagnostics: [],
    };

    const operation = buildOperationCatalog(bundle).operations[0]!;

    expect(operation.businessCommand.origin).toBe('wiki');
    expect(operation.evidenceRefs).toContain('wiki.account');
  });

  it('keeps overloaded backend mappings distinct and review-required', () => {
    const sourceRef = { file: 'ApplicationController.java', line: 1 };
    const endpoint = (id: string, handler: string, effectId: string) => ({
      id, method: 'POST', pathTemplate: '/api/applications', controller: 'ApplicationController', handler,
      authorization: { status: 'anonymous' as const, sourceRefs: [] },
      domainGuard: { kind: 'constant' as const, value: true }, permissionIds: [], validationIds: [], terminalEffectIds: [effectId], sourceRef,
    });
    const bundle: ExtractionBundle = {
      sourceDigest: 'sha256:test', sourceFiles: [], routes: [], pages: [], handlers: [], actions: [], fields: [],
      httpOperations: [{ id: 'http.submit', method: 'POST', pathTemplate: '/api/applications', sourceRef: { file: 'api.ts', line: 1 } }],
      navigations: [], permissions: [],
      endpoints: [endpoint('endpoint.personal', 'submitPersonal', 'effect.personal'), endpoint('endpoint.joint', 'submitJoint', 'effect.joint')],
      validations: [],
      effects: [
        { id: 'effect.personal', entity: 'Application', kind: 'entity-created', sourceRef },
        { id: 'effect.joint', entity: 'Application', kind: 'entity-created', sourceRef },
      ],
      wikiConcepts: [], graphifyNodes: [], graphifyEdges: [], diagnostics: [],
    };

    const catalog = buildOperationCatalog(bundle);
    expect(new Set(catalog.operations.map((operation) => operation.id)).size).toBe(2);
    expect(catalog.operations.every((operation) => operation.inclusion === 'review-required')).toBe(true);
    expect(bundle.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JAVA_ENDPOINT_MAPPING_COLLISION' }),
    ]));
  });
});
