import { stableId, stableJson, stableSort, sha256, slug } from '../core/stable.js';
import { allPredicates, predicateLabel, solvePredicate, TRUE } from '../ir/predicates.js';
import type {
  ActorRequirement,
  ActorRequirements,
  BehaviorEdge,
  BehaviorGraph,
  BehaviorNode,
  CoverageReport,
  DataRequirement,
  Diagnostic,
  EvidenceEdge,
  EvidenceGraph,
  EvidenceNode,
  ExtractionBundle,
  FlowFamilies,
  FlowFamily,
  FlowVariant,
  FlowVariants,
  OperationCatalog,
  OperationCatalogEntry,
  PageContract,
  PageContracts,
  PathWitness,
  PathWitnesses,
  Predicate,
  ReactFieldFact,
  RuntimeBindings,
} from '../ir/model.js';
import type { FlowctlConfig } from '../core/config.js';

export function buildEvidenceGraph(bundle: ExtractionBundle): EvidenceGraph {
  const nodes: EvidenceNode[] = [...bundle.graphifyNodes];
  const edges: EvidenceEdge[] = [...bundle.graphifyEdges];

  for (const source of bundle.sourceFiles) {
    nodes.push(node(stableId('source-file', source.file), 'source-file', source.file, source.file, {}, source));
  }
  for (const route of bundle.routes) {
    nodes.push(node(route.id, 'route', route.path, route.path, { component: route.component }, route.sourceRef));
  }
  for (const page of bundle.pages) {
    nodes.push(node(page.id, 'page', `${page.file}:${page.name}`, page.name, { routeIds: page.routeIds }, page.sourceRef));
  }
  for (const handler of bundle.handlers) {
    nodes.push(node(handler.id, 'handler', `${handler.file}:${handler.name}`, handler.name, {
      calls: handler.calls,
      httpOperationIds: handler.httpOperationIds,
      navigationIds: handler.navigationIds,
    }, handler.sourceRef));
  }
  for (const action of bundle.actions) {
    nodes.push(node(action.id, 'control', `${action.pageId}:${action.accessibleName ?? action.id}`, action.accessibleName ?? action.component, {
      pageId: action.pageId,
      event: action.event,
      handlerId: action.handlerId,
      handlerName: action.handlerName,
      visibleWhen: action.visibleWhen,
      enabledWhen: action.enabledWhen,
    }, action.sourceRef));
  }
  for (const field of bundle.fields) {
    nodes.push(node(field.id, 'field', `${field.pageId}:${field.dataPath}`, field.label ?? field.dataPath, {
      pageId: field.pageId,
      dataPath: field.dataPath,
      controlKind: field.controlKind,
      visibleWhen: field.visibleWhen,
      requiredWhen: field.requiredWhen,
      constraintIds: field.constraints.map((constraint) => constraint.id),
    }, field.sourceRef));
  }
  for (const operation of bundle.httpOperations) {
    nodes.push(node(operation.id, 'http-client-operation', `${operation.method}:${operation.pathTemplate}:${operation.sourceRef.file}:${operation.sourceRef.line}`, `${operation.method} ${operation.pathTemplate}`, {
      method: operation.method,
      pathTemplate: operation.pathTemplate,
      callerSymbol: operation.callerSymbol,
      requestExpression: operation.requestExpression,
    }, operation.sourceRef));
  }
  for (const navigation of bundle.navigations) {
    nodes.push(node(navigation.id, 'navigation', `${navigation.sourceRef.file}:${navigation.sourceRef.line}:${navigation.target}`, navigation.target, {
      fromPageId: navigation.fromPageId,
      target: navigation.target,
      guard: navigation.guard,
    }, navigation.sourceRef));
  }
  for (const permission of bundle.permissions) {
    nodes.push(node(permission.id, 'permission', `${permission.layer}:${permission.authority}`, permission.authority, { layer: permission.layer }, permission.sourceRef));
  }
  for (const endpoint of bundle.endpoints) {
    nodes.push(node(endpoint.id, 'java-endpoint', `${endpoint.method}:${endpoint.pathTemplate}:${endpoint.controller}.${endpoint.handler}`, `${endpoint.method} ${endpoint.pathTemplate}`, {
      method: endpoint.method,
      pathTemplate: endpoint.pathTemplate,
      controller: endpoint.controller,
      handler: endpoint.handler,
      requestType: endpoint.requestType,
      responseType: endpoint.responseType,
    }, endpoint.sourceRef));
  }
  for (const validation of bundle.validations) {
    nodes.push(node(validation.id, 'validation', `${validation.fieldPath}:${validation.kind}:${String(validation.value)}`, `${validation.fieldPath} ${validation.kind}`, {
      fieldPath: validation.fieldPath,
      kind: validation.kind,
      value: validation.value,
      message: validation.message,
    }, validation.sourceRef));
  }
  for (const effect of bundle.effects) {
    nodes.push(node(effect.id, 'terminal-effect', `${effect.entity}:${effect.kind}:${effect.toState ?? ''}`, `${effect.entity} ${effect.kind}`, {
      entity: effect.entity,
      kind: effect.kind,
      toState: effect.toState,
    }, effect.sourceRef));
  }
  for (const concept of bundle.wikiConcepts) {
    nodes.push({
      ...node(concept.id, 'concept', concept.canonicalLabel, concept.canonicalLabel, { aliases: concept.aliases }, concept.sourceRef),
      origin: 'wiki-derived',
      confidence: 'semantic',
    });
  }

  for (const route of bundle.routes) {
    const page = bundle.pages.find((candidate) => candidate.name === route.component);
    if (page) edges.push(edge(route.id, page.id, 'renders', [route.id, page.id]));
  }
  for (const page of bundle.pages) {
    bundle.actions.filter((action) => action.pageId === page.id).forEach((action) => edges.push(edge(page.id, action.id, 'contains', [page.id, action.id])));
    bundle.fields.filter((field) => field.pageId === page.id).forEach((field) => edges.push(edge(page.id, field.id, 'contains', [page.id, field.id])));
  }
  for (const action of bundle.actions) {
    if (action.handlerId) edges.push(edge(action.id, action.handlerId, 'triggers', [action.id, action.handlerId]));
  }
  for (const handler of bundle.handlers) {
    handler.httpOperationIds.forEach((id) => edges.push(edge(handler.id, id, 'calls', [handler.id, id])));
    handler.navigationIds.forEach((id) => edges.push(edge(handler.id, id, 'calls', [handler.id, id])));
  }
  for (const http of bundle.httpOperations) {
    for (const endpoint of bundle.endpoints.filter((candidate) => httpMatch(http.method, http.pathTemplate, candidate.method, candidate.pathTemplate))) {
      edges.push(edge(http.id, endpoint.id, 'handled-by', [http.id, endpoint.id]));
    }
  }
  for (const endpoint of bundle.endpoints) {
    endpoint.permissionIds.forEach((id) => edges.push(edge(endpoint.id, id, 'requires', [endpoint.id, id])));
    endpoint.validationIds.forEach((id) => edges.push(edge(endpoint.id, id, 'validates', [endpoint.id, id])));
    endpoint.terminalEffectIds.forEach((id) => edges.push(edge(endpoint.id, id, 'establishes', [endpoint.id, id])));
  }
  for (const navigation of bundle.navigations) {
    const route = bundle.routes.find((candidate) => routeMatches(navigation.target, candidate.path));
    if (route) edges.push(edge(navigation.id, route.id, 'navigates-to', [navigation.id, route.id], navigation.guard));
  }

  return {
    nodes: dedupe(nodes, (value) => value.id),
    edges: dedupe(edges, (value) => value.id),
    diagnostics: bundle.diagnostics,
  };
}

export function buildOperationCatalog(bundle: ExtractionBundle): OperationCatalog {
  const operations: OperationCatalogEntry[] = [];
  for (const endpoint of bundle.endpoints) {
    const frontend = bundle.httpOperations.filter((http) => httpMatch(http.method, http.pathTemplate, endpoint.method, endpoint.pathTemplate));
    const effects = bundle.effects.filter((effect) => endpoint.terminalEffectIds.includes(effect.id));
    const effect = effects[0];
    const machineName = commandName(endpoint.handler, effect?.entity ?? endpoint.controller.replace(/Controller$/, ''));
    const wiki = bundle.wikiConcepts.find((concept) => [concept.canonicalLabel, ...concept.aliases].some((alias) => slug(alias) === slug(effect?.entity ?? '')));
    const label = humanizeCommand(machineName, wiki?.canonicalLabel);
    operations.push({
      id: stableId('operation', `${endpoint.method}:${endpoint.pathTemplate}:${effect?.kind ?? 'mutation'}:${effect?.entity ?? ''}`),
      method: endpoint.method,
      pathTemplate: endpoint.pathTemplate,
      frontendOperationIds: frontend.map((value) => value.id),
      backendEndpointId: endpoint.id,
      actorRequirementIds: [],
      validationIds: endpoint.validationIds,
      terminalEffectIds: endpoint.terminalEffectIds,
      businessCommand: {
        machineName,
        label,
        origin: wiki ? 'wiki' : 'deterministic',
      },
      inclusion: endpoint.terminalEffectIds.length ? (frontend.length ? 'included' : 'review-required') : 'excluded',
      evidenceRefs: [endpoint.id, ...frontend.map((value) => value.id), ...endpoint.terminalEffectIds],
    });
  }
  return { operations: stableSort(operations, (value) => value.id) };
}

export function buildActorRequirements(bundle: ExtractionBundle, catalog: OperationCatalog): ActorRequirements {
  const actors: ActorRequirement[] = [];
  for (const operation of catalog.operations.filter((candidate) => candidate.inclusion !== 'excluded')) {
    const endpoint = bundle.endpoints.find((candidate) => candidate.id === operation.backendEndpointId);
    if (!endpoint) continue;
    const backend = bundle.permissions.filter((permission) => endpoint.permissionIds.includes(permission.id));
    const frontend = bundle.permissions.filter((permission) => permission.layer === 'frontend' && backend.some((back) => back.authority === permission.authority));
    const authorities = [...new Set([...backend, ...frontend].map((permission) => permission.authority))].sort();
    const actor: ActorRequirement = {
      id: stableId('actor-requirement', `${operation.id}:${authorities.join(',') || 'anonymous'}`),
      authentication: authorities.length ? 'required' : 'anonymous',
      authoritiesAll: authorities,
      rolesAll: authorities.filter((authority) => authority.startsWith('ROLE_')),
      attributePredicates: [],
      relationships: [],
      label: authorities.length ? `principal with ${authorities.join(', ')}` : 'anonymous principal',
      evidenceRefs: [...backend, ...frontend].map((permission) => permission.id),
    };
    actors.push(actor);
    operation.actorRequirementIds = [actor.id];
  }
  return { actors: dedupe(actors, (value) => value.id) };
}

export function buildPageContracts(bundle: ExtractionBundle): PageContracts {
  const pages: PageContract[] = bundle.pages.map((page) => {
    const routePatterns = bundle.routes.filter((route) => page.routeIds.includes(route.id)).map((route) => route.path);
    const fields = dedupe(bundle.fields.filter((field) => field.pageId === page.id).map((field) => mergeBackendConstraints(field, bundle)), (field) => field.id);
    const actions = bundle.actions.filter((action) => action.pageId === page.id);
    return {
      id: page.id,
      name: page.name,
      routePatterns,
      fields,
      actions,
      entryConditions: [],
      evidenceRefs: [page.id, ...page.routeIds, ...fields.map((field) => field.id), ...actions.map((action) => action.id)],
    };
  });
  return { pages: stableSort(pages, (value) => value.id) };
}

export function buildBehaviorGraph(
  bundle: ExtractionBundle,
  catalog: OperationCatalog,
  pages: PageContracts,
  config: FlowctlConfig,
): BehaviorGraph {
  const nodes: BehaviorNode[] = [];
  const edges: BehaviorEdge[] = [];
  const successNodeIds = new Set<string>();

  for (const page of pages.pages) nodes.push({ id: page.id, kind: 'screen-state', label: page.name, referenceId: page.id, attributes: { routePatterns: page.routePatterns } });
  for (const action of bundle.actions) nodes.push({ id: action.id, kind: 'action', label: action.accessibleName ?? action.component, referenceId: action.id, attributes: { pageId: action.pageId } });
  for (const operation of catalog.operations.filter((value) => value.inclusion !== 'excluded')) nodes.push({ id: operation.id, kind: 'operation', label: operation.businessCommand.label, referenceId: operation.id, attributes: { method: operation.method, pathTemplate: operation.pathTemplate } });

  for (const action of bundle.actions) {
    edges.push(behaviorEdge(action.pageId, action.id, allPredicates([...action.visibleWhen, ...action.enabledWhen]), [], 'neutral', [action.id]));
    const handler = action.handlerId ? bundle.handlers.find((candidate) => candidate.id === action.handlerId) : undefined;
    if (!handler) continue;
    const httpIds = resolveHandlerHttpIds(handler, bundle.handlers, bundle.httpOperations);
    const operations = catalog.operations.filter((operation) => operation.frontendOperationIds.some((id) => httpIds.has(id)) && operation.inclusion !== 'excluded');
    const handlerNavigations = resolveHandlerNavigationIds(handler, bundle.handlers);
    const navigations = bundle.navigations.filter((navigation) => handlerNavigations.has(navigation.id));

    for (const operation of operations) {
      edges.push(behaviorEdge(action.id, operation.id, TRUE, [{ kind: 'invoke-operation', operationId: operation.id }], 'neutral', [action.id, operation.id]));
      const targetPages = targetPagesForNavigations(navigations, bundle, pages);
      if (targetPages.length) {
        for (const target of targetPages) {
          const navigation = navigations.find((candidate) => target.routePatterns.some((route) => routeMatches(candidate.target, route)));
          const effects = [
            ...operation.terminalEffectIds.map((effectId) => ({ kind: 'entity-transition' as const, effectId })),
            ...(navigation ? [{ kind: 'navigate' as const, target: navigation.target }] : []),
          ];
          edges.push(behaviorEdge(operation.id, target.id, navigation?.guard ?? TRUE, effects, 'success', [operation.id, ...(navigation ? [navigation.id] : []), target.id]));
          successNodeIds.add(target.id);
        }
      } else {
        const outcomeId = stableId('outcome', `${operation.id}:success`);
        nodes.push({ id: outcomeId, kind: 'outcome', label: `${operation.businessCommand.label} succeeds`, referenceId: operation.id, attributes: {} });
        edges.push(behaviorEdge(operation.id, outcomeId, TRUE, operation.terminalEffectIds.map((effectId) => ({ kind: 'entity-transition', effectId })), 'success', [operation.id, outcomeId]));
        successNodeIds.add(outcomeId);
      }
    }

    if (!operations.length) {
      for (const navigation of navigations) {
        const target = pages.pages.find((page) => page.routePatterns.some((route) => routeMatches(navigation.target, route)));
        if (target) edges.push(behaviorEdge(action.id, target.id, navigation.guard, [{ kind: 'navigate', target: navigation.target }], 'neutral', [action.id, navigation.id, target.id]));
      }
    }
  }

  const incoming = new Set(edges.map((value) => value.to));
  const configuredEntries = pages.pages.filter((page) => page.routePatterns.some((route) => config.analysis.entryRoutes.some((entry) => routeMatches(entry, route)))).map((page) => page.id);
  const structuralEntries = pages.pages.filter((page) => !incoming.has(page.id)).map((page) => page.id);
  return {
    nodes: dedupe(nodes, (value) => value.id),
    edges: dedupe(edges, (value) => value.id),
    entryNodeIds: configuredEntries.length ? configuredEntries : structuralEntries,
    successNodeIds: [...successNodeIds].sort(),
  };
}

export function buildFlowFamilies(catalog: OperationCatalog, actors: ActorRequirements, graph: BehaviorGraph): FlowFamilies {
  const groups = new Map<string, OperationCatalogEntry[]>();
  for (const operation of catalog.operations.filter((value) => value.inclusion !== 'excluded')) {
    const key = operation.businessCommand.machineName;
    groups.set(key, [...(groups.get(key) ?? []), operation]);
  }
  const families: FlowFamily[] = [];
  for (const [machineName, operations] of groups) {
    const operationIds = operations.map((operation) => operation.id);
    const successNodeIds = graph.edges.filter((edge) => operationIds.includes(edge.from) && edge.outcome === 'success').map((edge) => edge.to);
    families.push({
      id: machineName,
      label: operations[0]?.businessCommand.label ?? machineName,
      operationIds,
      entryNodeIds: graph.entryNodeIds,
      successNodeIds: [...new Set(successNodeIds)],
      actorRequirementIds: [...new Set(operations.flatMap((operation) => operation.actorRequirementIds).filter((id) => actors.actors.some((actor) => actor.id === id)))],
      evidenceRefs: operations.flatMap((operation) => operation.evidenceRefs),
    });
  }
  return { families: stableSort(families, (value) => value.id) };
}

export function searchPaths(graph: BehaviorGraph, families: FlowFamilies, config: FlowctlConfig): PathWitnesses {
  const witnesses: PathWitness[] = [];
  const outgoing = new Map<string, BehaviorEdge[]>();
  graph.edges.forEach((edge) => outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]));

  for (const family of families.families) {
    type SearchState = { nodeId: string; nodePath: string[]; edgePath: string[]; guards: Predicate[]; visits: Map<string, number>; evidence: string[] };
    const queue: SearchState[] = family.entryNodeIds.map((nodeId) => ({ nodeId, nodePath: [nodeId], edgePath: [], guards: [], visits: new Map([[nodeId, 1]]), evidence: [] }));
    while (queue.length) {
      const state = queue.shift()!;
      if (state.nodePath.length > config.analysis.maxPathDepth) continue;
      if (family.successNodeIds.includes(state.nodeId)) {
        const pathCondition = allPredicates(state.guards);
        const result = solvePredicate(pathCondition);
        if (result.status !== 'unsatisfiable') {
          const pageSequence = state.nodePath.filter((id) => graph.nodes.find((node) => node.id === id)?.kind === 'screen-state');
          const actionSequence = state.nodePath.filter((id) => graph.nodes.find((node) => node.id === id)?.kind === 'action');
          witnesses.push({
            id: stableId('witness', `${family.id}:${state.edgePath.join('>')}:${predicateLabel(pathCondition)}`),
            familyId: family.id,
            nodePath: state.nodePath,
            edgePath: state.edgePath,
            pageSequence,
            actionSequence,
            pathCondition,
            assignments: result.assignments,
            feasibility: result.status,
            evidenceRefs: [...new Set(state.evidence)],
          });
        }
        continue;
      }

      for (const edge of outgoing.get(state.nodeId) ?? []) {
        if (edge.outcome === 'error' || edge.outcome === 'cancel') continue;
        const visits = new Map(state.visits);
        const count = (visits.get(edge.to) ?? 0) + 1;
        if (count > config.analysis.maxStateVisits) continue;
        visits.set(edge.to, count);
        const condition = allPredicates([...state.guards, edge.guard]);
        if (solvePredicate(condition).status === 'unsatisfiable') continue;
        queue.push({
          nodeId: edge.to,
          nodePath: [...state.nodePath, edge.to],
          edgePath: [...state.edgePath, edge.id],
          guards: [...state.guards, edge.guard],
          visits,
          evidence: [...state.evidence, ...edge.evidenceRefs],
        });
      }
    }
  }
  return { witnesses: dedupe(witnesses, (value) => value.id) };
}

export function reduceVariants(
  witnesses: PathWitnesses,
  families: FlowFamilies,
  graph: BehaviorGraph,
): FlowVariants {
  const variants: FlowVariant[] = [];
  for (const family of families.families) {
    const familyWitnesses = witnesses.witnesses.filter((witness) => witness.familyId === family.id);
    const groups = new Map<string, PathWitness[]>();
    for (const witness of familyWitnesses) {
      const operationIds = witness.nodePath.filter((id) => family.operationIds.includes(id));
      const signatureValue = {
        actorRequirementIds: family.actorRequirementIds,
        pageSequence: witness.pageSequence,
        actionSequence: witness.actionSequence,
        operationIds,
        successNode: witness.nodePath.at(-1),
      };
      const signature = sha256(stableJson(signatureValue));
      groups.set(signature, [...(groups.get(signature) ?? []), witness]);
    }

    let ordinal = 0;
    for (const [signature, group] of groups) {
      ordinal += 1;
      const representative = group[0]!;
      const discriminator = discriminatorLabel(representative, graph, ordinal);
      variants.push({
        id: `${family.id}.${slug(discriminator)}`,
        familyId: family.id,
        label: `${family.label} — ${discriminator}`,
        witnessIds: group.map((value) => value.id),
        behaviorSignature: signature,
        actorRequirementIds: family.actorRequirementIds,
        pathCondition: representative.pathCondition,
        pageSequence: representative.pageSequence,
        actionSequence: representative.actionSequence,
        operationIds: representative.nodePath.filter((id) => family.operationIds.includes(id)),
        dataRequirementIds: [],
        feasibility: group.some((value) => value.feasibility === 'conditional') ? 'conditional' : 'satisfiable',
        evidenceRefs: [...new Set(group.flatMap((value) => value.evidenceRefs))],
      });
    }
  }
  return { variants: stableSort(variants, (value) => value.id) };
}

export function buildDataRequirements(
  variants: FlowVariants,
  pages: PageContracts,
  actors: ActorRequirements,
): DataRequirement[] {
  const requirements: DataRequirement[] = [];
  for (const variant of variants.variants) {
    const fields = pages.pages.filter((page) => variant.pageSequence.includes(page.id)).flatMap((page) => page.fields);
    for (const field of fields) {
      const assigned = assignmentForField(variant.pathCondition, field.dataPath);
      const classification = classifyField(field, assigned !== undefined);
      const requirement: DataRequirement = {
        id: stableId('data-requirement', `${variant.id}:${field.dataPath}`),
        variantId: variant.id,
        fieldPath: field.dataPath,
        classification,
        constraints: field.constraints,
        resolutionStrategies: strategiesForClassification(classification),
        status: classification === 'flow-literal' || classification === 'synthetic-constrained' ? 'generated' : 'unresolved',
        evidenceRefs: [field.id, ...field.constraints.map((constraint) => constraint.id)],
      };
      requirements.push(requirement);
      variant.dataRequirementIds.push(requirement.id);
    }
    for (const actorId of variant.actorRequirementIds) {
      const actor = actors.actors.find((candidate) => candidate.id === actorId);
      if (!actor || actor.authentication === 'anonymous') continue;
      const requirement: DataRequirement = {
        id: stableId('data-requirement', `${variant.id}:actor:${actorId}`),
        variantId: variant.id,
        fieldPath: 'actor.principal',
        classification: 'authenticated-identity',
        constraints: [],
        resolutionStrategies: ['approved-identity-catalog', 'secret-reference', 'manual-binding'],
        status: 'unresolved',
        evidenceRefs: actor.evidenceRefs,
      };
      requirements.push(requirement);
      variant.dataRequirementIds.push(requirement.id);
    }
    variant.dataRequirementIds = [...new Set(variant.dataRequirementIds)];
  }
  return dedupe(requirements, (value) => value.id);
}

export function buildCoverage(
  bundle: ExtractionBundle,
  catalog: OperationCatalog,
  pages: PageContracts,
  actors: ActorRequirements,
  graph: BehaviorGraph,
  families: FlowFamilies,
  witnesses: PathWitnesses,
  variants: FlowVariants,
  dataRequirements: DataRequirement[],
  runtime: RuntimeBindings,
  config: FlowctlConfig,
): CoverageReport {
  const conditional = variants.variants.filter((variant) => variant.feasibility === 'conditional').length;
  return {
    scope: {
      sourceFiles: bundle.sourceFiles.length,
      sourceDigest: bundle.sourceDigest,
      maxPathDepth: config.analysis.maxPathDepth,
      maxStateVisits: config.analysis.maxStateVisits,
    },
    counts: {
      evidenceNodes: bundle.graphifyNodes.length + bundle.routes.length + bundle.pages.length + bundle.handlers.length + bundle.actions.length + bundle.fields.length + bundle.httpOperations.length + bundle.endpoints.length + bundle.validations.length + bundle.permissions.length + bundle.effects.length,
      sourceDeclaredActions: bundle.actions.length,
      handlerResolvedActions: bundle.actions.filter((action) => action.handlerId).length,
      terminalOperations: catalog.operations.filter((operation) => operation.inclusion !== 'excluded').length,
      pageContracts: pages.pages.length,
      actorRequirements: actors.actors.length,
      behaviorNodes: graph.nodes.length,
      behaviorEdges: graph.edges.length,
      flowFamilies: families.families.length,
      pathWitnesses: witnesses.witnesses.length,
      variants: variants.variants.length,
      conditionalVariants: conditional,
      dataRequirements: dataRequirements.length,
      unresolvedDataRequirements: dataRequirements.filter((requirement) => requirement.status === 'unresolved').length,
      runtimeBindings: runtime.bindings.length,
    },
    unresolved: bundle.diagnostics,
    claims: [
      'Distinct successful behavior signatures found within the configured source scope and search bounds are represented.',
      conditional ? `${conditional} variant(s) remain conditional because unsupported predicates or resolution gaps exist.` : 'All emitted variants are satisfiable under the supported constraint subset.',
      'Runtime confirmation is reported separately from source-derived flow discovery.',
    ],
  };
}

function node(id: string, kind: EvidenceNode['kind'], canonicalKey: string, label: string, attributes: Record<string, unknown>, sourceRef: EvidenceNode['sourceRefs'][number]): EvidenceNode {
  return { id, kind, canonicalKey, label, attributes: clean(attributes), origin: 'source-extracted', confidence: 'exact', sourceRefs: [sourceRef] };
}

function edge(from: string, to: string, kind: EvidenceEdge['kind'], evidenceRefs: string[], guard?: Predicate): EvidenceEdge {
  return {
    id: stableId('evidence-edge', `${from}:${kind}:${to}`),
    from,
    to,
    kind,
    ...(guard ? { guard } : {}),
    origin: 'source-extracted',
    confidence: 'exact',
    sourceRefs: [],
  };
}

function behaviorEdge(from: string, to: string, guard: Predicate, effects: BehaviorEdge['effects'], outcome: BehaviorEdge['outcome'], evidenceRefs: string[]): BehaviorEdge {
  return { id: stableId('behavior-edge', `${from}:${to}:${predicateLabel(guard)}:${outcome}`), from, to, guard, effects, outcome, evidenceRefs };
}

function mergeBackendConstraints(field: ReactFieldFact, bundle: ExtractionBundle): ReactFieldFact {
  const leaf = field.dataPath.split('.').at(-1)?.toLowerCase();
  const backend = bundle.validations.filter((validation) => validation.fieldPath.split('.').at(-1)?.toLowerCase() === leaf);
  return { ...field, constraints: dedupe([...field.constraints, ...backend], (constraint) => constraint.id) };
}

function resolveHandlerHttpIds(handler: ExtractionBundle['handlers'][number], handlers: ExtractionBundle['handlers'], http: ExtractionBundle['httpOperations']): Set<string> {
  const resolved = new Set(handler.httpOperationIds);
  const visited = new Set<string>();
  const queue = [handler.name];
  while (queue.length) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const candidate = handlers.find((value) => value.name === name);
    if (!candidate) continue;
    candidate.httpOperationIds.forEach((id) => resolved.add(id));
    for (const called of candidate.calls.map((call) => call.split('.').at(-1)!).filter(Boolean)) {
      if (!visited.has(called)) queue.push(called);
    }
  }
  for (const operation of http) {
    if (operation.callerSymbol && visited.has(operation.callerSymbol)) resolved.add(operation.id);
  }
  return resolved;
}

function resolveHandlerNavigationIds(handler: ExtractionBundle['handlers'][number], handlers: ExtractionBundle['handlers']): Set<string> {
  const resolved = new Set(handler.navigationIds);
  const visited = new Set<string>();
  const queue = [handler.name];
  while (queue.length) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const candidate = handlers.find((value) => value.name === name);
    if (!candidate) continue;
    candidate.navigationIds.forEach((id) => resolved.add(id));
    candidate.calls.map((call) => call.split('.').at(-1)!).filter(Boolean).forEach((called) => queue.push(called));
  }
  return resolved;
}

function targetPagesForNavigations(navigations: ExtractionBundle['navigations'], bundle: ExtractionBundle, pages: PageContracts): PageContract[] {
  return dedupe(navigations.flatMap((navigation) => {
    const route = bundle.routes.find((candidate) => routeMatches(navigation.target, candidate.path));
    if (!route) return [];
    return pages.pages.filter((page) => page.routePatterns.some((pattern) => routeMatches(navigation.target, pattern)));
  }), (page) => page.id);
}

function commandName(handler: string, entity: string): string {
  const verb = handler.match(/^(create|submit|open|approve|reject|update|delete|cancel|place|send|activate|deactivate)/i)?.[1]?.toLowerCase()
    ?? handler.replace(new RegExp(entity, 'ig'), '').replace(/(?:handler|request)$/i, '').toLowerCase()
    ?? 'execute';
  return `${slug(entity).replace(/-/g, '.')}.${slug(verb).replace(/-/g, '.')}`;
}

function humanizeCommand(machineName: string, entityLabel?: string): string {
  const [entity, verb] = machineName.split('.');
  const normalizedEntity = entityLabel ?? entity ?? 'Entity';
  return `${capitalize(verb ?? 'execute')} ${normalizedEntity}`;
}

function discriminatorLabel(witness: PathWitness, graph: BehaviorGraph, ordinal: number): string {
  const values = Object.values(witness.assignments).filter((value) => typeof value === 'string' || typeof value === 'number');
  if (values.length) return values.map(String).join('-');
  const distinctAction = witness.actionSequence.map((id) => graph.nodes.find((node) => node.id === id)?.label).find((label) => label && !/^continue|submit|next$/i.test(label));
  return distinctAction ?? `path-${ordinal}`;
}

function classifyField(field: ReactFieldFact, assigned: boolean): DataRequirement['classification'] {
  if (assigned) return 'flow-literal';
  if (/(password|token|secret|otp)/i.test(field.dataPath)) return 'secret-reference';
  if (/(applicant|customer|account|entity).*id$|^(applicant|customer|account)$/i.test(field.dataPath)) return 'existing-entity';
  if (/select|picker|combobox/i.test(field.controlKind) && !field.constraints.some((constraint) => constraint.kind === 'enum')) return 'runtime-option';
  return 'synthetic-constrained';
}

function assignmentForField(predicate: Predicate, fieldPath: string): unknown {
  const solved = solvePredicate(predicate).assignments;
  return solved[fieldPath] ?? solved[Object.keys(solved).find((key) => key.split('.').at(-1) === fieldPath.split('.').at(-1)) ?? ''];
}

function strategiesForClassification(classification: DataRequirement['classification']): string[] {
  const strategies: Record<DataRequirement['classification'], string[]> = {
    'flow-literal': ['path-assignment'],
    'synthetic-constrained': ['constraint-generator'],
    'derived': ['execution-binding'],
    'runtime-option': ['runtime-option-provider'],
    'existing-entity': ['approved-fixture', 'read-only-lookup', 'test-builder', 'manual-binding'],
    'authenticated-identity': ['approved-identity-catalog', 'secret-reference', 'manual-binding'],
    'secret-reference': ['corporate-secret-store'],
    'external-manual': ['manual-request'],
  };
  return strategies[classification];
}

function httpMatch(leftMethod: string, leftPath: string, rightMethod: string, rightPath: string): boolean {
  return leftMethod.toUpperCase() === rightMethod.toUpperCase() && normalizeTemplate(leftPath) === normalizeTemplate(rightPath);
}

export function routeMatches(actual: string, pattern: string): boolean {
  const normalizedActual = normalizeTemplate(actual);
  const normalizedPattern = normalizeTemplate(pattern);
  if (normalizedActual === normalizedPattern) return true;
  const regex = new RegExp(`^${escapeRegex(normalizedPattern).replace(/\\\{[^}]+\\\}/g, '[^/]+')}$`);
  return regex.test(normalizedActual);
}

function normalizeTemplate(value: string): string {
  return value
    .replace(/:[A-Za-z_$][\w$]*/g, '{param}')
    .replace(/\{[^}]+\}/g, '{param}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupe<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function clean(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1).replace(/-/g, ' ') : value;
}
