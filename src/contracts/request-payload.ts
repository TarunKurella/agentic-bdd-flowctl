import { stableId, stableJson } from '../core/stable.js';
import { evaluateConstraintValue } from './constraints.js';
import { allPredicates, TRUE } from '../ir/predicates.js';
import type {
  Diagnostic,
  ExtractionBundle,
  ReactCallSiteFact,
  ReactFieldFact,
  ReactHandlerFact,
  Predicate,
  RequestPayloadContractFact,
  RequestPayloadShape,
  SourceRef,
} from '../ir/model.js';

export interface RequestPayloadAnalysis {
  contracts: RequestPayloadContractFact[];
  diagnostics: Diagnostic[];
}

interface ResolvedRequest {
  httpOperationId: string;
  handlerPath: string[];
  payloadShape: RequestPayloadShape;
  dispatchGuard: Predicate;
}

type PayloadEnvironment = Map<string, RequestPayloadShape>;

/**
 * Proves only top-level request-field presence. Value validity remains the job of
 * field constraints and runtime data resolution. Exact omissions are blockers;
 * partial or dynamic shapes remain review-required.
 */
export function analyzeRequestPayloads(bundle: ExtractionBundle): RequestPayloadAnalysis {
  const contracts: RequestPayloadContractFact[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const action of bundle.actions) {
    const rootHandler = action.handlerId
      ? bundle.handlers.find((candidate) => candidate.id === action.handlerId)
      : undefined;
    if (!rootHandler) continue;
    const provenancePageIds = pageIdsThatCanReach(bundle, action.pageId);

    const requests = resolveRequests(rootHandler, bundle);
    for (const request of requests) {
      const http = bundle.httpOperations.find((candidate) => candidate.id === request.httpOperationId);
      if (!http) continue;
      for (const endpoint of bundle.endpoints.filter((candidate) => httpMatches(
        http.method,
        http.pathTemplate,
        candidate.method,
        candidate.pathTemplate,
      ))) {
        const requiredValidations = bundle.validations.filter((validation) => (
          endpoint.validationIds.includes(validation.id)
          && validation.kind === 'required'
          && validation.value !== false
        ));
        const requiredFields = unique(requiredValidations.map((validation) => leafName(validation.fieldPath))).sort();
        const providedFields = unique(request.payloadShape.fields.map((field) => field.name)).sort();
        const literalBindings = Object.fromEntries(request.payloadShape.fields.flatMap((field) => (
          field.value?.kind === 'literal' ? [[field.name, field.value.value] as const] : []
        )));
        const missingRequiredFields = requiredFields.filter((field) => !providedFields.includes(field));
        const validatedProvidedFields = unique(bundle.validations.filter((validation) => (
          endpoint.validationIds.includes(validation.id) && providedFields.includes(leafName(validation.fieldPath))
        )).map((validation) => leafName(validation.fieldPath))).sort();
        const valueProofs = validatedProvidedFields
          .map((field) => proveRequiredValue(
            field,
            request.payloadShape,
            bundle,
            bundle.validations.filter((validation) => (
              endpoint.validationIds.includes(validation.id) && leafName(validation.fieldPath) === field
            )),
            provenancePageIds,
          ));
        const unprovenFieldValues = valueProofs.filter((proof) => proof.status === 'unproven').map((proof) => proof.field);
        const invalidFieldValues = valueProofs.filter((proof) => proof.status === 'invalid').map((proof) => proof.field);
        const uiFieldBindings = Object.fromEntries(valueProofs.flatMap((proof) => (
          proof.status === 'proven' && proof.uiFieldId ? [[proof.field, proof.uiFieldId] as const] : []
        )));
        const status: RequestPayloadContractFact['status'] = missingRequiredFields.length
          ? (request.payloadShape.certainty === 'exact' ? 'required-fields-missing' : 'review-required')
          : invalidFieldValues.length
            ? 'required-fields-invalid'
            : unprovenFieldValues.length
              ? 'review-required'
              : 'fields-present';
        const validationIds = unique(bundle.validations.filter((validation) => (
          endpoint.validationIds.includes(validation.id)
          && (requiredFields.includes(leafName(validation.fieldPath)) || providedFields.includes(leafName(validation.fieldPath)))
        )).map((validation) => validation.id)).sort();
        const id = stableId('request-payload', stableJson({
          actionId: action.id,
          handlerPath: request.handlerPath,
          httpOperationId: http.id,
          endpointId: endpoint.id,
          certainty: request.payloadShape.certainty,
          dispatchGuard: request.dispatchGuard,
          providedFields,
          literalBindings,
          uiFieldBindings,
          requiredFields,
          unprovenFieldValues,
          invalidFieldValues,
        }));
        const evidenceRefs = unique([
          action.id,
          ...request.handlerPath,
          http.id,
          endpoint.id,
          ...validationIds,
          ...Object.values(uiFieldBindings),
        ]);
        const sourceRefs = dedupeSourceRefs([
          action.sourceRef,
          ...request.handlerPath.flatMap((handlerId) => bundle.handlers.find((handler) => handler.id === handlerId)?.sourceRef ?? []),
          ...request.payloadShape.sourceRefs,
          http.sourceRef,
          endpoint.sourceRef,
          ...requiredValidations.map((validation) => validation.sourceRef),
          ...valueProofs.flatMap((proof) => proof.sourceRefs),
        ]);
        const contract: RequestPayloadContractFact = {
          id,
          actionId: action.id,
          handlerId: rootHandler.id,
          handlerPath: request.handlerPath,
          httpOperationId: http.id,
          endpointId: endpoint.id,
          payloadShape: request.payloadShape,
          dispatchGuard: request.dispatchGuard,
          requiredFields,
          providedFields,
          literalBindings,
          uiFieldBindings,
          missingRequiredFields,
          unprovenFieldValues,
          invalidFieldValues,
          validationIds,
          status,
          evidenceRefs,
          sourceRefs,
        };
        contracts.push(contract);

        if (status === 'required-fields-missing') {
          diagnostics.push({
            code: 'REQUEST_PAYLOAD_REQUIRED_FIELDS_MISSING',
            severity: 'blocked',
            message: `Action ${action.accessibleName ?? action.id} sends an exact ${http.method} ${http.pathTemplate} payload that omits backend-required field(s): ${missingRequiredFields.join(', ')}. Its success edge is blocked.`,
            evidenceRefs: [id, ...validationIds],
            scope: action.id,
          });
        } else if (status === 'required-fields-invalid') {
          diagnostics.push({
            code: 'REQUEST_PAYLOAD_REQUIRED_FIELDS_INVALID',
            severity: 'blocked',
            message: `Action ${action.accessibleName ?? action.id} sends source-literal values that violate backend validation for field(s): ${invalidFieldValues.join(', ')}. Its success edge is blocked.`,
            evidenceRefs: [id, ...validationIds],
            scope: action.id,
          });
        } else if (status === 'review-required') {
          diagnostics.push({
            code: 'REQUEST_PAYLOAD_SHAPE_UNRESOLVED',
            severity: 'warning',
            message: `Action ${action.accessibleName ?? action.id} reaches ${http.method} ${http.pathTemplate}, but source dataflow does not prove backend-validated field value(s): ${[...missingRequiredFields, ...unprovenFieldValues].join(', ')}. The path remains conditional and requires review.`,
            evidenceRefs: [id, ...validationIds],
            scope: action.id,
          });
        }
      }
    }
  }

  return {
    contracts: dedupeContracts(contracts),
    diagnostics: dedupeDiagnostics(diagnostics),
  };
}

function proveRequiredValue(
  fieldName: string,
  shape: RequestPayloadShape,
  bundle: ExtractionBundle,
  validations: ExtractionBundle['validations'],
  provenancePageIds: Set<string>,
): { field: string; status: 'proven' | 'unproven' | 'invalid'; uiFieldId?: string; sourceRefs: SourceRef[] } {
  const field = shape.fields.find((candidate) => candidate.name === fieldName);
  if (!field?.value) return { field: fieldName, status: 'unproven', sourceRefs: field ? [field.sourceRef] : [] };
  if (field.value.kind === 'literal') {
    const value = field.value.value;
    const validity = literalValidity(value, validations);
    return { field: fieldName, status: validity, sourceRefs: [field.sourceRef, ...validations.map((validation) => validation.sourceRef)] };
  }
  if (field.value.kind !== 'path') return { field: fieldName, status: 'unproven', sourceRefs: [field.sourceRef] };
  if (!field.valueSourceIdentity) return { field: fieldName, status: 'unproven', sourceRefs: [field.sourceRef] };
  const matchingFields = bundle.fields.filter((candidate) => (
    provenancePageIds.has(candidate.pageId)
    &&
    leafName(candidate.dataPath).toLowerCase() === fieldName.toLowerCase()
    && candidate.valueBinding?.writable === true
    && candidate.valueBinding.sourceIdentity === field.valueSourceIdentity
  ));
  if (matchingFields.length !== 1) {
    return { field: fieldName, status: 'unproven', sourceRefs: [field.sourceRef, ...matchingFields.map((candidate) => candidate.sourceRef)] };
  }
  const sourceField = matchingFields[0]!;
  const compatibility = sourceValueTypeCompatibility(sourceField.valueBinding?.valueType, validations);
  return {
    field: fieldName,
    status: compatibility,
    ...(compatibility === 'proven' ? { uiFieldId: sourceField.id } : {}),
    sourceRefs: [field.sourceRef, sourceField.sourceRef, sourceField.valueBinding!.sourceRef, ...validations.map((validation) => validation.sourceRef)],
  };
}

function pageIdsThatCanReach(bundle: ExtractionBundle, targetPageId: string): Set<string> {
  const reverse = new Map<string, Set<string>>();
  for (const navigation of bundle.navigations) {
    if (!navigation.fromPageId || navigation.targetStatus === 'conditional') continue;
    const targetPages = bundle.pages.filter((page) => page.routeIds.some((routeId) => {
      const route = bundle.routes.find((candidate) => candidate.id === routeId);
      return route ? routeMatches(navigation.target, route.path) : false;
    }));
    for (const target of targetPages) {
      reverse.set(target.id, new Set([...(reverse.get(target.id) ?? []), navigation.fromPageId]));
    }
  }
  const reachable = new Set([targetPageId]);
  const queue = [targetPageId];
  while (queue.length) {
    const pageId = queue.shift()!;
    for (const predecessor of reverse.get(pageId) ?? []) {
      if (reachable.has(predecessor)) continue;
      reachable.add(predecessor);
      queue.push(predecessor);
    }
  }
  return reachable;
}

function routeMatches(actual: string, pattern: string): boolean {
  const normalizedActual = normalizeRoute(actual);
  const normalizedPattern = normalizeRoute(pattern);
  if (normalizedActual === normalizedPattern) return true;
  const regex = new RegExp(`^${escapeRegex(normalizedPattern).replace(/\\\{param\\\}/g, '[^/]+')}$`);
  return regex.test(normalizedActual);
}

function normalizeRoute(value: string): string {
  return value
    .split(/[?#]/, 1)[0]!
    .replace(/:[A-Za-z_$][\w$]*/g, '{param}')
    .replace(/\{[^}]+\}/g, '{param}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceValueTypeCompatibility(
  actual: NonNullable<ReactFieldFact['valueBinding']>['valueType'] | undefined,
  validations: ExtractionBundle['validations'],
): 'proven' | 'unproven' {
  if (validations.some((validation) => validation.kind === 'opaque')) return 'unproven';
  const expected = validations
    .filter((validation) => validation.kind === 'type' && typeof validation.value === 'string')
    .map((validation) => String(validation.value));
  if (!expected.length) return 'proven';
  if (!actual || actual === 'unknown') return 'unproven';
  return expected.every((type) => (
    type === actual
    || (type === 'number' && actual === 'integer')
  )) ? 'proven' : 'unproven';
}

function literalValidity(
  value: string | number | boolean | null,
  validations: ExtractionBundle['validations'],
): 'proven' | 'unproven' | 'invalid' {
  if (value === null && !validations.some((validation) => validation.kind === 'required' && validation.value !== false)) return 'proven';
  const result = evaluateConstraintValue(validations, value, 'json-literal');
  return result.status === 'valid' ? 'proven' : result.status === 'invalid' ? 'invalid' : 'unproven';
}

function resolveRequests(root: ReactHandlerFact, bundle: ExtractionBundle): ResolvedRequest[] {
  const results: ResolvedRequest[] = [];

  const visit = (
    handler: ReactHandlerFact,
    environment: PayloadEnvironment,
    handlerPath: string[],
    ambiguousCallChain = false,
    dispatchGuards: Predicate[] = [],
  ): void => {
    if (handlerPath.slice(0, -1).includes(handler.id)) return;

    for (const httpOperationId of handler.httpOperationIds) {
      const operation = bundle.httpOperations.find((candidate) => candidate.id === httpOperationId);
      if (!operation) continue;
      const resolvedShape = resolvePayloadShape(operation.payloadShape ?? unknownShape(operation.sourceRef), environment);
      results.push({
        httpOperationId,
        handlerPath,
        payloadShape: ambiguousCallChain ? ambiguousShape(resolvedShape) : resolvedShape,
        dispatchGuard: allPredicates([
          ...dispatchGuards,
          operation.guard ?? TRUE,
          ...(handler.normalCompletion === 'conditional' ? [{
            kind: 'opaque' as const,
            sourceExpression: `normal-completion:${handler.id}`,
            reason: handler.normalCompletionReason ?? 'Handler normal completion is not proved.',
          }] : []),
        ]),
      });
    }

    for (const callSite of handler.callSites ?? []) {
      const { targets, ambiguous } = resolveCallTargets(callSite, bundle.handlers);
      for (const target of targets) {
        if (handlerPath.includes(target.id)) continue;
        const targetEnvironment: PayloadEnvironment = new Map();
        for (const [index, parameterName] of (target.parameterNames ?? []).entries()) {
          const argumentShape = callSite.argumentPayloads[index];
          if (argumentShape) targetEnvironment.set(parameterName, resolvePayloadShape(argumentShape, environment));
        }
        visit(
          target,
          targetEnvironment,
          [...handlerPath, target.id],
          ambiguousCallChain || ambiguous,
          [...dispatchGuards, callSite.guard ?? TRUE],
        );
      }
    }
  };

  visit(root, new Map(), [root.id]);
  return dedupeResolvedRequests(results);
}

function resolveCallTargets(
  callSite: ReactCallSiteFact,
  handlers: ReactHandlerFact[],
): { targets: ReactHandlerFact[]; ambiguous: boolean } {
  if (callSite.targetFile && callSite.targetSymbol) {
    const qualified = handlers.filter((candidate) => (
      candidate.file === callSite.targetFile
      && candidate.name === callSite.targetSymbol
    ));
    if (qualified.length === 1) return { targets: qualified, ambiguous: false };
    if (qualified.length > 1) return { targets: qualified, ambiguous: true };
  }

  const sameFile = handlers.filter((candidate) => (
    candidate.file === callSite.sourceRef.file
    && candidate.name === callSite.calleeSymbol
  ));
  if (sameFile.length === 1) return { targets: sameFile, ambiguous: false };

  const byName = handlers.filter((candidate) => candidate.name === callSite.calleeSymbol);
  return { targets: byName, ambiguous: true };
}

function ambiguousShape(shape: RequestPayloadShape): RequestPayloadShape {
  return {
    certainty: 'unknown',
    fields: [],
    ...(shape.expression !== undefined ? { expression: shape.expression } : {}),
    reason: 'The call target is ambiguous across same-named handlers, so this payload cannot be attached to one request as an exact proof.',
    sourceRefs: shape.sourceRefs,
  };
}

function resolvePayloadShape(shape: RequestPayloadShape, environment: PayloadEnvironment): RequestPayloadShape {
  if (!shape.referenceName) return shape;
  const resolved = environment.get(shape.referenceName);
  if (!resolved) return shape;
  return {
    ...resolved,
    sourceRefs: dedupeSourceRefs([...shape.sourceRefs, ...resolved.sourceRefs]),
  };
}

function unknownShape(sourceRef: SourceRef): RequestPayloadShape {
  return {
    certainty: 'unknown',
    fields: [],
    reason: 'The HTTP adapter did not expose a request payload expression.',
    sourceRefs: [sourceRef],
  };
}

function httpMatches(leftMethod: string, leftPath: string, rightMethod: string, rightPath: string): boolean {
  return leftMethod.toUpperCase() === rightMethod.toUpperCase()
    && normalizeTemplate(leftPath) === normalizeTemplate(rightPath);
}

function normalizeTemplate(value: string): string {
  return value
    .replace(/:[A-Za-z_$][\w$]*/g, '{param}')
    .replace(/\{[^}]+\}/g, '{param}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function leafName(fieldPath: string): string {
  return fieldPath.split('.').at(-1) ?? fieldPath;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function dedupeSourceRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.file}:${ref.line}:${ref.endLine ?? ''}:${ref.symbol ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeContracts(contracts: RequestPayloadContractFact[]): RequestPayloadContractFact[] {
  return [...new Map(contracts.map((contract) => [contract.id, contract])).values()];
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...new Map(diagnostics.map((diagnostic) => [
    `${diagnostic.code}:${diagnostic.scope ?? ''}:${diagnostic.message}`,
    diagnostic,
  ])).values()];
}

function dedupeResolvedRequests(requests: ResolvedRequest[]): ResolvedRequest[] {
  return [...new Map(requests.map((request) => [stableJson({
    httpOperationId: request.httpOperationId,
    handlerPath: request.handlerPath,
    certainty: request.payloadShape.certainty,
    fields: request.payloadShape.fields.map((field) => field.name).sort(),
    fieldValues: request.payloadShape.fields.map((field) => ({
      name: field.name,
      value: field.value,
      valueSourceIdentity: field.valueSourceIdentity,
    })),
    referenceName: request.payloadShape.referenceName,
    dispatchGuard: request.dispatchGuard,
  }), request])).values()];
}
