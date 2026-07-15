import { stableId, stableJson, stableSort, sha256, slug } from '../core/stable.js';
import { evaluateConstraintSet, evaluateConstraintValue, representativeValueForConstraints } from '../contracts/constraints.js';
import { isSensitiveControlKind, isSensitiveFieldPath, redactSecretConstraints } from '../data/sensitivity.js';
import { allPredicates, enumeratePredicateModels, predicateLabel, solvePredicate, TRUE } from '../ir/predicates.js';
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
  PathSearchTruncationDetail,
  PathSearchTruncationReason,
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
    nodes.push(node(route.id, 'route', route.path, route.path, { component: route.component, componentFile: route.componentFile }, route.sourceRef));
  }
  for (const page of bundle.pages) {
    nodes.push(node(page.id, 'page', `${page.file}:${page.name}`, page.name, {
      routeIds: page.routeIds,
      completeness: page.completeness ?? 'exact',
      unresolvedChildComponentRefs: page.unresolvedChildComponentRefs ?? [],
    }, page.sourceRef));
  }
  for (const handler of bundle.handlers) {
    nodes.push(node(handler.id, 'handler', `${handler.file}:${handler.name}`, handler.name, {
      calls: handler.calls,
      parameterNames: handler.parameterNames,
      callSites: handler.callSites,
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
      handlerResolution: action.handlerResolution,
      handlerExpression: action.handlerExpression,
      navigationIds: action.navigationIds,
      visibleWhen: action.visibleWhen,
      enabledWhen: action.enabledWhen,
    }, action.sourceRef));
  }
  for (const field of bundle.fields) {
    nodes.push(node(field.id, 'field', `${field.pageId}:${field.dataPath}`, field.label ?? field.dataPath, {
      pageId: field.pageId,
      dataPath: field.dataPath,
      controlKind: field.controlKind,
      inputMode: field.inputMode ?? 'editable',
      optionSource: field.optionSource,
      valueBinding: field.valueBinding,
      visibleWhen: field.visibleWhen,
      requiredWhen: field.requiredWhen,
      constraintIds: field.constraints.map((constraint) => constraint.id),
      backendConstraintsByOperationId: field.backendConstraintsByOperationId,
      backendConstraintsByRequestContractId: field.backendConstraintsByRequestContractId,
    }, field.sourceRef));
  }
  for (const operation of bundle.httpOperations) {
    nodes.push(node(operation.id, 'http-client-operation', `${operation.method}:${operation.pathTemplate}:${operation.sourceRef.file}:${operation.sourceRef.line}`, `${operation.method} ${operation.pathTemplate}`, {
      method: operation.method,
      pathTemplate: operation.pathTemplate,
      callerSymbol: operation.callerSymbol,
      requestExpression: operation.requestExpression,
      payloadShape: operation.payloadShape,
      guard: operation.guard,
    }, operation.sourceRef));
  }
  for (const contract of bundle.requestContracts ?? []) {
    nodes.push({
      id: contract.id,
      kind: 'request-payload',
      canonicalKey: `${contract.actionId}:${contract.httpOperationId}:${contract.endpointId}`,
      label: `Request payload for ${contract.httpOperationId}`,
      attributes: {
        actionId: contract.actionId,
        handlerId: contract.handlerId,
        handlerPath: contract.handlerPath,
        httpOperationId: contract.httpOperationId,
        endpointId: contract.endpointId,
        certainty: contract.payloadShape.certainty,
        dispatchGuard: contract.dispatchGuard,
        providedFields: contract.providedFields,
        literalBindings: contract.literalBindings,
        uiFieldBindings: contract.uiFieldBindings,
        requiredFields: contract.requiredFields,
        missingRequiredFields: contract.missingRequiredFields,
        unprovenFieldValues: contract.unprovenFieldValues,
        invalidFieldValues: contract.invalidFieldValues,
        validationIds: contract.validationIds,
        status: contract.status,
      },
      origin: 'source-extracted',
      confidence: contract.status === 'review-required' ? 'unresolved' : 'exact',
      sourceRefs: contract.sourceRefs,
    });
  }
  for (const navigation of bundle.navigations) {
    nodes.push(node(navigation.id, 'navigation', `${navigation.sourceRef.file}:${navigation.sourceRef.line}:${navigation.target}`, navigation.target, {
      fromPageId: navigation.fromPageId,
      targetStatus: navigation.targetStatus,
      targetExpression: navigation.targetExpression,
      trigger: navigation.trigger,
      successAfterCallSymbol: navigation.successAfterCallSymbol,
      successAfterCallFile: navigation.successAfterCallFile,
      continuationStatus: navigation.continuationStatus,
      target: navigation.target,
      guard: navigation.guard,
    }, navigation.sourceRef));
  }
  for (const permission of bundle.permissions) {
    nodes.push({
      ...node(permission.id, 'permission', `${permission.layer}:${permission.authority}`, permission.authority, { layer: permission.layer }, permission.sourceRef),
      origin: permission.origin ?? 'source-extracted',
    });
  }
  for (const endpoint of bundle.endpoints) {
    nodes.push(node(endpoint.id, 'java-endpoint', `${endpoint.method}:${endpoint.pathTemplate}:${endpoint.controller}.${endpoint.handler}`, `${endpoint.method} ${endpoint.pathTemplate}`, {
      method: endpoint.method,
      pathTemplate: endpoint.pathTemplate,
      controller: endpoint.controller,
      handler: endpoint.handler,
      requestType: endpoint.requestType,
      responseType: endpoint.responseType,
      authorization: endpoint.authorization,
      domainGuard: endpoint.domainGuard,
      semanticResolution: endpoint.semanticResolution,
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

  const makeEdge = (
    from: string,
    to: string,
    kind: EvidenceEdge['kind'],
    evidenceRefs: string[],
    guard?: Predicate,
  ) => evidenceEdge(nodes, from, to, kind, evidenceRefs, guard);

  for (const route of bundle.routes) {
    const candidates = bundle.pages.filter((candidate) => (
      candidate.name === route.component && (!route.componentFile || candidate.file === route.componentFile)
    ));
    const page = candidates.length === 1 ? candidates[0] : undefined;
    if (page) edges.push(makeEdge(route.id, page.id, 'renders', [route.id, page.id]));
  }
  for (const page of bundle.pages) {
    bundle.actions.filter((action) => action.pageId === page.id).forEach((action) => edges.push(makeEdge(page.id, action.id, 'contains', [page.id, action.id])));
    bundle.fields.filter((field) => field.pageId === page.id).forEach((field) => edges.push(makeEdge(page.id, field.id, 'contains', [page.id, field.id])));
  }
  for (const action of bundle.actions) {
    if (action.handlerId) edges.push(makeEdge(action.id, action.handlerId, 'triggers', [action.id, action.handlerId]));
  }
  for (const contract of bundle.requestContracts ?? []) {
    edges.push(makeEdge(contract.actionId, contract.id, 'requests', [contract.actionId, contract.id]));
    edges.push(makeEdge(contract.id, contract.httpOperationId, 'references', [contract.id, contract.httpOperationId]));
  }
  for (const handler of bundle.handlers) {
    handler.httpOperationIds.forEach((id) => edges.push(makeEdge(handler.id, id, 'calls', [handler.id, id])));
    handler.navigationIds.forEach((id) => edges.push(makeEdge(handler.id, id, 'calls', [handler.id, id])));
  }
  for (const http of bundle.httpOperations) {
    for (const endpoint of bundle.endpoints.filter((candidate) => httpMatch(http.method, http.pathTemplate, candidate.method, candidate.pathTemplate))) {
      edges.push(makeEdge(http.id, endpoint.id, 'handled-by', [http.id, endpoint.id]));
    }
  }
  for (const endpoint of bundle.endpoints) {
    endpoint.permissionIds.forEach((id) => edges.push(makeEdge(endpoint.id, id, 'requires', [endpoint.id, id])));
    endpoint.validationIds.forEach((id) => edges.push(makeEdge(endpoint.id, id, 'validates', [endpoint.id, id])));
    endpoint.terminalEffectIds.forEach((id) => edges.push(makeEdge(endpoint.id, id, 'establishes', [endpoint.id, id])));
  }
  for (const navigation of bundle.navigations) {
    const route = bundle.routes.find((candidate) => routeMatches(navigation.target, candidate.path));
    if (route) edges.push(makeEdge(navigation.id, route.id, 'navigates-to', [navigation.id, route.id], navigation.guard));
  }

  return {
    nodes: dedupe(nodes, (value) => value.id),
    edges: dedupe(edges, (value) => value.id),
    diagnostics: bundle.diagnostics,
  };
}

export function buildOperationCatalog(bundle: ExtractionBundle, config?: FlowctlConfig): OperationCatalog {
  const operations: OperationCatalogEntry[] = [];
  const endpointRouteCounts = new Map<string, number>();
  for (const endpoint of bundle.endpoints) {
    const key = `${endpoint.method.toUpperCase()}:${normalizeTemplate(endpoint.pathTemplate)}`;
    endpointRouteCounts.set(key, (endpointRouteCounts.get(key) ?? 0) + 1);
  }
  for (const endpoint of bundle.endpoints) {
    const methodInScope = !config || config.analysis.includeHttpMethods.includes(endpoint.method.toUpperCase());
    const frontend = bundle.httpOperations.filter((http) => httpMatch(http.method, http.pathTemplate, endpoint.method, endpoint.pathTemplate));
    const requestContracts = (bundle.requestContracts ?? []).filter((contract) => (
      contract.endpointId === endpoint.id
      && frontend.some((http) => http.id === contract.httpOperationId)
    ));
    const effects = bundle.effects.filter((effect) => endpoint.terminalEffectIds.includes(effect.id));
    const effect = effects[0];
    const hasUnknownTerminalEffect = effects.some((candidate) => candidate.kind === 'unknown-mutation');
    const hasConditionalAuthorization = endpoint.authorization.status === 'conditional';
    const hasConditionalDomainGuard = solvePredicate(endpoint.domainGuard).status === 'conditional';
    const hasOpaqueValidation = bundle.validations.some((validation) => (
      endpoint.validationIds.includes(validation.id) && validation.kind === 'opaque'
    ));
    const hasAmbiguousMapping = (endpointRouteCounts.get(`${endpoint.method.toUpperCase()}:${normalizeTemplate(endpoint.pathTemplate)}`) ?? 0) > 1;
    const machineName = effect?.kind === 'authentication-session-issued'
      ? 'authentication.login'
      : commandName(endpoint.handler, effect?.entity ?? endpoint.controller.replace(/Controller$/, ''));
    const wiki = bundle.wikiConcepts.find((concept) => [concept.canonicalLabel, ...concept.aliases].some((alias) => slug(alias) === slug(effect?.entity ?? '')));
    const label = humanizeCommand(machineName, wiki?.canonicalLabel);
    operations.push({
      id: stableId('operation', `${endpoint.id}:${endpoint.method}:${endpoint.pathTemplate}:${effect?.kind ?? 'mutation'}:${effect?.entity ?? ''}`),
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
      inclusion: methodInScope && endpoint.terminalEffectIds.length
        ? (hasUnknownTerminalEffect || hasConditionalAuthorization || hasConditionalDomainGuard || hasOpaqueValidation || hasAmbiguousMapping
          ? 'review-required'
          : frontend.length
            ? (requestContracts.length && !requestContracts.every((contract) => contract.status === 'fields-present') ? 'review-required' : 'included')
            : 'review-required')
        : 'excluded',
      requestContractIds: requestContracts.map((contract) => contract.id),
      evidenceRefs: [
        endpoint.id,
        ...frontend.map((value) => value.id),
        ...requestContracts.map((contract) => contract.id),
        ...endpoint.terminalEffectIds,
        ...(wiki ? [wiki.id] : []),
      ],
    });
  }
  if (config) {
    const excludedMethods = bundle.endpoints.filter((endpoint) => !config.analysis.includeHttpMethods.includes(endpoint.method.toUpperCase()));
    if (excludedMethods.length && !bundle.diagnostics.some((diagnostic) => diagnostic.code === 'HTTP_METHOD_OUT_OF_SCOPE')) {
      bundle.diagnostics.push({
        code: 'HTTP_METHOD_OUT_OF_SCOPE',
        severity: 'info',
        message: `${excludedMethods.length} endpoint(s) were excluded because their HTTP methods are outside analysis.includeHttpMethods (${config.analysis.includeHttpMethods.join(', ')}).`,
        evidenceRefs: excludedMethods.map((endpoint) => endpoint.id),
        scope: 'analysis.includeHttpMethods',
      });
    }
  }
  const ambiguousMappings = bundle.endpoints.filter((endpoint) => (
    (endpointRouteCounts.get(`${endpoint.method.toUpperCase()}:${normalizeTemplate(endpoint.pathTemplate)}`) ?? 0) > 1
  ));
  if (ambiguousMappings.length && !bundle.diagnostics.some((diagnostic) => diagnostic.code === 'JAVA_ENDPOINT_MAPPING_COLLISION')) {
    bundle.diagnostics.push({
      code: 'JAVA_ENDPOINT_MAPPING_COLLISION',
      severity: 'warning',
      message: `${ambiguousMappings.length} backend endpoint(s) share an HTTP method and normalized path. Mapping params/consumes discriminators are not compiled, so the affected operations require review.`,
      evidenceRefs: ambiguousMappings.map((endpoint) => endpoint.id),
      scope: 'operation-catalog',
    });
  }
  return { operations: stableSort(operations, (value) => value.id) };
}

export function buildActorRequirements(bundle: ExtractionBundle, catalog: OperationCatalog): ActorRequirements {
  const actors: ActorRequirement[] = [];
  for (const operation of catalog.operations.filter((candidate) => candidate.inclusion !== 'excluded')) {
    const endpoint = bundle.endpoints.find((candidate) => candidate.id === operation.backendEndpointId);
    if (!endpoint) continue;
    if (endpoint.authorization.status === 'conditional') {
      const predicate: Predicate = {
        kind: 'opaque',
        sourceExpression: endpoint.authorization.sourceExpression ?? `authorization:${endpoint.id}`,
        reason: endpoint.authorization.reason ?? 'The backend authorization expression requires review.',
      };
      const actor: ActorRequirement = {
        id: stableId('actor-requirement', `${operation.id}:conditional:${stableJson(predicate)}`),
        authentication: 'required',
        authoritiesAll: [],
        rolesAll: [],
        attributePredicates: [predicate],
        relationships: [],
        label: 'authenticated principal satisfying unresolved authorization',
        evidenceRefs: [endpoint.id],
      };
      actors.push(actor);
      operation.actorRequirementIds = [actor.id];
      operation.inclusion = 'review-required';
      continue;
    }
    const backend = bundle.permissions.filter((permission) => endpoint.permissionIds.includes(permission.id));
    const frontend = bundle.permissions.filter((permission) => permission.layer === 'frontend' && backend.some((back) => back.authority === permission.authority));
    const authorities = [...new Set([...backend, ...frontend].map((permission) => permission.authority))].sort();
    const authenticationRequired = endpoint.authorization.status === 'authenticated' || authorities.length > 0;
    const actor: ActorRequirement = {
      id: stableId('actor-requirement', `${operation.id}:${authorities.join(',') || (authenticationRequired ? 'authenticated' : 'anonymous')}`),
      authentication: authenticationRequired ? 'required' : 'anonymous',
      authoritiesAll: authorities,
      rolesAll: authorities.filter((authority) => authority.startsWith('ROLE_')),
      attributePredicates: [],
      relationships: [],
      label: authorities.length ? `principal with ${authorities.join(', ')}` : authenticationRequired ? 'authenticated principal' : 'anonymous principal',
      evidenceRefs: [...backend, ...frontend].map((permission) => permission.id),
    };
    actors.push(actor);
    operation.actorRequirementIds = [actor.id];
  }
  return { actors: dedupe(actors, (value) => value.id) };
}

export function buildPageContracts(bundle: ExtractionBundle, catalog: OperationCatalog = buildOperationCatalog(bundle)): PageContracts {
  const pages: PageContract[] = bundle.pages.map((page) => {
    const routePatterns = bundle.routes.filter((route) => page.routeIds.includes(route.id)).map((route) => route.path);
    const fields = dedupe(bundle.fields.filter((field) => field.pageId === page.id).map((field) => attachBackendConstraints(field, page.id, bundle, catalog)), (field) => field.id);
    const actions = bundle.actions.filter((action) => action.pageId === page.id);
    const completeness = page.completeness ?? 'exact';
    const unresolvedChildComponentRefs = page.unresolvedChildComponentRefs ?? [];
    // Incomplete composition means the action inventory may be missing alternatives;
    // it does not invalidate a separately source-proved action that was extracted.
    // Guards on that action/component remain attached to the action itself.
    const entryConditions: Predicate[] = [];
    return {
      id: page.id,
      name: page.name,
      routePatterns,
      fields,
      actions,
      entryConditions,
      completeness,
      unresolvedChildComponentRefs,
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

  for (const page of pages.pages) nodes.push({
    id: page.id,
    kind: 'screen-state',
    label: page.name,
    referenceId: page.id,
    attributes: {
      routePatterns: page.routePatterns,
      completeness: page.completeness,
      fieldIds: page.fields.map((field) => field.id),
    },
  });
  for (const action of bundle.actions) nodes.push({ id: action.id, kind: 'action', label: action.accessibleName ?? action.component, referenceId: action.id, attributes: { pageId: action.pageId } });
  for (const action of bundle.actions) {
    const sourcePage = pages.pages.find((page) => page.id === action.pageId);
    edges.push(behaviorEdge(action.pageId, action.id, allPredicates([
      ...(sourcePage?.entryConditions ?? []),
      ...action.visibleWhen,
      ...action.enabledWhen,
      ...(action.handlerResolution === 'conditional' ? [{
        kind: 'opaque' as const,
        sourceExpression: action.handlerExpression ?? `handler:${action.id}`,
        reason: 'The UI action handler was not resolved exactly.',
      }] : []),
    ]), [], 'neutral', [action.id, ...(sourcePage?.evidenceRefs ?? [])]));
    const directNavigations = bundle.navigations.filter((navigation) => action.navigationIds?.includes(navigation.id));
    const handler = action.handlerId ? bundle.handlers.find((candidate) => candidate.id === action.handlerId) : undefined;
    if (!handler) {
      for (const navigation of directNavigations) {
        const target = pages.pages.find((page) => page.routePatterns.some((route) => routeMatches(navigation.target, route)));
        if (target) edges.push(behaviorEdge(
          action.id,
          target.id,
          navigationGuard(navigation),
          [{ kind: 'navigate', target: navigation.target }],
          'neutral',
          [action.id, navigation.id, target.id],
        ));
      }
      continue;
    }
    const httpIds = resolveHandlerHttpIds(handler, bundle.handlers, bundle.httpOperations);
    const actionRequestContracts = (bundle.requestContracts ?? []).filter((contract) => contract.actionId === action.id);
    actionRequestContracts.forEach((contract) => httpIds.add(contract.httpOperationId));
    const operations = catalog.operations.filter((operation) => operation.frontendOperationIds.some((id) => httpIds.has(id)) && operation.inclusion !== 'excluded');
    const multiOperationOrderGuard: Predicate = operations.length > 1
      ? {
          kind: 'opaque',
          sourceExpression: `multi-operation-handler:${handler.id}`,
          reason: 'The handler reaches multiple important backend operations; their awaited order and shared continuation are not yet represented as one sequential behavior path.',
        }
      : TRUE;
    const navigations = dedupe([
      ...directNavigations,
      ...resolveHandlerNavigations(handler, bundle.handlers, bundle.navigations),
    ], (navigation) => `${navigation.id}:${predicateLabel(navigation.guard)}`);

    for (const operation of operations) {
      const invocationId = stableId('operation-invocation', `${action.id}:${operation.id}`);
      if (!nodes.some((node) => node.id === invocationId)) nodes.push({
        id: invocationId,
        kind: 'operation',
        label: operation.businessCommand.label,
        referenceId: operation.id,
        attributes: {
          method: operation.method,
          pathTemplate: operation.pathTemplate,
          actorRequirementIds: operation.actorRequirementIds,
          actionId: action.id,
        },
      });
      const endpoint = bundle.endpoints.find((candidate) => candidate.id === operation.backendEndpointId);
      const authorizationGuard: Predicate = endpoint?.authorization.status === 'conditional'
        ? {
            kind: 'opaque',
            sourceExpression: endpoint.authorization.sourceExpression ?? `authorization:${endpoint.id}`,
            reason: endpoint.authorization.reason ?? 'The backend authorization expression requires review.',
          }
        : TRUE;
      const domainGuard: Predicate = endpoint?.domainGuard ?? {
        kind: 'opaque',
        sourceExpression: `backend-domain-guard:${operation.backendEndpointId}`,
        reason: 'The backend endpoint acceptance guard is unavailable.',
      };
      const opaqueValidationIds = bundle.validations.filter((validation) => (
        operation.validationIds.includes(validation.id) && validation.kind === 'opaque'
      )).map((validation) => validation.id);
      const validationGuard: Predicate = opaqueValidationIds.length
        ? {
            kind: 'opaque',
            sourceExpression: `backend-validation:${opaqueValidationIds.join(',')}`,
            reason: 'One or more backend validation annotations are unsupported by the constraint compiler.',
          }
        : TRUE;
      const requestContracts = actionRequestContracts.filter((contract) => (
        contract.actionId === action.id
        && contract.endpointId === operation.backendEndpointId
        && operation.frontendOperationIds.includes(contract.httpOperationId)
      ));
      const usableRequestContracts = requestContracts.filter((contract) => (
        contract.status !== 'required-fields-missing' && contract.status !== 'required-fields-invalid'
      ));
      if (requestContracts.length && !usableRequestContracts.length) continue;

      const requiredRequestFields = bundle.validations.filter((validation) => (
        operation.validationIds.includes(validation.id)
        && validation.kind === 'required'
        && validation.value !== false
      ));
      const requestAlternatives = usableRequestContracts.length
        ? usableRequestContracts.map((contract) => ({
            guard: allPredicates([
              contract.dispatchGuard,
              payloadLiteralGuard(contract.literalBindings),
              ...(contract.status === 'review-required'
                ? [{
                    kind: 'opaque' as const,
                    sourceExpression: `request-payload:${contract.id}`,
                    reason: 'Required request-field presence or value provenance depends on unresolved source dataflow.',
                  }]
                : []),
            ]),
            contracts: [contract],
          }))
        : [{
            guard: requiredRequestFields.length
              ? {
                  kind: 'opaque' as const,
                  sourceExpression: `request-payload:${action.id}:${operation.id}`,
                  reason: 'No source-resolved request payload contract was available for the required backend fields.',
                }
              : TRUE,
            contracts: [],
          }];
      for (const alternative of requestAlternatives) {
        const handlerCompletionGuard: Predicate = handler.normalCompletion === 'conditional'
          ? {
              kind: 'opaque',
              sourceExpression: `normal-completion:${handler.id}`,
              reason: handler.normalCompletionReason ?? 'The UI handler normal-success path is not proved.',
            }
          : TRUE;
        edges.push(behaviorEdge(
          action.id,
          invocationId,
          allPredicates([alternative.guard, authorizationGuard, domainGuard, validationGuard, handlerCompletionGuard, multiOperationOrderGuard]),
          [{ kind: 'invoke-operation', operationId: operation.id }],
          'neutral',
          [action.id, operation.id, invocationId, ...(endpoint?.authorization.status === 'conditional' ? [endpoint.id] : []), ...alternative.contracts.map((contract) => contract.id)],
          alternative.contracts.map((contract) => ({
            id: contract.id,
            status: contract.status,
            certainty: contract.payloadShape.certainty,
            dispatchGuard: contract.dispatchGuard,
            providedFields: contract.providedFields,
            literalBindings: contract.literalBindings,
            uiFieldBindings: contract.uiFieldBindings,
            requiredFields: contract.requiredFields,
            missingRequiredFields: contract.missingRequiredFields,
            unprovenFieldValues: contract.unprovenFieldValues,
            invalidFieldValues: contract.invalidFieldValues,
          })),
        ));
      }
      const hasUnknownTerminalEffect = operation.terminalEffectIds.some((effectId) => (
        bundle.effects.find((effect) => effect.id === effectId)?.kind === 'unknown-mutation'
      ));
      const terminalEffectGuard: Predicate = hasUnknownTerminalEffect
        ? {
            kind: 'opaque',
            sourceExpression: `terminal-effect:${operation.id}`,
            reason: 'The backend mutation was not resolved to a concrete terminal effect.',
          }
        : TRUE;
      const targetPages = targetPagesForNavigations(navigations, bundle, pages);
      if (targetPages.length) {
        for (const target of targetPages) {
          const navigation = navigations.find((candidate) => target.routePatterns.some((route) => routeMatches(candidate.target, route)));
          const continuationGuard: Predicate = navigation && navigationProvesOperationSuccess(
            navigation,
            operation,
            usableRequestContracts,
            bundle,
          )
            ? TRUE
            : {
                kind: 'opaque',
                sourceExpression: `success-continuation:${action.id}:${operation.id}:${navigation?.id ?? target.id}`,
                reason: 'The navigation is not proved to immediately follow one awaited call for this operation on the successful control-flow path.',
              };
          const effects = [
            ...operation.terminalEffectIds.map((effectId) => ({ kind: 'entity-transition' as const, effectId })),
            ...(navigation ? [{ kind: 'navigate' as const, target: navigation.target }] : []),
          ];
          edges.push(behaviorEdge(invocationId, target.id, allPredicates([navigation ? navigationGuard(navigation) : TRUE, terminalEffectGuard, continuationGuard]), effects, 'success', [operation.id, invocationId, ...(navigation ? [navigation.id] : []), target.id]));
          successNodeIds.add(target.id);
        }
      } else {
        const outcomeId = stableId('outcome', `${invocationId}:success`);
        nodes.push({ id: outcomeId, kind: 'outcome', label: `${operation.businessCommand.label} succeeds`, referenceId: operation.id, attributes: {} });
        edges.push(behaviorEdge(invocationId, outcomeId, terminalEffectGuard, operation.terminalEffectIds.map((effectId) => ({ kind: 'entity-transition', effectId })), 'success', [operation.id, invocationId, ...operation.terminalEffectIds]));
        successNodeIds.add(outcomeId);
      }
    }

    if (!operations.length) {
      for (const navigation of navigations) {
        const target = pages.pages.find((page) => page.routePatterns.some((route) => routeMatches(navigation.target, route)));
        if (target) edges.push(behaviorEdge(action.id, target.id, navigationGuard(navigation), [{ kind: 'navigate', target: navigation.target }], 'neutral', [action.id, navigation.id, target.id]));
      }
    }
  }

  const actionNavigationIds = new Set(bundle.actions.flatMap((action) => action.navigationIds ?? []));
  for (const navigation of bundle.navigations.filter((candidate) => (
    candidate.trigger === 'declarative'
    && candidate.fromPageId
    && !actionNavigationIds.has(candidate.id)
  ))) {
    const source = pages.pages.find((page) => page.id === navigation.fromPageId);
    const target = pages.pages.find((page) => page.routePatterns.some((route) => routeMatches(navigation.target, route)));
    if (!source || !target) continue;
    edges.push(behaviorEdge(
      source.id,
      target.id,
      allPredicates([...source.entryConditions, navigationGuard(navigation)]),
      [{ kind: 'navigate', target: navigation.target }],
      'neutral',
      [source.id, navigation.id, target.id],
    ));
  }

  const incoming = new Set(edges.map((value) => value.to));
  const configuredEntries = pages.pages.filter((page) => page.routePatterns.some((route) => config.analysis.entryRoutes.some((entry) => routeMatches(entry, route)))).map((page) => page.id);
  const structuralEntries = pages.pages.filter((page) => !incoming.has(page.id)).map((page) => page.id);
  let entryNodeIds: string[];
  if (config.analysis.entryRoutes.length) {
    entryNodeIds = configuredEntries;
    if (!configuredEntries.length && !bundle.diagnostics.some((diagnostic) => diagnostic.code === 'CONFIGURED_ENTRY_ROUTE_UNRESOLVED')) {
      bundle.diagnostics.push({
        code: 'CONFIGURED_ENTRY_ROUTE_UNRESOLVED',
        severity: 'blocked',
        message: `None of the configured entry routes (${config.analysis.entryRoutes.join(', ')}) matched a source-derived page route. Holistic path search was not started from a structural mid-flow fallback.`,
        evidenceRefs: bundle.routes.map((route) => route.id),
        scope: 'analysis.entryRoutes',
      });
    }
  } else {
    entryNodeIds = structuralEntries;
    if (structuralEntries.length && !bundle.diagnostics.some((diagnostic) => diagnostic.code === 'STRUCTURAL_ENTRY_ROUTE_INFERRED')) {
      bundle.diagnostics.push({
        code: 'STRUCTURAL_ENTRY_ROUTE_INFERRED',
        severity: 'warning',
        message: 'No entry route was configured; graph roots are being used as candidate entry screens and require review.',
        evidenceRefs: structuralEntries,
        scope: 'analysis.entryRoutes',
      });
    }
  }
  return {
    nodes: dedupe(nodes, (value) => value.id),
    edges: dedupe(edges, (value) => value.id),
    entryNodeIds,
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
    const successNodeIds = graph.edges.filter((edge) => (
      operationIds.includes(graph.nodes.find((node) => node.id === edge.from)?.referenceId ?? '')
      && edge.outcome === 'success'
    )).map((edge) => edge.to);
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
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  type MutableTruncation = PathSearchTruncationDetail & { sampleKey: string };
  const truncations = new Map<string, MutableTruncation>();
  let enqueuedStates = 0;
  let dequeuedStates = 0;
  let depthPrunes = 0;
  let visitPrunes = 0;
  graph.edges.forEach((edge) => outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]));

  const recordTruncation = (value: {
    reason: PathSearchTruncationReason;
    familyId: string;
    nodeId: string;
    edgeId?: string;
    limit: number;
    observed: number;
    nodePath: string[];
    edgePath: string[];
  }): void => {
    if (value.reason === 'max-path-depth') depthPrunes += 1;
    else visitPrunes += 1;
    const key = stableJson({ reason: value.reason, familyId: value.familyId, nodeId: value.nodeId, edgeId: value.edgeId ?? null });
    const sampleKey = stableJson({ nodePath: value.nodePath, edgePath: value.edgePath });
    const current = truncations.get(key);
    if (!current) {
      truncations.set(key, {
        reason: value.reason,
        familyId: value.familyId,
        nodeId: value.nodeId,
        ...(value.edgeId ? { edgeId: value.edgeId } : {}),
        limit: value.limit,
        minimumObserved: value.observed,
        maximumObserved: value.observed,
        count: 1,
        sampleNodePath: value.nodePath,
        sampleEdgePath: value.edgePath,
        sampleKey,
      });
      return;
    }
    current.count += 1;
    current.minimumObserved = Math.min(current.minimumObserved, value.observed);
    current.maximumObserved = Math.max(current.maximumObserved, value.observed);
    if (sampleKey < current.sampleKey) {
      current.sampleKey = sampleKey;
      current.sampleNodePath = value.nodePath;
      current.sampleEdgePath = value.edgePath;
    }
  };

  for (const family of families.families) {
    type SearchState = { nodeId: string; nodePath: string[]; edgePath: string[]; guards: Predicate[]; visits: Map<string, number>; evidence: string[] };
    const queue: SearchState[] = family.entryNodeIds.map((nodeId) => ({
      nodeId,
      nodePath: [nodeId],
      edgePath: [],
      guards: config.analysis.entryRoutes.length ? [] : [{
        kind: 'opaque',
        domain: 'unknown',
        sourceExpression: `structural-entry:${nodeId}`,
        reason: 'This graph root is only a structural entry candidate because no application entry route was configured.',
      }],
      visits: new Map([[nodeId, 1]]),
      evidence: [nodeId],
    }));
    enqueuedStates += queue.length;
    while (queue.length) {
      const state = queue.shift()!;
      dequeuedStates += 1;
      if (state.nodePath.length > config.analysis.maxPathDepth) {
        recordTruncation({
          reason: 'max-path-depth',
          familyId: family.id,
          nodeId: state.nodeId,
          limit: config.analysis.maxPathDepth,
          observed: state.nodePath.length,
          nodePath: state.nodePath,
          edgePath: state.edgePath,
        });
        continue;
      }
      if (family.successNodeIds.includes(state.nodeId)) {
        const lastEdge = edgeById.get(state.edgePath.at(-1) ?? '');
        const provesFamilyOperation = state.nodePath.some((nodeId) => (
          family.operationIds.includes(graph.nodes.find((node) => node.id === nodeId)?.referenceId ?? '')
        ));
        const provesFamilySuccess = Boolean(
          lastEdge
          && lastEdge.outcome === 'success'
          && family.operationIds.includes(graph.nodes.find((node) => node.id === lastEdge.from)?.referenceId ?? '')
          && lastEdge.to === state.nodeId,
        );
        if (provesFamilyOperation && provesFamilySuccess) {
          const pathCondition = allPredicates(state.guards);
          const pageSequence = state.nodePath.filter((id) => graph.nodes.find((node) => node.id === id)?.kind === 'screen-state');
          const actionSequence = state.nodePath.filter((id) => graph.nodes.find((node) => node.id === id)?.kind === 'action');
          for (const model of enumeratePredicateModels(pathCondition)) {
            witnesses.push({
              id: stableId('witness', `${family.id}:${state.edgePath.join('>')}:${predicateLabel(model.predicate)}`),
              familyId: family.id,
              nodePath: state.nodePath,
              edgePath: state.edgePath,
              pageSequence,
              actionSequence,
              pathCondition: model.predicate,
              assignments: model.assignments,
              feasibility: model.status,
              evidenceRefs: [...new Set(state.evidence)],
            });
          }
          continue;
        }
        // A success node may also be an entry/shared screen. Reaching it without
        // the family operation's success edge is not terminal; keep searching.
      }

      for (const edge of outgoing.get(state.nodeId) ?? []) {
        if (edge.outcome === 'error' || edge.outcome === 'cancel') continue;
        const targetNode = nodeById.get(edge.to);
        const repeatsScreenWithoutBusinessProgress = targetNode?.kind === 'screen-state'
          && state.nodePath.includes(edge.to)
          && edge.outcome !== 'success'
          && edge.effects.some((effect) => effect.kind === 'navigate')
          && edge.effects.every((effect) => effect.kind === 'navigate');
        if (repeatsScreenWithoutBusinessProgress) continue;
        const visits = new Map(state.visits);
        const count = (visits.get(edge.to) ?? 0) + 1;
        if (count > config.analysis.maxStateVisits) {
          recordTruncation({
            reason: 'max-state-visits',
            familyId: family.id,
            nodeId: edge.to,
            edgeId: edge.id,
            limit: config.analysis.maxStateVisits,
            observed: count,
            nodePath: [...state.nodePath, edge.to],
            edgePath: [...state.edgePath, edge.id],
          });
          continue;
        }
        visits.set(edge.to, count);
        const traversalGuard = allPredicates([
          edge.guard,
          requestFieldOccurrenceGuard(edge, state.nodePath, graph),
        ]);
        const condition = allPredicates([...state.guards, traversalGuard]);
        if (solvePredicate(condition).status === 'unsatisfiable') continue;
        queue.push({
          nodeId: edge.to,
          nodePath: [...state.nodePath, edge.to],
          edgePath: [...state.edgePath, edge.id],
          guards: [...state.guards, traversalGuard],
          visits,
          evidence: [...state.evidence, ...edge.evidenceRefs],
        });
        enqueuedStates += 1;
      }
    }
  }
  const details = stableSort(
    [...truncations.values()].map(({ sampleKey: _sampleKey, ...detail }) => detail),
    (detail) => stableJson({ reason: detail.reason, familyId: detail.familyId, nodeId: detail.nodeId, edgeId: detail.edgeId ?? null }),
  );
  return {
    witnesses: dedupe(witnesses, (value) => value.id),
    search: {
      bounds: {
        maxPathDepth: config.analysis.maxPathDepth,
        maxStateVisits: config.analysis.maxStateVisits,
      },
      enqueuedStates,
      dequeuedStates,
      truncation: {
        occurred: details.length > 0,
        counts: {
          maxPathDepth: depthPrunes,
          maxStateVisits: visitPrunes,
        },
        details,
      },
    },
  };
}

function requestFieldOccurrenceGuard(edge: BehaviorEdge, priorNodePath: string[], graph: BehaviorGraph): Predicate {
  const contracts = edge.requestPayloadContracts ?? [];
  const requiredFieldIds = [...new Set(contracts.flatMap((contract) => (
    Object.values(contract.uiFieldBindings ?? {})
  )))].sort();
  if (!requiredFieldIds.length) return TRUE;
  const occurredFieldIds = new Set(priorNodePath.flatMap((nodeId) => {
    const value = graph.nodes.find((node) => node.id === nodeId)?.attributes.fieldIds;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }));
  const missing = requiredFieldIds.filter((fieldId) => !occurredFieldIds.has(fieldId));
  if (!missing.length) return TRUE;
  return {
    kind: 'opaque',
    sourceExpression: `request-ui-provenance:${contracts.map((contract) => contract.id).sort().join(',')}:${missing.join(',')}`,
    reason: 'A backend-validated request value is tied to a writable UI field, but this concrete path does not visit that field before submission.',
  };
}

export function reduceVariants(
  witnesses: PathWitnesses,
  families: FlowFamilies,
  graph: BehaviorGraph,
  pages: PageContracts,
  actors?: ActorRequirements,
): FlowVariants {
  const variants: FlowVariant[] = [];
  const rejectedCandidates: Diagnostic[] = [];
  for (const family of families.families) {
    const familyWitnesses = witnesses.witnesses.filter((witness) => witness.familyId === family.id);
    const groups = new Map<string, PathWitness[]>();
    for (const witness of familyWitnesses) {
      const operationIds = operationIdsForNodePath(witness.nodePath, family.operationIds, graph);
      const actorRequirementIds = actorIdsForNodePath(witness.nodePath, graph);
      const assignmentBindings = classifyWitnessAssignments(witness, pages, graph, actorRequirementIds, actors);
      const signatureValue = {
        actorRequirementIds,
        actorAttributeAssignments: assignmentBindings.actorAttributeAssignments,
        entityPrerequisites: assignmentBindings.entityPrerequisites,
        unboundPathAssignments: assignmentBindings.unboundPathAssignments,
        pageSequence: witness.pageSequence,
        actionSequence: witness.actionSequence,
        operationIds,
        successNode: witness.nodePath.at(-1),
        activeFieldContracts: activeFieldContracts(witness, pages, graph),
        requestPayloadContracts: requestPayloadSignature(witness, graph),
      };
      const signature = sha256(stableJson(signatureValue));
      groups.set(signature, [...(groups.get(signature) ?? []), witness]);
    }

    const candidates = [...groups.entries()].map(([signature, group], index) => {
      const representative = group[0]!;
      const discriminator = discriminatorLabel(representative, graph, index + 1);
      return {
        signature,
        group,
        representative,
        discriminator,
        baseId: `${family.id}.${slug(discriminator)}`,
      };
    });
    const baseIdCounts = new Map<string, number>();
    candidates.forEach((candidate) => baseIdCounts.set(candidate.baseId, (baseIdCounts.get(candidate.baseId) ?? 0) + 1));

    for (const candidate of candidates) {
      const { signature, group, representative, discriminator, baseId } = candidate;
      const operationIds = operationIdsForNodePath(representative.nodePath, family.operationIds, graph);
      const actorRequirementIds = actorIdsForNodePath(representative.nodePath, graph);
      const assignmentBindings = classifyWitnessAssignments(representative, pages, graph, actorRequirementIds, actors);
      const fieldContracts = group.flatMap((value) => activeFieldContracts(value, pages, graph));
      const contradictions = fieldContracts.filter((contract) => contract.constraintStatus === 'unsatisfiable');
      if (contradictions.length) {
        rejectedCandidates.push({
          code: 'FLOW_CANDIDATE_FIELD_CONTRADICTION',
          severity: 'blocked',
          message: `Candidate ${family.id}/${discriminator} cannot satisfy field contract(s): ${contradictions.map((contract) => `${String(contract.pageId)}:${String(contract.fieldPath)}`).join(', ')}.`,
          evidenceRefs: contradictions.flatMap((contract) => [
            String(contract.pageId),
            String(contract.fieldId),
            ...((contract.constraintIds as string[] | undefined) ?? []),
          ]),
          scope: representative.id,
        });
        continue;
      }
      const id = (baseIdCounts.get(baseId) ?? 0) > 1
        ? `${baseId}.${variantCollisionSuffix(representative, signature)}`
        : baseId;
      variants.push({
        id,
        familyId: family.id,
        label: `${family.label} — ${discriminator}`,
        witnessIds: group.map((value) => value.id),
        behaviorSignature: signature,
        actorRequirementIds,
        pathCondition: representative.pathCondition,
        pageSequence: representative.pageSequence,
        actionSequence: representative.actionSequence,
        operationIds,
        dataRequirementIds: [],
        ...(Object.keys(assignmentBindings.actorAttributeAssignments).length
          ? { actorAttributeAssignments: assignmentBindings.actorAttributeAssignments }
          : {}),
        ...(assignmentBindings.entityPrerequisites.length
          ? { entityPrerequisites: assignmentBindings.entityPrerequisites }
          : {}),
        ...(assignmentBindings.unboundPathAssignments.length
          ? { unboundPathAssignments: assignmentBindings.unboundPathAssignments }
          : {}),
        feasibility: group.some((value) => (
          value.feasibility === 'conditional'
          || classifyWitnessAssignments(value, pages, graph, actorIdsForNodePath(value.nodePath, graph), actors).unboundPathAssignments.length > 0
          || activeFieldContracts(value, pages, graph).some((contract) => (
            contract.visibility === 'conditional'
            || contract.inputMode === 'conditional'
            || contract.required === 'conditional'
            || contract.constraintStatus === 'conditional'
            || (contract.constraints as Array<{ kind?: string }>).some((constraint) => constraint.kind === 'opaque')
          ))
        )) ? 'conditional' : 'satisfiable',
        evidenceRefs: [...new Set(group.flatMap((value) => value.evidenceRefs))],
      });
    }
  }
  return {
    variants: stableSort(variants, (value) => value.id),
    ...(rejectedCandidates.length ? { rejectedCandidates } : {}),
  };
}

export function buildDataRequirements(
  variants: FlowVariants,
  pages: PageContracts,
  actors: ActorRequirements,
  context: { witnesses: PathWitnesses; behavior: BehaviorGraph },
): DataRequirement[] {
  const requirements: DataRequirement[] = [];
  for (const variant of variants.variants) {
    variant.dataRequirementIds = [];
    const witness = context.witnesses.witnesses.find((candidate) => candidate.id === variant.witnessIds[0]);
    if (!witness) throw new Error(`Variant ${variant.id} has no representative witness for data planning.`);
    const inputScreenIds = witnessInputScreenIds(witness, context.behavior);
    const requestContractIds = requestContractIdsForWitness(witness, context.behavior);
    const fields = pages.pages
      .filter((page) => inputScreenIds.has(page.id))
      .flatMap((page) => page.fields.map((field) => ({ page, field })))
      .filter(({ field }) => fieldIsActive(field, variant.pathCondition) && fieldInputMode(field) === 'editable');
    for (const { page, field } of fields) {
      const assigned = assignmentForField(variant.pathCondition, field.dataPath, field.valueBinding?.path);
      const constraints = fieldConstraintsForOperations(field, variant.operationIds, requestContractIds);
      const entityPrerequisites = (variant.entityPrerequisites ?? []).filter((prerequisite) => (
        prerequisite.pageId === page.id && prerequisite.fieldId === field.id
      ));
      const classification = entityPrerequisites.length ? 'existing-entity' : classifyField(field, assigned !== undefined);
      const requirementConstraints = classification === 'secret-reference'
        ? redactSecretConstraints(constraints)
        : constraints;
      const exactAssignedValue = isRepresentativeValue(assigned) ? assigned : undefined;
      const representativeValue = classification === 'secret-reference' || classification === 'existing-entity'
        ? undefined
        : classification === 'runtime-option'
          ? staticOptionRepresentative(field, constraints, exactAssignedValue)
          : exactAssignedValue !== undefined
            ? exactAssignedValue
            : classification === 'synthetic-constrained'
              ? representativeValueForConstraints(constraints)
              : undefined;
      const expectedValue = representativeValue === undefined
        && exactAssignedValue !== undefined
        && (classification === 'existing-entity' || classification === 'runtime-option')
        ? exactAssignedValue
        : undefined;
      const requirement: DataRequirement = {
        id: stableId('data-requirement', `${variant.id}:${page.id}:${field.id}`),
        variantId: variant.id,
        pageId: page.id,
        fieldId: field.id,
        fieldPath: field.dataPath,
        classification,
        ...(expectedValue !== undefined ? { expectedValue } : {}),
        ...(entityPrerequisites.length ? {
          expectedAttributes: Object.fromEntries(entityPrerequisites.map((prerequisite) => [prerequisite.predicatePath, prerequisite.expectedValue])),
        } : {}),
        ...(representativeValue !== undefined ? { representativeValue } : {}),
        constraints: requirementConstraints,
        resolutionStrategies: strategiesForClassification(classification),
        status: representativeValue !== undefined ? 'generated' : 'unresolved',
        evidenceRefs: [field.id, ...requirementConstraints.map((constraint) => constraint.id)],
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
        actorRequirementId: actorId,
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
    const actorRequirementId = variant.actorRequirementIds.find((actorId) => (
      actors.actors.find((actor) => actor.id === actorId)?.authentication === 'required'
    ));
    for (const [attributePath, expectedValue] of Object.entries(variant.actorAttributeAssignments ?? {})) {
      const requirement: DataRequirement = {
        id: stableId('data-requirement', `${variant.id}:actor-attribute:${attributePath}`),
        variantId: variant.id,
        ...(actorRequirementId ? { actorRequirementId } : {}),
        fieldPath: attributePath,
        classification: 'actor-attribute',
        expectedValue,
        constraints: [],
        resolutionStrategies: ['approved-actor-fixture', 'approved-identity-catalog', 'manual-binding'],
        status: 'unresolved',
        evidenceRefs: [variant.id, ...(actorRequirementId ? [actorRequirementId] : [])],
      };
      requirements.push(requirement);
      variant.dataRequirementIds.push(requirement.id);
    }
    variant.dataRequirementIds = [...new Set(variant.dataRequirementIds)];
  }
  return dedupe(requirements, (value) => value.id);
}

function activeFieldContracts(witness: PathWitness, pages: PageContracts, graph: BehaviorGraph): Record<string, unknown>[] {
  const operationIds = witness.nodePath.flatMap((nodeId) => {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    return node?.kind === 'operation' && node.referenceId ? [node.referenceId] : [];
  });
  const requestContractIds = requestContractIdsForWitness(witness, graph);
  const inputScreenIds = witnessInputScreenIds(witness, graph);
  return pages.pages
    .filter((page) => inputScreenIds.has(page.id))
    .flatMap((page) => page.fields.map((field) => ({ page, field })))
    .filter(({ field }) => fieldIsActive(field, witness.pathCondition))
    .map(({ page, field }) => {
      const constraints = fieldConstraintsForOperations(field, operationIds, requestContractIds);
      return ({
      pageId: page.id,
      fieldId: field.id,
      fieldPath: field.dataPath,
      controlKind: field.controlKind,
      inputMode: fieldInputMode(field),
      visibility: solvePredicate(allPredicates([witness.pathCondition, ...field.visibleWhen])).status,
      required: field.requiredWhen.length
        ? solvePredicate(allPredicates([witness.pathCondition, ...field.requiredWhen])).status
        : constraints.some((constraint) => constraint.kind === 'required' && constraint.value !== false),
      constraintStatus: fieldConstraintStatus(field, witness.pathCondition, constraints),
      constraintIds: constraints.map((constraint) => constraint.id),
      constraints: dedupe(constraints, constraintSemanticKey).map((constraint) => ({
        kind: constraint.kind,
        value: constraint.value,
        domain: constraint.domain,
      })),
    });
    });
}

/** Screens whose fields can be entered before the journey's terminal action. */
function witnessInputScreenIds(witness: PathWitness, graph: BehaviorGraph): Set<string> {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const lastActionIndex = witness.nodePath.reduce((last, nodeId, index) => (
    nodeById.get(nodeId)?.kind === 'action' ? index : last
  ), -1);
  if (lastActionIndex < 0) return new Set();
  return new Set(witness.nodePath.flatMap((nodeId, index) => (
    index <= lastActionIndex && nodeById.get(nodeId)?.kind === 'screen-state' ? [nodeId] : []
  )));
}

function requestContractIdsForWitness(witness: PathWitness, graph: BehaviorGraph): string[] {
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  return [...new Set(witness.edgePath.flatMap((edgeId) => (
    edgeById.get(edgeId)?.requestPayloadContracts?.map((contract) => contract.id) ?? []
  )))];
}

function requestPayloadSignature(witness: PathWitness, graph: BehaviorGraph): NonNullable<BehaviorEdge['requestPayloadContracts']> {
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  return witness.edgePath.flatMap((edgeId) => (
    [...(edgeById.get(edgeId)?.requestPayloadContracts ?? [])]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((contract) => ({
        ...contract,
        providedFields: [...contract.providedFields].sort(),
        requiredFields: [...contract.requiredFields].sort(),
        missingRequiredFields: [...contract.missingRequiredFields].sort(),
        unprovenFieldValues: [...(contract.unprovenFieldValues ?? [])].sort(),
        invalidFieldValues: [...(contract.invalidFieldValues ?? [])].sort(),
      }))
  ));
}

function variantCollisionSuffix(witness: PathWitness, signature: string): string {
  const assignmentKeys = Object.keys(witness.assignments)
    .sort()
    .map((key) => key.split('.').at(-1) ?? key);
  const keyPart = slug(assignmentKeys.join('-') || 'path').slice(0, 28);
  return `${keyPart}-${signature.replace(/^sha256:/, '').slice(0, 8)}`;
}

function actorIdsForNodePath(nodePath: string[], graph: BehaviorGraph): string[] {
  return [...new Set(nodePath.flatMap((nodeId) => {
    const value = graph.nodes.find((node) => node.id === nodeId)?.attributes.actorRequirementIds;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }))].sort();
}

function classifyWitnessAssignments(
  witness: PathWitness,
  pages: PageContracts,
  graph: BehaviorGraph,
  actorRequirementIds: string[],
  actors?: ActorRequirements,
): {
  actorAttributeAssignments: Record<string, string | number | boolean | null>;
  entityPrerequisites: NonNullable<FlowVariant['entityPrerequisites']>;
  unboundPathAssignments: string[];
} {
  const inputScreenIds = witnessInputScreenIds(witness, graph);
  const fields = pages.pages
    .filter((page) => inputScreenIds.has(page.id))
    .flatMap((page) => page.fields)
    .filter((field) => fieldIsActive(field, witness.pathCondition) && fieldInputMode(field) === 'editable');
  const fieldPaths = fields.flatMap((field) => [field.dataPath, field.valueBinding?.path].filter((value): value is string => Boolean(value)));
  const exactFieldPaths = new Set(fieldPaths);
  const leafCounts = new Map<string, number>();
  for (const fieldPath of new Set(fieldPaths)) {
    const leaf = fieldPath.split('.').at(-1)!;
    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);
  }
  const sourceLiteralAssignments = new Set(witness.edgePath.flatMap((edgeId) => (
    graph.edges.find((edge) => edge.id === edgeId)?.requestPayloadContracts
      ?.flatMap((contract) => Object.keys(contract.literalBindings ?? {})) ?? []
  )));
  const pathActors = actorRequirementIds.flatMap((actorId) => {
    const actor = actors?.actors.find((candidate) => candidate.id === actorId);
    return actor ? [actor] : [];
  });
  const requiredActorAvailable = pathActors.some((actor) => actor.authentication === 'required');
  const actorAttributeAssignments: Record<string, string | number | boolean | null> = {};
  const entityPrerequisites: NonNullable<FlowVariant['entityPrerequisites']> = [];
  const unboundPathAssignments: string[] = [];
  for (const [assignmentPath, value] of Object.entries(witness.assignments)) {
    const leaf = assignmentPath.split('.').at(-1)!;
    const controlledByField = exactFieldPaths.has(assignmentPath)
      || (leafCounts.get(leaf) === 1 && fieldPaths.some((fieldPath) => fieldPath.split('.').at(-1) === leaf));
    const establishedBySourceLiteral = sourceLiteralAssignments.has(assignmentPath);
    const establishedByActorAuthentication = isActorPresencePath(assignmentPath) && pathActors.some((actor) => (
      actor.authentication === 'anonymous'
        ? value === false || value === null
        : value === true
    ));
    if (controlledByField || establishedBySourceLiteral || establishedByActorAuthentication) continue;
    if (requiredActorAvailable && isActorAttributePath(assignmentPath)) {
      actorAttributeAssignments[assignmentPath] = value;
    } else {
      const entityField = entityFieldForPredicatePath(assignmentPath, fields);
      if (entityField) {
        entityPrerequisites.push({
          predicatePath: assignmentPath,
          expectedValue: value,
          pageId: entityField.pageId,
          fieldId: entityField.id,
          fieldPath: entityField.dataPath,
        });
      } else unboundPathAssignments.push(assignmentPath);
    }
  }
  return {
    actorAttributeAssignments: Object.fromEntries(Object.entries(actorAttributeAssignments).sort(([left], [right]) => left.localeCompare(right))),
    entityPrerequisites: stableSort(dedupe(entityPrerequisites, (value) => `${value.pageId}:${value.fieldId}:${value.predicatePath}:${String(value.expectedValue)}`), (value) => `${value.pageId}:${value.fieldId}:${value.predicatePath}`),
    unboundPathAssignments: [...new Set(unboundPathAssignments)].sort(),
  };
}

function isActorAttributePath(value: string): boolean {
  return /^(?:user|actor|principal|currentUser|session)(?:\.|$)/i.test(value);
}

function isActorPresencePath(value: string): boolean {
  return /^(?:user|actor|principal|currentUser|session)(?:\.authenticated)?$/i.test(value);
}

function entityFieldForPredicatePath(pathValue: string, fields: ReactFieldFact[]): ReactFieldFact | undefined {
  const [rawRoot, attribute] = pathValue.split('.');
  if (!rawRoot || !attribute) return undefined;
  const entity = rawRoot.replace(/^(?:selected|current|chosen|active)/i, '').replace(/(?:Entity|Model)$/i, '').toLowerCase();
  if (!entity) return undefined;
  const candidates = fields.filter((field) => {
    const leaf = field.dataPath.split('.').at(-1) ?? field.dataPath;
    const stem = leaf.replace(/(?:Id|Identifier|Key|Reference|Ref|Code|Number|No)$/i, '').toLowerCase();
    return stem === entity;
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function operationIdsForNodePath(nodePath: string[], allowed: string[], graph: BehaviorGraph): string[] {
  return [...new Set(nodePath.flatMap((nodeId) => {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    return node?.kind === 'operation' && node.referenceId && allowed.includes(node.referenceId) ? [node.referenceId] : [];
  }))].sort();
}

function isRepresentativeValue(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function fieldIsActive(field: ReactFieldFact, pathCondition: Predicate): boolean {
  return solvePredicate(allPredicates([pathCondition, ...field.visibleWhen])).status !== 'unsatisfiable';
}

function fieldInputMode(field: ReactFieldFact): NonNullable<ReactFieldFact['inputMode']> {
  return field.inputMode ?? 'editable';
}

function fieldConstraintStatus(
  field: ReactFieldFact,
  pathCondition: Predicate,
  constraints: ReactFieldFact['constraints'],
): 'satisfiable' | 'unsatisfiable' | 'conditional' {
  const assigned = assignmentForField(pathCondition, field.dataPath, field.valueBinding?.path);
  if (isRepresentativeValue(assigned)) {
    const result = evaluateConstraintValue(constraints, assigned, 'ui-input').status;
    if (result === 'invalid') return 'unsatisfiable';
    if (result === 'conditional') return 'conditional';
  }
  const setStatus = evaluateConstraintSet(constraints);
  return setStatus === 'unsatisfiable' ? 'unsatisfiable' : setStatus === 'conditional' ? 'conditional' : 'satisfiable';
}

function fieldConstraintsForOperations(
  field: ReactFieldFact,
  operationIds: string[],
  requestContractIds: string[] = [],
): ReactFieldFact['constraints'] {
  const backendConstraints = requestContractIds.length
    ? requestContractIds.flatMap((contractId) => field.backendConstraintsByRequestContractId?.[contractId] ?? [])
    : operationIds.flatMap((operationId) => field.backendConstraintsByOperationId?.[operationId] ?? []);
  return dedupe([
    ...field.constraints,
    ...backendConstraints,
  ], constraintSemanticKey);
}

function constraintSemanticKey(constraint: ReactFieldFact['constraints'][number]): string {
  return stableJson({
    fieldPath: constraint.fieldPath.split('.').at(-1)?.toLowerCase(),
    kind: constraint.kind,
    value: constraint.value,
    domain: constraint.domain,
  });
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
  const requestContracts = bundle.requestContracts ?? [];
  const operationCoverage = catalog.operations
    .filter((operation) => operation.inclusion !== 'excluded')
    .map((operation): CoverageReport['operationCoverage'][number] => {
      const operationNodeIds = graph.nodes.filter((node) => node.kind === 'operation' && node.referenceId === operation.id).map((node) => node.id);
      const family = families.families.find((candidate) => candidate.operationIds.includes(operation.id));
      const operationWitnesses = witnesses.witnesses.filter((witness) => witness.nodePath.some((nodeId) => operationNodeIds.includes(nodeId)));
      const operationVariants = variants.variants.filter((variant) => variant.operationIds.includes(operation.id));
      const searchTruncationReasons = family
        ? [...new Set((witnesses.search?.truncation.details ?? [])
          .filter((detail) => detail.familyId === family.id)
          .map((detail) => detail.reason))].sort()
        : [];
      const missingStage = !operation.frontendOperationIds.length
        ? 'frontend-client-join' as const
        : !operationNodeIds.length
          ? 'action-operation-join' as const
          : !graph.edges.some((edge) => operationNodeIds.includes(edge.from) && edge.outcome === 'success')
            ? 'success-continuation' as const
            : !family
              ? 'flow-family' as const
              : !operationWitnesses.length
                ? 'entry-success-witness' as const
                : !operationVariants.length
                  ? 'behavior-variant' as const
                  : undefined;
      return {
        operationId: operation.id,
        inclusion: operation.inclusion,
        status: missingStage
          ? 'uncovered'
          : operationVariants.every((variant) => variant.feasibility === 'conditional') || operation.inclusion === 'review-required'
            ? 'conditional'
            : 'covered',
        ...(family ? { familyId: family.id } : {}),
        witnessIds: operationWitnesses.map((witness) => witness.id).sort(),
        variantIds: operationVariants.map((variant) => variant.id).sort(),
        ...(missingStage ? { missingStage } : {}),
        ...(searchTruncationReasons.length ? { searchTruncationReasons } : {}),
      };
    });
  const searchDiagnostics: Diagnostic[] = (['max-path-depth', 'max-state-visits'] as const).flatMap((reason) => {
    const details = (witnesses.search?.truncation.details ?? []).filter((detail) => detail.reason === reason);
    if (!details.length) return [];
    const count = reason === 'max-path-depth'
      ? witnesses.search?.truncation.counts.maxPathDepth ?? 0
      : witnesses.search?.truncation.counts.maxStateVisits ?? 0;
    const setting = reason === 'max-path-depth' ? 'analysis.maxPathDepth' : 'analysis.maxStateVisits';
    const subject = reason === 'max-path-depth' ? 'queued state(s)' : 'candidate transition(s)';
    return [{
      code: reason === 'max-path-depth' ? 'PATH_SEARCH_MAX_DEPTH_TRUNCATED' : 'PATH_SEARCH_MAX_STATE_VISITS_TRUNCATED',
      severity: 'warning',
      message: `Path search pruned ${count} ${subject} at ${setting}; coverage is bound-limited and may omit happy-path variants. Inspect path-witnesses.json search.truncation.details before changing the bound.`,
      evidenceRefs: [...new Set(details.flatMap((detail) => [detail.familyId, detail.nodeId, ...(detail.edgeId ? [detail.edgeId] : [])]))].sort(),
      scope: setting,
    } satisfies Diagnostic];
  });
  const uncoveredDiagnostics: Diagnostic[] = operationCoverage.filter((row) => row.status === 'uncovered').map((row) => ({
    code: 'IN_SCOPE_OPERATION_UNCOVERED',
    severity: 'blocked',
    message: `In-scope operation ${row.operationId} has no complete source-supported happy-path witness; discovery stopped at ${row.missingStage}.${row.missingStage === 'entry-success-witness' && row.searchTruncationReasons?.length ? ` Its family search hit ${row.searchTruncationReasons.join(', ')}, so this absence is bound-limited rather than proof that the graph is disconnected.` : ''}`,
    evidenceRefs: [row.operationId],
    scope: row.operationId,
  }));
  return {
    scope: {
      sourceFiles: bundle.sourceFiles.length,
      sourceDigest: bundle.sourceDigest,
      maxPathDepth: config.analysis.maxPathDepth,
      maxStateVisits: config.analysis.maxStateVisits,
    },
    counts: {
      evidenceNodes: bundle.graphifyNodes.length + bundle.routes.length + bundle.pages.length + bundle.handlers.length + bundle.actions.length + bundle.fields.length + bundle.httpOperations.length + bundle.endpoints.length + bundle.validations.length + bundle.permissions.length + bundle.effects.length + requestContracts.length,
      sourceDeclaredActions: bundle.actions.length,
      handlerResolvedActions: bundle.actions.filter((action) => action.handlerId).length,
      terminalOperations: catalog.operations.filter((operation) => operation.inclusion !== 'excluded').length,
      unresolvedTerminalEffects: bundle.effects.filter((effect) => effect.kind === 'unknown-mutation').length,
      pageContracts: pages.pages.length,
      actorRequirements: actors.actors.length,
      behaviorNodes: graph.nodes.length,
      behaviorEdges: graph.edges.length,
      flowFamilies: families.families.length,
      pathWitnesses: witnesses.witnesses.length,
      ...(witnesses.search ? {
        pathSearchEnqueuedStates: witnesses.search.enqueuedStates,
        pathSearchDequeuedStates: witnesses.search.dequeuedStates,
        pathSearchDepthPrunes: witnesses.search.truncation.counts.maxPathDepth,
        pathSearchVisitPrunes: witnesses.search.truncation.counts.maxStateVisits,
      } : {}),
      variants: variants.variants.length,
      conditionalVariants: conditional,
      dataRequirements: dataRequirements.length,
      unresolvedDataRequirements: dataRequirements.filter((requirement) => requirement.status === 'unresolved').length,
      runtimeBindings: runtime.bindings.length,
      requestPayloadContracts: requestContracts.length,
      requestPayloadFieldsPresent: requestContracts.filter((contract) => contract.status === 'fields-present').length,
      requestPayloadReviewRequired: requestContracts.filter((contract) => contract.status === 'review-required').length,
      requestPayloadPathsBlocked: requestContracts.filter((contract) => (
        contract.status === 'required-fields-missing' || contract.status === 'required-fields-invalid'
      )).length,
      uncoveredOperations: operationCoverage.filter((row) => row.status === 'uncovered').length,
    },
    operationCoverage,
    ...(witnesses.search ? { search: witnesses.search } : {}),
    unresolved: [...bundle.diagnostics, ...(variants.rejectedCandidates ?? []), ...searchDiagnostics, ...uncoveredDiagnostics],
    claims: [
      'Distinct successful behavior signatures found within the configured source scope and search bounds are represented.',
      witnesses.search
        ? witnesses.search.truncation.occurred
          ? `Path search pruned ${witnesses.search.truncation.counts.maxPathDepth + witnesses.search.truncation.counts.maxStateVisits} state(s) or transition(s) at configured traversal bounds; flow coverage may be incomplete.`
          : 'Path search did not hit the configured depth or state-visit bounds.'
        : 'Path-search truncation telemetry is unavailable for this legacy witness artifact.',
      conditional ? `${conditional} variant(s) remain conditional because unsupported predicates or resolution gaps exist.` : 'All emitted variants are satisfiable under the supported constraint subset.',
      `${requestContracts.filter((contract) => contract.status === 'required-fields-missing' || contract.status === 'required-fields-invalid').length} action-to-operation path(s) were blocked because an exact request payload omitted or invalidated backend-required fields.`,
      `${requestContracts.filter((contract) => contract.status === 'review-required').length} request payload contract(s) remain conditional because shape or value provenance could not be proved.`,
      'Runtime confirmation is reported separately from source-derived flow discovery.',
      operationCoverage.some((row) => row.status === 'uncovered')
        ? `${operationCoverage.filter((row) => row.status === 'uncovered').length} in-scope operation(s) do not have a complete entry-to-success witness.`
        : 'Every in-scope terminal operation is represented by at least one source-supported entry-to-success witness.',
    ],
  };
}

function node(id: string, kind: EvidenceNode['kind'], canonicalKey: string, label: string, attributes: Record<string, unknown>, sourceRef: EvidenceNode['sourceRefs'][number]): EvidenceNode {
  return { id, kind, canonicalKey, label, attributes: clean(attributes), origin: 'source-extracted', confidence: 'exact', sourceRefs: [sourceRef] };
}

function evidenceEdge(
  nodes: EvidenceNode[],
  from: string,
  to: string,
  kind: EvidenceEdge['kind'],
  evidenceRefs: string[],
  guard?: Predicate,
): EvidenceEdge {
  const sourceRefs = evidenceRefs.flatMap((referenceId) => (
    nodes.find((candidate) => candidate.id === referenceId)?.sourceRefs ?? []
  ));
  return {
    id: stableId('evidence-edge', `${from}:${kind}:${to}`),
    from,
    to,
    kind,
    ...(guard ? { guard } : {}),
    origin: 'source-extracted',
    confidence: 'exact',
    sourceRefs: dedupe(sourceRefs, (value) => `${value.file}:${value.line}:${value.endLine ?? ''}:${value.symbol ?? ''}`),
  };
}

function behaviorEdge(
  from: string,
  to: string,
  guard: Predicate,
  effects: BehaviorEdge['effects'],
  outcome: BehaviorEdge['outcome'],
  evidenceRefs: string[],
  requestPayloadContracts?: BehaviorEdge['requestPayloadContracts'],
): BehaviorEdge {
  return {
    id: stableId('behavior-edge', `${from}:${to}:${predicateLabel(guard)}:${outcome}`),
    from,
    to,
    guard,
    effects,
    outcome,
    evidenceRefs,
    ...(requestPayloadContracts?.length ? { requestPayloadContracts } : {}),
  };
}

function payloadLiteralGuard(bindings: Record<string, string | number | boolean | null>): Predicate {
  return allPredicates(Object.entries(bindings).map(([fieldPath, value]) => ({
    kind: 'compare' as const,
    left: { kind: 'path' as const, path: fieldPath },
    operator: 'eq' as const,
    right: { kind: 'literal' as const, value },
  })));
}

function attachBackendConstraints(
  field: ReactFieldFact,
  _pageId: string,
  bundle: ExtractionBundle,
  catalog: OperationCatalog,
): ReactFieldFact {
  const contractsByOperation = new Map(catalog.operations.map((operation) => [operation.id, (bundle.requestContracts ?? []).filter((contract) => (
    contract.endpointId === operation.backendEndpointId
    && operation.frontendOperationIds.includes(contract.httpOperationId)
    && contract.status !== 'required-fields-missing'
    && contract.status !== 'required-fields-invalid'
  ))]));
  const constraintsForBinding = (operation: OperationCatalogEntry, contract: NonNullable<ExtractionBundle['requestContracts']>[number]) => {
    const requestFields = Object.entries(contract.uiFieldBindings)
      .filter(([, fieldId]) => fieldId === field.id)
      .map(([requestField]) => requestField.toLowerCase());
    if (!requestFields.length) return [];
    const endpoint = bundle.endpoints.find((candidate) => candidate.id === operation.backendEndpointId);
    return bundle.validations.filter((validation) => (
      endpoint?.validationIds.includes(validation.id)
      && requestFields.includes(validation.fieldPath.split('.').at(-1)?.toLowerCase() ?? '')
    ));
  };
  const backendConstraintsByRequestContractId = Object.fromEntries(catalog.operations.flatMap((operation) => (
    (contractsByOperation.get(operation.id) ?? []).flatMap((contract) => {
      const constraints = constraintsForBinding(operation, contract);
      return constraints.length ? [[contract.id, constraints] as const] : [];
    })
  )));
  const backendConstraintsByOperationId = Object.fromEntries(catalog.operations.flatMap((operation) => {
    const constraints = dedupe((contractsByOperation.get(operation.id) ?? [])
      .flatMap((contract) => constraintsForBinding(operation, contract)), constraintSemanticKey);
    return constraints.length ? [[operation.id, constraints] as const] : [];
  }));
  return {
    ...field,
    ...(Object.keys(backendConstraintsByOperationId).length ? { backendConstraintsByOperationId } : {}),
    ...(Object.keys(backendConstraintsByRequestContractId).length ? { backendConstraintsByRequestContractId } : {}),
  };
}

function resolveHandlerHttpIds(handler: ExtractionBundle['handlers'][number], handlers: ExtractionBundle['handlers'], http: ExtractionBundle['httpOperations']): Set<string> {
  const resolved = new Set(handler.httpOperationIds);
  const visited = new Set<string>();
  const queue = [handler.id];
  while (queue.length) {
    const handlerId = queue.shift()!;
    if (visited.has(handlerId)) continue;
    visited.add(handlerId);
    const candidate = handlers.find((value) => value.id === handlerId);
    if (!candidate) continue;
    candidate.httpOperationIds.forEach((id) => resolved.add(id));
    for (const called of resolvedHandlerTargets(candidate, handlers)) {
      if (!visited.has(called.id)) queue.push(called.id);
    }
  }
  return resolved;
}

function resolveHandlerNavigations(
  root: ExtractionBundle['handlers'][number],
  handlers: ExtractionBundle['handlers'],
  navigations: ExtractionBundle['navigations'],
): ExtractionBundle['navigations'] {
  const resolved: ExtractionBundle['navigations'] = [];
  const visit = (handler: ExtractionBundle['handlers'][number], guards: Predicate[], path: string[]): void => {
    if (path.includes(handler.id)) return;
    handler.navigationIds.forEach((navigationId) => {
      const navigation = navigations.find((candidate) => candidate.id === navigationId);
      if (navigation) resolved.push({ ...navigation, guard: allPredicates([...guards, navigation.guard]) });
    });
    if (!handler.callSites) {
      resolvedHandlerTargets(handler, handlers).forEach((target) => visit(target, guards, [...path, handler.id]));
      return;
    }
    for (const callSite of handler.callSites) {
      for (const target of handlerTargetsForCallSite(callSite, handler, handlers)) {
        visit(target, [...guards, callSite.guard ?? TRUE], [...path, handler.id]);
      }
    }
  };
  visit(root, [], []);
  return resolved;
}

function handlerTargetsForCallSite(
  callSite: NonNullable<ExtractionBundle['handlers'][number]['callSites']>[number],
  source: ExtractionBundle['handlers'][number],
  handlers: ExtractionBundle['handlers'],
): ExtractionBundle['handlers'] {
  if (callSite.targetFile && callSite.targetSymbol) {
    const qualified = handlers.filter((candidate) => candidate.file === callSite.targetFile && candidate.name === callSite.targetSymbol);
    return qualified.length === 1 ? qualified : [];
  }
  const sameFile = handlers.filter((candidate) => candidate.file === source.file && candidate.name === callSite.calleeSymbol);
  return sameFile.length === 1 ? sameFile : [];
}

function resolvedHandlerTargets(
  handler: ExtractionBundle['handlers'][number],
  handlers: ExtractionBundle['handlers'],
): ExtractionBundle['handlers'] {
  if (!handler.callSites) {
    return handler.calls
      .map((call) => call.split('.').at(-1))
      .filter((name): name is string => Boolean(name))
      .flatMap((name) => handlers.filter((candidate) => candidate.file === handler.file && candidate.name === name).slice(0, 1));
  }
  return dedupe(handler.callSites.flatMap((callSite) => {
    if (callSite.targetFile && callSite.targetSymbol) {
      const qualified = handlers.filter((candidate) => (
        candidate.file === callSite.targetFile
        && candidate.name === callSite.targetSymbol
      ));
      if (qualified.length === 1) return qualified;
      return [];
    }
    const sameFile = handlers.filter((candidate) => (
      candidate.file === handler.file
      && candidate.name === callSite.calleeSymbol
    ));
    return sameFile.length === 1 ? sameFile : [];
  }), (candidate) => candidate.id);
}

function targetPagesForNavigations(navigations: ExtractionBundle['navigations'], bundle: ExtractionBundle, pages: PageContracts): PageContract[] {
  return dedupe(navigations.flatMap((navigation) => {
    const route = bundle.routes.find((candidate) => routeMatches(navigation.target, candidate.path));
    if (!route) return [];
    return pages.pages.filter((page) => page.routePatterns.some((pattern) => routeMatches(navigation.target, pattern)));
  }), (page) => page.id);
}

function navigationProvesOperationSuccess(
  navigation: ExtractionBundle['navigations'][number],
  operation: OperationCatalogEntry,
  contracts: NonNullable<ExtractionBundle['requestContracts']>,
  bundle: ExtractionBundle,
): boolean {
  if (navigation.continuationStatus !== 'exact' || !navigation.successAfterCallSymbol || !navigation.successAfterCallFile) return false;
  return contracts.some((contract) => {
    if (contract.endpointId !== operation.backendEndpointId
      || !operation.frontendOperationIds.includes(contract.httpOperationId)) return false;
    return contract.handlerPath.some((handlerId) => (
      bundle.handlers.find((handler) => handler.id === handlerId)?.name === navigation.successAfterCallSymbol
      && bundle.handlers.find((handler) => handler.id === handlerId)?.file === navigation.successAfterCallFile
    ));
  });
}

function navigationGuard(navigation: ExtractionBundle['navigations'][number]): Predicate {
  return allPredicates([
    navigation.guard,
    ...(navigation.targetStatus === 'conditional' ? [{
      kind: 'opaque' as const,
      sourceExpression: navigation.targetExpression ?? `navigation-target:${navigation.id}`,
      reason: 'The navigation target is computed or relative and was not resolved to one exact route.',
    }] : []),
  ]);
}

function commandName(handler: string, entity: string): string {
  const verb = (handler.match(/^(create|submit|open|approve|reject|update|delete|cancel|place|send|activate|deactivate)/i)?.[1]?.toLowerCase()
    ?? handler.replace(new RegExp(entity, 'ig'), '').replace(/(?:handler|request)$/i, '').toLowerCase()).trim()
    || 'execute';
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
  if (isSensitiveControlKind(field.controlKind) || isSensitiveFieldPath(field.dataPath)) return 'secret-reference';
  const leaf = field.dataPath.split('.').at(-1) ?? field.dataPath;
  if (/(?:id|identifier|key|reference|ref)$/i.test(leaf)
    || /^(?:applicant|customer|account|entity)$/i.test(leaf)
    || /^(?:account|customer|application|applicant|tax|national|socialSecurity).*(?:number|no)$/i.test(leaf)
    || /^(?:ssn|pan|tin|iban)$/i.test(leaf)) return 'existing-entity';
  if (field.optionSource || /code$/i.test(field.dataPath) || /select|picker|combobox/i.test(field.controlKind)) return 'runtime-option';
  if (assigned) return 'flow-literal';
  return 'synthetic-constrained';
}

function staticOptionRepresentative(
  field: ReactFieldFact,
  constraints: ReactFieldFact['constraints'],
  assigned: string | number | boolean | null | undefined,
): string | number | boolean | null | undefined {
  if (field.optionSource?.status !== 'static' || !field.optionSource.options.length) return undefined;
  const candidates = assigned !== undefined
    ? [assigned]
    : [representativeValueForConstraints(constraints), ...field.optionSource.options.map((option) => option.value)];
  return candidates.find((candidate): candidate is string | number | boolean | null => (
    candidate !== undefined
    && field.optionSource!.options.some((option) => Object.is(option.value, candidate))
    && evaluateConstraintValue(constraints, candidate, 'ui-input').status === 'valid'
  ));
}

function assignmentForField(predicate: Predicate, fieldPath: string, valueBindingPath?: string): unknown {
  const solved = solvePredicate(predicate).assignments;
  if (valueBindingPath && Object.hasOwn(solved, valueBindingPath)) return solved[valueBindingPath];
  if (Object.hasOwn(solved, fieldPath)) return solved[fieldPath];
  const leaves = new Set([fieldPath, valueBindingPath].filter((value): value is string => Boolean(value)).map((value) => value.split('.').at(-1)));
  const matching = Object.keys(solved).filter((key) => leaves.has(key.split('.').at(-1)));
  return matching.length === 1 ? solved[matching[0]!] : undefined;
}

function strategiesForClassification(classification: DataRequirement['classification']): string[] {
  const strategies: Record<DataRequirement['classification'], string[]> = {
    'flow-literal': ['path-assignment'],
    'synthetic-constrained': ['constraint-generator'],
    'derived': ['execution-binding'],
    'runtime-option': ['runtime-option-provider'],
    'existing-entity': ['approved-fixture', 'read-only-lookup', 'test-builder', 'manual-binding'],
    'authenticated-identity': ['approved-identity-catalog', 'secret-reference', 'manual-binding'],
    'actor-attribute': ['approved-actor-fixture', 'approved-identity-catalog', 'manual-binding'],
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
