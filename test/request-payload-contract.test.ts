import { describe, expect, it } from 'vitest';
import { extractJava } from '../src/adapters/java.js';
import { extractReact } from '../src/adapters/react.js';
import type { SourceFile } from '../src/adapters/source.js';
import { analyzeRequestPayloads } from '../src/contracts/request-payload.js';
import type { FlowctlConfig } from '../src/core/config.js';
import type { BehaviorGraph, ExtractionBundle, FlowFamilies, FlowVariants, PageContracts, PathWitnesses } from '../src/ir/model.js';
import { solvePredicate } from '../src/ir/predicates.js';
import {
  buildActorRequirements,
  buildBehaviorGraph,
  buildCoverage,
  buildDataRequirements,
  buildFlowFamilies,
  buildOperationCatalog,
  buildPageContracts,
  reduceVariants,
  searchPaths,
} from '../src/pipeline/builders.js';

describe('request payload contracts', () => {
  it('negates ternary and else-branch guards while retaining outer conditions', () => {
    const react = extractReact([tsFile('frontend/src/pages/ConditionalPage.tsx', `
      export function ConditionalPage() {
        if (outerEnabled) {
          return innerEnabled
            ? <button onClick={submitPositive}>Positive</button>
            : <button onClick={submitNegative}>Negative</button>;
        }
        return <button onClick={submitFallback}>Fallback</button>;
      }
    `)]);
    const positive = react.actions.find((action) => action.accessibleName === 'Positive')!;
    const negative = react.actions.find((action) => action.accessibleName === 'Negative')!;

    expect(solvePredicate(positive.visibleWhen[0]!)).toMatchObject({
      assignments: { outerEnabled: true, innerEnabled: true },
    });
    expect(solvePredicate(negative.visibleWhen[0]!)).toMatchObject({
      assignments: { outerEnabled: true, innerEnabled: false },
    });
  });

  it('extracts explicit top-level fields from direct fetch and axios requests', () => {
    const react = extractReact([tsFile('frontend/src/services/direct.ts', `
      export async function sendWithFetch(primaryApplicantId: string, productCode: string) {
        return fetch('/api/fetch-applications', {
          method: 'POST',
          body: JSON.stringify({ primaryApplicantId, productCode }),
        });
      }
      export async function sendWithAxios(primaryApplicantId: string, productCode: string) {
        return client.post('/api/axios-applications', { primaryApplicantId, productCode });
      }
    `)]);

    expect(react.httpOperations).toHaveLength(2);
    expect(react.httpOperations.map((operation) => ({
      path: operation.pathTemplate,
      certainty: operation.payloadShape?.certainty,
      fields: operation.payloadShape?.fields.map((field) => field.name).sort(),
    }))).toEqual([
      { path: '/api/fetch-applications', certainty: 'exact', fields: ['primaryApplicantId', 'productCode'] },
      { path: '/api/axios-applications', certainty: 'exact', fields: ['primaryApplicantId', 'productCode'] },
    ]);
  });

  it('retains branch guards on direct HTTP operations', () => {
    const react = extractReact([tsFile('frontend/src/services/branch.ts', `
      export async function send(applicationType: string) {
        if (applicationType === 'JOINT') {
          return fetch('/api/joint', { method: 'POST', body: JSON.stringify({ applicationType }) });
        } else {
          return fetch('/api/personal', { method: 'POST', body: JSON.stringify({ applicationType }) });
        }
      }
    `)]);

    expect(react.httpOperations.map((operation) => operation.guard?.kind)).toEqual(['compare', 'not']);
  });

  it('blocks a wrapper-backed success path when its exact payload omits backend-required fields', () => {
    const result = compilePayloadScenario(`{ applicationType: 'JOINT' }`);

    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]).toMatchObject({
      status: 'required-fields-missing',
      providedFields: ['applicationType'],
      missingRequiredFields: ['primaryApplicantId', 'productCode'],
      payloadShape: { certainty: 'exact' },
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'REQUEST_PAYLOAD_REQUIRED_FIELDS_MISSING',
        severity: 'blocked',
      }),
    ]));
    expect(result.operation.inclusion).toBe('review-required');
    expect(result.behavior.edges.some((edge) => edge.from === result.actionId && edge.to === result.operationNodeId)).toBe(false);
    expect(result.variants).toHaveLength(0);
    expect(result.coverage.counts.requestPayloadPathsBlocked).toBe(1);
    expect(result.coverage.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REQUEST_PAYLOAD_REQUIRED_FIELDS_MISSING' }),
    ]));
  });

  it('keeps a valid wrapper-backed happy path when all required field names are present', () => {
    const result = compilePayloadScenario(`{
      applicationType: 'JOINT',
      primaryApplicantId: selectedPrimaryApplicantId,
      productCode: selectedProductCode,
    }`);

    expect(result.contracts[0]).toMatchObject({
      status: 'fields-present',
      providedFields: ['applicationType', 'primaryApplicantId', 'productCode'],
      missingRequiredFields: [],
    });
    expect(result.operation.inclusion).toBe('included');
    expect(result.behavior.edges.some((edge) => edge.from === result.actionId && edge.to === result.operationNodeId)).toBe(true);
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.feasibility).toBe('satisfiable');
  });

  it('merges backend validation only from the action-proven request DTO', () => {
    const result = compilePayloadScenario(`{
      applicationType: 'JOINT',
      primaryApplicantId: selectedPrimaryApplicantId,
      productCode: selectedProductCode,
    }`);
    const productCode = result.pages.pages.flatMap((page) => page.fields).find((field) => field.dataPath === 'productCode')!;

    expect(productCode.backendConstraintsByOperationId?.[result.operation.id]).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'max', value: 12, fieldPath: 'ApplicationRequest.productCode' }),
    ]));
    expect(productCode.backendConstraintsByOperationId?.[result.operation.id]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 99, fieldPath: 'OtherRequest.productCode' }),
    ]));
  });

  it('propagates DTO constraints to an earlier wizard field only through exact source-value provenance', () => {
    const shared = compileWizardFieldScenario(true);
    const contract = shared.contracts[0]!;
    const detailsField = shared.pages.pages.find((page) => page.name === 'DetailsPage')!.fields[0]!;
    const submitAction = shared.bundle.actions.find((action) => action.accessibleName === 'Submit product')!;

    expect(contract).toMatchObject({
      status: 'fields-present',
      uiFieldBindings: { productCode: detailsField.id },
    });
    expect(submitAction.pageId).not.toBe(detailsField.pageId);
    expect(detailsField.backendConstraintsByRequestContractId?.[contract.id]).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'max', domain: 'length', value: 8, fieldPath: 'ProductRequest.productCode' }),
    ]));
    const reviewPage = shared.pages.pages.find((page) => page.name === 'ReviewPage')!;
    const operation = shared.catalog.operations[0]!;
    const operationNodeId = 'operation.wizard-submit';
    const successNodeId = 'outcome.wizard-success';
    const graph: BehaviorGraph = {
      nodes: [
        { id: detailsField.pageId, kind: 'screen-state', label: 'Details', attributes: {} },
        { id: reviewPage.id, kind: 'screen-state', label: 'Review', attributes: {} },
        { id: submitAction.id, kind: 'action', label: 'Submit product', attributes: {} },
        { id: operationNodeId, kind: 'operation', label: 'Submit product', referenceId: operation.id, attributes: {} },
        { id: successNodeId, kind: 'outcome', label: 'Product submitted', attributes: {} },
      ],
      edges: [
        behaviorEdge('wizard.1', detailsField.pageId, reviewPage.id),
        behaviorEdge('wizard.2', reviewPage.id, submitAction.id),
        behaviorEdge('wizard.3', submitAction.id, operationNodeId, [{
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
        }]),
        behaviorEdge('wizard.4', operationNodeId, successNodeId),
      ],
      entryNodeIds: [detailsField.pageId],
      successNodeIds: [successNodeId],
    };
    const witness: PathWitnesses['witnesses'][number] = {
      id: 'witness.wizard', familyId: 'product.submit',
      nodePath: [detailsField.pageId, reviewPage.id, submitAction.id, operationNodeId, successNodeId],
      edgePath: ['wizard.1', 'wizard.2', 'wizard.3', 'wizard.4'],
      pageSequence: [detailsField.pageId, reviewPage.id], actionSequence: [submitAction.id],
      pathCondition: { kind: 'constant', value: true }, assignments: {}, feasibility: 'satisfiable', evidenceRefs: [],
    };
    const variants: FlowVariants = { variants: [{
      id: 'product.submit.shared-draft', familyId: witness.familyId, label: 'Submit product', witnessIds: [witness.id],
      behaviorSignature: 'shared-draft', actorRequirementIds: [], pathCondition: witness.pathCondition,
      pageSequence: witness.pageSequence, actionSequence: witness.actionSequence, operationIds: [operation.id],
      dataRequirementIds: [], feasibility: 'satisfiable', evidenceRefs: [],
    }] };
    const requirements = buildDataRequirements(variants, shared.pages, { actors: [] }, {
      witnesses: { witnesses: [witness] },
      behavior: graph,
    });
    expect(requirements.find((requirement) => requirement.fieldId === detailsField.id)?.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'max', domain: 'length', value: 8 }),
    ]));

    const unrelated = compileWizardFieldScenario(false);
    const unrelatedContract = unrelated.contracts[0]!;
    const unrelatedDetailsField = unrelated.pages.pages.find((page) => page.name === 'DetailsPage')!.fields[0]!;
    expect(unrelatedContract).toMatchObject({ status: 'review-required', uiFieldBindings: {}, unprovenFieldValues: ['productCode'] });
    expect(unrelatedDetailsField.backendConstraintsByRequestContractId).toBeUndefined();

    const unreachable = compileWizardFieldScenario(true, false);
    expect(unreachable.contracts[0]).toMatchObject({
      status: 'review-required',
      uiFieldBindings: {},
      unprovenFieldValues: ['productCode'],
    });
  });

  it('uses import-qualified wrapper identity instead of an unrelated same-named handler', () => {
    const result = compilePayloadScenario(
      `{ applicationType: 'JOINT', primaryApplicantId: selectedPrimaryApplicantId, productCode: selectedProductCode }`,
      `payload`,
      [tsFile('frontend/src/services/unrelated.ts', `
        export async function createApplication(payload: unknown) {
          return fetch('/api/applications', {
            method: 'POST',
            body: JSON.stringify({ applicationType: 'JOINT' }),
          });
        }
      `)],
    );

    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]?.status).toBe('fields-present');
    expect(result.contracts[0]?.handlerPath.some((handlerId) => handlerId.includes('unrelated'))).toBe(false);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('preserves positive and negated handler dispatch guards on separate operation edges', () => {
    const validJoint = `{ applicationType: 'JOINT', primaryApplicantId: selectedPrimaryApplicantId, productCode: selectedProductCode }`;
    const validPersonal = `{ applicationType: 'PERSONAL', primaryApplicantId: selectedPrimaryApplicantId, productCode: selectedProductCode }`;
    const result = compilePayloadScenario(validJoint, 'payload', [], 'Application application = new Application(); return applicationRepository.save(application);', `
      if (applicationType === 'JOINT') {
        await createApplication(${validJoint});
      } else {
        await createApplication(${validPersonal});
      }
    `);
    const operationEdges = result.behavior.edges.filter((edge) => edge.from === result.actionId && edge.to === result.operationNodeId);

    expect(result.contracts).toHaveLength(2);
    expect(operationEdges).toHaveLength(2);
    expect(operationEdges.map((edge) => solvePredicate(edge.guard).assignments.applicationType).sort()).toEqual(['JOINT', 'PERSONAL']);
    expect(operationEdges.some((edge) => edge.guard.kind === 'constant' && edge.guard.value)).toBe(false);
  });

  it('discards a UI dispatch branch that contradicts a provable payload literal', () => {
    const jointPayload = `{ applicationType: 'JOINT', primaryApplicantId: selectedPrimaryApplicantId, productCode: selectedProductCode }`;
    const result = compilePayloadScenario(jointPayload, 'payload', [], 'Application application = new Application(); return applicationRepository.save(application);', `
      if (applicationType === 'JOINT') {
        await createApplication(${jointPayload});
      } else {
        await createApplication(${jointPayload});
      }
    `);

    expect(result.contracts).toHaveLength(2);
    expect(result.contracts.every((contract) => contract.literalBindings.applicationType === 'JOINT')).toBe(true);
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.pathCondition).toMatchObject({ kind: 'all' });
    expect(solvePredicate(result.variants[0]!.pathCondition).assignments.applicationType).toBe('JOINT');
  });

  it('preserves a dynamic request shape as a conditional, review-required path', () => {
    const result = compilePayloadScenario('buildApplicationPayload()');

    expect(result.contracts[0]).toMatchObject({
      status: 'review-required',
      payloadShape: { certainty: 'unknown' },
      missingRequiredFields: ['applicationType', 'primaryApplicantId', 'productCode'],
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REQUEST_PAYLOAD_SHAPE_UNRESOLVED', severity: 'warning' }),
    ]));
    expect(result.behavior.edges.find((edge) => edge.from === result.actionId && edge.to === result.operationNodeId)?.guard.kind).toBe('opaque');
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.feasibility).toBe('conditional');
  });

  it('keeps an unresolved backend mutation conditional instead of treating it as exact success', () => {
    const result = compilePayloadScenario(
      `{ applicationType: 'JOINT', primaryApplicantId: selectedPrimaryApplicantId, productCode: selectedProductCode }`,
      'payload',
      [],
      'return applicationService.submit(request);',
    );

    expect(result.operation.inclusion).toBe('review-required');
    const successEdge = result.behavior.edges.find((edge) => edge.from === result.operationNodeId && edge.outcome === 'success');
    expect(successEdge?.guard.kind).toBe('opaque');
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.feasibility).toBe('conditional');
    expect(result.coverage.counts.unresolvedTerminalEffects).toBe(1);
    expect(result.coverage.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TERMINAL_EFFECT_UNRESOLVED' }),
    ]));
  });

  it('keeps payload-shape variants distinct and suffixes otherwise-colliding IDs deterministically', () => {
    const contract = (id: string, providedFields: string[]) => ({
      id,
      status: 'fields-present' as const,
      certainty: 'exact' as const,
      dispatchGuard: { kind: 'constant' as const, value: true },
      providedFields,
      literalBindings: {},
      requiredFields: ['applicationType'],
      missingRequiredFields: [],
    });
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'page.review', kind: 'screen-state', label: 'Review', attributes: {} },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', referenceId: 'operation.submit', attributes: {} },
        { id: 'page.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [
        behaviorEdge('edge.entry', 'page.review', 'action.submit'),
        behaviorEdge('edge.payload-a', 'action.submit', 'operation.submit', [contract('payload.a', ['applicationType'])]),
        behaviorEdge('edge.payload-b', 'action.submit', 'operation.submit', [contract('payload.b', ['applicationType', 'productCode'])]),
        behaviorEdge('edge.success', 'operation.submit', 'page.success'),
      ],
      entryNodeIds: ['page.review'],
      successNodeIds: ['page.success'],
    };
    const families: FlowFamilies = { families: [{
      id: 'application.submit',
      label: 'Submit application',
      operationIds: ['operation.submit'],
      entryNodeIds: ['page.review'],
      successNodeIds: ['page.success'],
      actorRequirementIds: [],
      evidenceRefs: [],
    }] };
    const witness = (id: string, payloadEdge: string): PathWitnesses['witnesses'][number] => ({
      id,
      familyId: 'application.submit',
      nodePath: ['page.review', 'action.submit', 'operation.submit', 'page.success'],
      edgePath: ['edge.entry', payloadEdge, 'edge.success'],
      pageSequence: ['page.review', 'page.success'],
      actionSequence: ['action.submit'],
      pathCondition: { kind: 'compare', left: { kind: 'path', path: 'applicationType' }, operator: 'eq', right: { kind: 'literal', value: 'JOINT' } },
      assignments: { applicationType: 'JOINT' },
      feasibility: 'satisfiable',
      evidenceRefs: [],
    });
    const witnesses: PathWitnesses = { witnesses: [witness('witness.a', 'edge.payload-a'), witness('witness.b', 'edge.payload-b')] };
    const pages: PageContracts = { pages: [
      { id: 'page.review', name: 'Review', routePatterns: ['/review'], fields: [], actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [] },
      { id: 'page.success', name: 'Success', routePatterns: ['/success'], fields: [], actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [] },
    ] };

    const variants = reduceVariants(witnesses, families, graph, pages).variants;

    expect(variants).toHaveLength(2);
    expect(new Set(variants.map((variant) => variant.behaviorSignature)).size).toBe(2);
    expect(new Set(variants.map((variant) => variant.id)).size).toBe(2);
    expect(variants.every((variant) => /^application\.submit\.joint\.application-type-[a-f0-9]{8}$/.test(variant.id))).toBe(true);
  });

  it('does not let an unrelated request literal discharge an entity predicate with the same leaf name', () => {
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'page.review', kind: 'screen-state', label: 'Review', attributes: { fieldIds: ['field.account-id'] } },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', referenceId: 'operation.submit', attributes: {} },
        { id: 'page.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [
        behaviorEdge('edge.entry', 'page.review', 'action.submit'),
        behaviorEdge('edge.request', 'action.submit', 'operation.submit', [{
          id: 'request.literal-status',
          status: 'fields-present',
          certainty: 'exact',
          dispatchGuard: { kind: 'constant', value: true },
          providedFields: ['status'],
          literalBindings: { status: 'ACTIVE' },
          uiFieldBindings: {},
          requiredFields: ['status'],
          missingRequiredFields: [],
        }]),
        behaviorEdge('edge.success', 'operation.submit', 'page.success'),
      ],
      entryNodeIds: ['page.review'],
      successNodeIds: ['page.success'],
    };
    const families: FlowFamilies = { families: [{
      id: 'application.submit', label: 'Submit application', operationIds: ['operation.submit'],
      entryNodeIds: ['page.review'], successNodeIds: ['page.success'], actorRequirementIds: [], evidenceRefs: [],
    }] };
    const pathCondition = {
      kind: 'compare' as const,
      left: { kind: 'path' as const, path: 'selectedAccount.status' },
      operator: 'eq' as const,
      right: { kind: 'literal' as const, value: 'ACTIVE' },
    };
    const witnesses: PathWitnesses = { witnesses: [{
      id: 'witness.active-account', familyId: 'application.submit',
      nodePath: ['page.review', 'action.submit', 'operation.submit', 'page.success'],
      edgePath: ['edge.entry', 'edge.request', 'edge.success'],
      pageSequence: ['page.review', 'page.success'], actionSequence: ['action.submit'],
      pathCondition, assignments: { 'selectedAccount.status': 'ACTIVE' }, feasibility: 'satisfiable', evidenceRefs: [],
    }] };
    const pages: PageContracts = { pages: [{
      id: 'page.review', name: 'Review', routePatterns: ['/review'],
      fields: [{
        id: 'field.account-id', pageId: 'page.review', dataPath: 'accountId', label: 'Account', controlKind: 'select',
        inputMode: 'editable', visibleWhen: [], requiredWhen: [], constraints: [],
        sourceRef: { file: 'Review.tsx', line: 1 },
      }],
      actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [],
    }] };

    const variants = reduceVariants(witnesses, families, graph, pages);
    const requirements = buildDataRequirements(variants, pages, { actors: [] }, { witnesses, behavior: graph });

    expect(variants.variants[0]?.entityPrerequisites).toEqual([expect.objectContaining({
      predicatePath: 'selectedAccount.status',
      expectedValue: 'ACTIVE',
      fieldId: 'field.account-id',
    })]);
    expect(requirements[0]).toMatchObject({
      classification: 'existing-entity',
      expectedAttributes: { 'selectedAccount.status': 'ACTIVE' },
    });
  });
});

function compileWizardFieldScenario(sharedSourceValue: boolean, connected = true) {
  const detailsImport = sharedSourceValue
    ? `import { applicationDraft } from '../state/draft';`
    : `import { useState } from 'react';`;
  const detailsLocal = sharedSourceValue
    ? `function setProductCode(value: string) { applicationDraft.productCode = value; }`
    : `const [productCode, setProductCode] = useState('');`;
  const detailsValue = sharedSourceValue ? 'applicationDraft.productCode' : 'productCode';
  const reviewState = sharedSourceValue
    ? `import { applicationDraft } from '../state/draft';`
    : `import { useState } from 'react';`;
  const reviewValue = sharedSourceValue ? 'applicationDraft.productCode' : 'productCode';
  const reviewLocal = sharedSourceValue ? '' : `const [productCode] = useState('');`;
  const react = extractReact([
    tsFile('frontend/src/state/draft.ts', `export const applicationDraft = { productCode: '' };`),
    tsFile('frontend/src/pages/DetailsPage.tsx', `
      ${detailsImport}
      export function DetailsPage() {
        ${detailsLocal}
        return <>
          <input name="productCode" value={${detailsValue}} onChange={(event) => setProductCode(event.target.value)} />
          ${connected ? '<Link to="/review">Continue</Link>' : ''}
        </>;
      }
    `),
    tsFile('frontend/src/pages/ReviewPage.tsx', `
      ${reviewState}
      export function ReviewPage() {
        ${reviewLocal}
        async function submitProduct() {
          await fetch('/api/products', {
            method: 'POST',
            body: JSON.stringify({ productCode: ${reviewValue} }),
          });
        }
        return <button onClick={submitProduct}>Submit product</button>;
      }
    `),
    ...(connected ? [tsFile('frontend/src/AppRoutes.tsx', `
      import { DetailsPage } from './pages/DetailsPage';
      import { ReviewPage } from './pages/ReviewPage';
      export function AppRoutes() { return <Routes>
        <Route path="/details" element={<DetailsPage />} />
        <Route path="/review" element={<ReviewPage />} />
      </Routes>; }
    `)] : []),
  ]);
  const java = extractJava([
    javaFile('backend/ProductRequest.java', `
      package example;
      import jakarta.validation.constraints.NotBlank;
      import jakarta.validation.constraints.Size;
      public class ProductRequest {
        @NotBlank
        @Size(max = 8)
        private String productCode;
      }
    `),
    javaFile('backend/ProductController.java', `
      package example;
      import jakarta.validation.Valid;
      import org.springframework.web.bind.annotation.*;
      @RestController
      @RequestMapping("/api/products")
      public class ProductController {
        @jakarta.annotation.security.PermitAll
        @PostMapping
        public Product submit(@Valid @RequestBody ProductRequest request) {
          Product product = new Product();
          return productRepository.save(product);
        }
      }
    `),
  ]);
  const bundle: ExtractionBundle = {
    sourceDigest: 'sha256:wizard-field-test',
    sourceFiles: [],
    routes: react.routes,
    pages: react.pages,
    handlers: react.handlers,
    actions: react.actions,
    fields: react.fields,
    httpOperations: react.httpOperations,
    navigations: react.navigations,
    permissions: [...react.permissions, ...java.permissions],
    endpoints: java.endpoints,
    validations: java.validations,
    effects: java.effects,
    wikiConcepts: [],
    graphifyNodes: [],
    graphifyEdges: [],
    diagnostics: [...react.diagnostics, ...java.diagnostics],
  };
  const payloadAnalysis = analyzeRequestPayloads(bundle);
  bundle.requestContracts = payloadAnalysis.contracts;
  const catalog = buildOperationCatalog(bundle);
  return {
    bundle,
    contracts: payloadAnalysis.contracts,
    catalog,
    pages: buildPageContracts(bundle, catalog),
  };
}

function compilePayloadScenario(
  payloadExpression: string,
  wrapperPayloadExpression = 'payload',
  additionalReactFiles: SourceFile[] = [],
  controllerBody = 'Application application = new Application(); return applicationRepository.save(application);',
  submitBody = `await createApplication(${payloadExpression});`,
) {
  const react = extractReact([
    tsFile('frontend/src/pages/ReviewPage.tsx', `
      import { useState } from 'react';
      import { createApplication } from '../services/api';
      export function ReviewPage() {
        const [selectedPrimaryApplicantId, setSelectedPrimaryApplicantId] = useState('');
        const [selectedProductCode, setSelectedProductCode] = useState('');
        function buildApplicationPayload() { return window.__applicationDraft; }
        async function submitApplication() {
          ${submitBody}
        }
        return <main>
          <input name="primaryApplicantId" value={selectedPrimaryApplicantId} onChange={(event) => setSelectedPrimaryApplicantId(event.target.value)} required />
          <input name="productCode" value={selectedProductCode} onChange={(event) => setSelectedProductCode(event.target.value)} minLength={3} required />
          <button onClick={submitApplication}>Submit application</button>
        </main>;
      }
    `),
    tsFile('frontend/src/services/api.ts', `
      const payload = { applicationType: 'SHADOW', primaryApplicantId: 'SHADOW', productCode: 'SHADOW' };
      export async function createApplication(payload: unknown) {
        return fetch('/api/applications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(${wrapperPayloadExpression}),
        });
      }
    `),
    tsFile('frontend/src/AppRoutes.tsx', `
      import { ReviewPage } from './pages/ReviewPage';
      export function AppRoutes() {
        return <Routes><Route path="/review" element={<ReviewPage />} /></Routes>;
      }
    `),
    ...additionalReactFiles,
  ]);
  const java = extractJava([
    javaFile('backend/ApplicationRequest.java', `
      package example;
      import jakarta.validation.constraints.NotBlank;
      import jakarta.validation.constraints.NotNull;
      import jakarta.validation.constraints.Size;
      public class ApplicationRequest {
        @NotNull
        private String applicationType;
        @NotBlank
        private String primaryApplicantId;
        @NotBlank
        @Size(max = 12)
        private String productCode;
      }
    `),
    javaFile('backend/ApplicationController.java', `
      package example;
      import jakarta.validation.Valid;
      import org.springframework.web.bind.annotation.*;
      @RestController
      @RequestMapping("/api/applications")
      public class ApplicationController {
        @jakarta.annotation.security.PermitAll
        @PostMapping
        public ApplicationResponse submitApplication(@Valid @RequestBody ApplicationRequest request) {
          ${controllerBody}
        }
      }
    `),
    javaFile('backend/OtherRequest.java', `
      package example;
      import jakarta.validation.constraints.Max;
      public class OtherRequest {
        @Max(99)
        private String productCode;
      }
    `),
  ]);
  const bundle: ExtractionBundle = {
    sourceDigest: 'sha256:request-payload-test',
    sourceFiles: [],
    routes: react.routes,
    pages: react.pages,
    handlers: react.handlers,
    actions: react.actions,
    fields: react.fields,
    httpOperations: react.httpOperations,
    navigations: react.navigations,
    permissions: [...react.permissions, ...java.permissions],
    endpoints: java.endpoints,
    validations: java.validations,
    effects: java.effects,
    wikiConcepts: [],
    graphifyNodes: [],
    graphifyEdges: [],
    diagnostics: [...react.diagnostics, ...java.diagnostics],
  };
  const payloadAnalysis = analyzeRequestPayloads(bundle);
  bundle.requestContracts = payloadAnalysis.contracts;
  bundle.diagnostics.push(...payloadAnalysis.diagnostics);

  const catalog = buildOperationCatalog(bundle);
  const actors = buildActorRequirements(bundle, catalog);
  const pages = buildPageContracts(bundle);
  const behavior = buildBehaviorGraph(bundle, catalog, pages, config);
  const families = buildFlowFamilies(catalog, actors, behavior);
  const witnesses = searchPaths(behavior, families, config);
  const variants = reduceVariants(witnesses, families, behavior, pages);
  const dataRequirements = buildDataRequirements(variants, pages, actors, { witnesses, behavior });
  const coverage = buildCoverage(
    bundle,
    catalog,
    pages,
    actors,
    behavior,
    families,
    witnesses,
    variants,
    dataRequirements,
    { bindings: [] },
    config,
  );
  const operation = catalog.operations[0]!;
  const operationNodeId = behavior.nodes.find((node) => node.kind === 'operation' && node.referenceId === operation.id)!.id;
  const actionId = bundle.actions.find((action) => action.accessibleName === 'Submit application')!.id;

  return {
    contracts: payloadAnalysis.contracts,
    diagnostics: payloadAnalysis.diagnostics,
    operation,
    operationNodeId,
    actionId,
    behavior,
    pages,
    variants: variants.variants,
    coverage,
  };
}

function tsFile(relativePath: string, contents: string): SourceFile {
  return { absolutePath: `/${relativePath}`, relativePath, language: 'typescript', contents };
}

function javaFile(relativePath: string, contents: string): SourceFile {
  return { absolutePath: `/${relativePath}`, relativePath, language: 'java', contents };
}

const config = {
  analysis: {
    entryRoutes: ['/review'],
    includeHttpMethods: ['POST'],
    maxPathDepth: 20,
    maxStateVisits: 2,
  },
} as unknown as FlowctlConfig;

function behaviorEdge(
  id: string,
  from: string,
  to: string,
  requestPayloadContracts?: NonNullable<BehaviorGraph['edges'][number]['requestPayloadContracts']>,
): BehaviorGraph['edges'][number] {
  return {
    id,
    from,
    to,
    guard: { kind: 'constant', value: true },
    effects: [],
    outcome: to === 'page.success' ? 'success' : 'neutral',
    evidenceRefs: [],
    ...(requestPayloadContracts ? { requestPayloadContracts } : {}),
  };
}
