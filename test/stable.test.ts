import { describe, expect, it } from 'vitest';
import { canonicalize, stableId, stableJson } from '../src/core/stable.js';
import { predicateFromExpression, solvePredicate } from '../src/ir/predicates.js';
import { buildDataRequirements, reduceVariants, routeMatches } from '../src/pipeline/builders.js';
import { bddSafeSourceValue, gherkinString, gherkinText } from '../src/bdd/generate.js';
import { evaluateConstraintSet } from '../src/contracts/constraints.js';
import type { ActorRequirements, BehaviorGraph, FlowFamilies, PageContracts, PathWitnesses, ReactFieldFact } from '../src/ir/model.js';

describe('stable compiler primitives', () => {
  it('generates deterministic IDs and canonical JSON', () => {
    expect(stableId('route', '/applications/:id')).toBe(stableId('route', '/applications/:id'));
    expect(stableJson({ z: 1, a: { d: 2, c: 1 } })).toBe(stableJson(canonicalize({ a: { c: 1, d: 2 }, z: 1 })));
  });

  it('encodes source and reviewed text without creating Gherkin statements', () => {
    expect(gherkinText('Submit\nScenario: injected\tflow')).toBe('Submit Scenario: injected flow');
    expect(gherkinString('a "quoted" \\ value\nThen injected')).toBe('"a \\"quoted\\" \\\\ value Then injected"');
  });

  it('extracts satisfiable enum-like branch assignments', () => {
    const predicate = predicateFromExpression("applicationType === 'JOINT' && canSubmit");
    expect(solvePredicate(predicate)).toMatchObject({
      status: 'satisfiable',
      assignments: { applicationType: 'JOINT', canSubmit: true },
    });
  });

  it('rejects contradictory branch assignments', () => {
    const predicate = predicateFromExpression("applicationType === 'JOINT' && applicationType === 'PERSONAL'");
    expect(solvePredicate(predicate).status).toBe('unsatisfiable');
  });

  it.each([
    'isEligible(user) === true',
    'age + bonus >= 18',
    'answers[index] === "YES"',
  ])('keeps unsupported computed predicates conditional: %s', (expression) => {
    const predicate = predicateFromExpression(expression);
    expect(predicate.kind).toBe('opaque');
    expect(solvePredicate(predicate)).toMatchObject({ status: 'conditional', assignments: {} });
  });

  it('honors boolean precedence and surrounding parentheses', () => {
    const predicate = predicateFromExpression("mode === 'A' || (mode === 'B' && enabled)");
    expect(predicate.kind).toBe('any');
    expect(solvePredicate(predicate)).toMatchObject({
      status: 'satisfiable',
      assignments: { mode: 'A' },
    });
  });

  it.each([
    "mode !== 'A' && mode === 'A'",
    "mode === 'A' && mode !== 'A'",
    'amount > 5 && amount < 3',
    'amount >= 5 && amount < 5',
    'amount >= 5 && amount <= 5 && amount != 5',
  ])('rejects order-independent supported contradiction: %s', (expression) => {
    expect(solvePredicate(predicateFromExpression(expression)).status).toBe('unsatisfiable');
  });

  it.each([
    ['age >= 18 && age < 65', 18],
    ['score > 5 && score < 6', 5.5],
    ['balance <= 0', 0],
  ])('derives a representative numeric branch assignment for %s', (expression, expected) => {
    expect(solvePredicate(predicateFromExpression(expression))).toMatchObject({
      status: 'satisfiable',
      assignments: { [expression.split(/\s/)[0]!]: expected },
    });
  });

  it('derives the opposite boolean assignment for a negated flag', () => {
    expect(solvePredicate(predicateFromExpression('canSubmit && !submitting')).assignments).toEqual({
      canSubmit: true,
      submitting: false,
    });
  });

  it('matches React and Java dynamic route templates', () => {
    expect(routeMatches('/applications/{response.applicationId}/confirmation', '/applications/:applicationId/confirmation')).toBe(true);
    expect(routeMatches('/applications/review', '/applications/:applicationId/confirmation')).toBe(false);
  });

  it('does not claim satisfiability without a whole-set field witness', () => {
    expect(evaluateConstraintSet([{
      id: 'format.email', fieldPath: 'email', kind: 'format', domain: 'format', value: 'email', sourceRef: { file: 'Form.tsx', line: 1 },
    }, {
      id: 'max.two', fieldPath: 'email', kind: 'max', domain: 'length', value: 2, sourceRef: { file: 'Form.tsx', line: 1 },
    }])).toBe('conditional');
  });

  it('never generates or emits source values for password and credential fields', () => {
    const pathCondition = predicateFromExpression("form.otp === '654321'");
    const pages: PageContracts = { pages: [{
      id: 'page.form',
      name: 'Credential form',
      routePatterns: ['/credential'],
      fields: [{
        id: 'field.credential', pageId: 'page.form', dataPath: 'form.credential', controlKind: 'password', inputMode: 'editable',
        visibleWhen: [], requiredWhen: [], constraints: [], sourceRef: { file: 'CredentialForm.tsx', line: 1 },
      }, {
        id: 'field.otp', pageId: 'page.form', dataPath: 'form.otp', controlKind: 'textbox', inputMode: 'editable',
        visibleWhen: [], requiredWhen: [], constraints: [{
          id: 'constraint.otp-source', fieldPath: 'form.otp', kind: 'enum', domain: 'value-set', value: ['654321'],
          message: 'enter OTP 654321', sourceRef: { file: 'CredentialForm.tsx', line: 2, excerpt: "otp === '654321'" },
        }], sourceRef: { file: 'CredentialForm.tsx', line: 2 },
      }],
      actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [],
    }, {
      id: 'page.success', name: 'Success', routePatterns: ['/success'], fields: [], actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [],
    }] };
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'page.form', kind: 'screen-state', label: 'Credential form', attributes: {} },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', referenceId: 'operation.submit', attributes: {} },
        { id: 'page.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [], entryNodeIds: ['page.form'], successNodeIds: ['page.success'],
    };
    const witnesses: PathWitnesses = { witnesses: [{
      id: 'witness.secret', familyId: 'credential.submit',
      nodePath: ['page.form', 'action.submit', 'operation.submit', 'page.success'], edgePath: [],
      pageSequence: ['page.form', 'page.success'], actionSequence: ['action.submit'],
      pathCondition, assignments: { 'form.otp': '654321' }, feasibility: 'satisfiable', evidenceRefs: [],
    }] };
    const variants = { variants: [{
      id: 'credential.submit.default', familyId: 'credential.submit', label: 'Submit credentials', witnessIds: ['witness.secret'],
      behaviorSignature: 'credential-secret', actorRequirementIds: [], pathCondition,
      pageSequence: ['page.form', 'page.success'], actionSequence: ['action.submit'], operationIds: ['operation.submit'],
      dataRequirementIds: [], feasibility: 'satisfiable' as const, evidenceRefs: [],
    }] };

    const requirements = buildDataRequirements(variants, pages, { actors: [] }, { witnesses, behavior: graph });
    expect(requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: 'form.credential', classification: 'secret-reference', status: 'unresolved' }),
      expect.objectContaining({ fieldPath: 'form.otp', classification: 'secret-reference', status: 'unresolved' }),
    ]));
    expect(requirements.every((requirement) => requirement.representativeValue === undefined)).toBe(true);
    const otp = requirements.find((requirement) => requirement.fieldPath === 'form.otp')!;
    expect(otp.constraints).toEqual([{
      id: 'constraint.otp-source',
      fieldPath: 'form.otp',
      kind: 'enum',
      domain: 'value-set',
      sourceRef: { file: 'CredentialForm.tsx', line: 2 },
    }]);
    expect(stableJson(requirements)).not.toContain('654321');
    expect(stableJson(requirements)).not.toContain('enter OTP');
    expect(bddSafeSourceValue(otp, '654321')).toBeUndefined();
    expect(bddSafeSourceValue(otp, ['654321'])).toBeUndefined();
  });

  it('keeps assigned UAT entities and dynamic product options external while allowing static options', () => {
    const pathCondition = predicateFromExpression(
      "customerId === 'CUST-42' && productCode === 'DYNAMIC-PRODUCT' && countryCode === 'US'",
    );
    const sourceRef = { file: 'ApplicationForm.tsx', line: 1 };
    const pages: PageContracts = { pages: [{
      id: 'page.form', name: 'Application form', routePatterns: ['/apply'],
      fields: [{
        id: 'field.customer', pageId: 'page.form', dataPath: 'customerId', controlKind: 'CustomerSelect', inputMode: 'editable',
        visibleWhen: [], requiredWhen: [], constraints: [], sourceRef,
      }, {
        id: 'field.product', pageId: 'page.form', dataPath: 'productCode', controlKind: 'select', inputMode: 'editable',
        optionSource: { status: 'runtime', options: [], expression: 'availableProducts', sourceRefs: [sourceRef] },
        visibleWhen: [], requiredWhen: [], constraints: [], sourceRef,
      }, {
        id: 'field.country', pageId: 'page.form', dataPath: 'countryCode', controlKind: 'select', inputMode: 'editable',
        optionSource: { status: 'static', options: [{ value: 'US', sourceRef }], sourceRefs: [sourceRef] },
        visibleWhen: [], requiredWhen: [], constraints: [{
          id: 'constraint.country-options', fieldPath: 'countryCode', kind: 'enum', domain: 'value-set', value: ['US'], sourceRef,
        }], sourceRef,
      }],
      actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [],
    }, {
      id: 'page.success', name: 'Success', routePatterns: ['/success'], fields: [], actions: [], entryConditions: [],
      completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [],
    }] };
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'page.form', kind: 'screen-state', label: 'Application form', attributes: {} },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', referenceId: 'operation.submit', attributes: {} },
        { id: 'page.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [], entryNodeIds: ['page.form'], successNodeIds: ['page.success'],
    };
    const witnesses: PathWitnesses = { witnesses: [{
      id: 'witness.application-values', familyId: 'application.submit',
      nodePath: ['page.form', 'action.submit', 'operation.submit', 'page.success'], edgePath: [],
      pageSequence: ['page.form', 'page.success'], actionSequence: ['action.submit'],
      pathCondition, assignments: solvePredicate(pathCondition).assignments, feasibility: 'satisfiable', evidenceRefs: [],
    }] };
    const variants = { variants: [{
      id: 'application.submit.values', familyId: 'application.submit', label: 'Submit application',
      witnessIds: ['witness.application-values'], behaviorSignature: 'application-values', actorRequirementIds: [], pathCondition,
      pageSequence: ['page.form', 'page.success'], actionSequence: ['action.submit'], operationIds: ['operation.submit'],
      dataRequirementIds: [], feasibility: 'satisfiable' as const, evidenceRefs: [],
    }] };

    const requirements = buildDataRequirements(variants, pages, { actors: [] }, { witnesses, behavior: graph });
    const byPath = new Map(requirements.map((requirement) => [requirement.fieldPath, requirement]));
    expect(byPath.get('customerId')).toMatchObject({
      classification: 'existing-entity', expectedValue: 'CUST-42', status: 'unresolved',
    });
    expect(byPath.get('customerId')).not.toHaveProperty('representativeValue');
    expect(byPath.get('productCode')).toMatchObject({
      classification: 'runtime-option', expectedValue: 'DYNAMIC-PRODUCT', status: 'unresolved',
    });
    expect(byPath.get('productCode')).not.toHaveProperty('representativeValue');
    expect(byPath.get('countryCode')).toMatchObject({
      classification: 'runtime-option', representativeValue: 'US', status: 'generated',
    });
    expect(byPath.get('countryCode')).not.toHaveProperty('expectedValue');
  });

  it('turns actor predicates into application requirements but blocks unbound UI state', () => {
    const pages: PageContracts = { pages: [{
      id: 'page.entry', name: 'Entry', routePatterns: ['/'], fields: [], actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [],
    }, {
      id: 'page.success', name: 'Success', routePatterns: ['/success'], fields: [], actions: [], entryConditions: [], completeness: 'exact', unresolvedChildComponentRefs: [], evidenceRefs: [],
    }] };
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'page.entry', kind: 'screen-state', label: 'Entry', attributes: {} },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'invoke.submit', kind: 'operation', label: 'Submit', referenceId: 'operation.submit', attributes: { actorRequirementIds: ['actor.required'] } },
        { id: 'page.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [], entryNodeIds: ['page.entry'], successNodeIds: ['page.success'],
    };
    const families: FlowFamilies = { families: [{
      id: 'application.submit', label: 'Submit', operationIds: ['operation.submit'], entryNodeIds: ['page.entry'], successNodeIds: ['page.success'], actorRequirementIds: ['actor.required'], evidenceRefs: [],
    }] };
    const actors: ActorRequirements = { actors: [{
      id: 'actor.required', authentication: 'required', authoritiesAll: [], rolesAll: [], attributePredicates: [], relationships: [], label: 'signed-in actor', evidenceRefs: [],
    }] };
    const witness = (id: string, path: string): PathWitnesses => ({ witnesses: [{
      id, familyId: 'application.submit', nodePath: ['page.entry', 'action.submit', 'invoke.submit', 'page.success'], edgePath: [], pageSequence: ['page.entry', 'page.success'], actionSequence: ['action.submit'], pathCondition: predicateFromExpression(path), assignments: solvePredicate(predicateFromExpression(path)).assignments, feasibility: 'satisfiable', evidenceRefs: [],
    }] });

    const actorVariants = reduceVariants(witness('actor-witness', 'user.isEligible'), families, graph, pages, actors);
    expect(actorVariants.variants[0]).toMatchObject({ feasibility: 'satisfiable', actorAttributeAssignments: { 'user.isEligible': true } });
    expect(buildDataRequirements(actorVariants, pages, actors, { witnesses: witness('actor-witness', 'user.isEligible'), behavior: graph })).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'actor-attribute', fieldPath: 'user.isEligible', expectedValue: true, actorRequirementId: 'actor.required' }),
    ]));

    const internalVariants = reduceVariants(witness('internal-witness', 'canSubmit'), families, graph, pages, actors);
    expect(internalVariants.variants[0]).toMatchObject({ feasibility: 'conditional', unboundPathAssignments: ['canSubmit'] });

    const entityPages: PageContracts = { pages: pages.pages.map((page) => page.id === 'page.entry' ? {
      ...page,
      fields: [{
        id: 'field.account', pageId: page.id, dataPath: 'accountId', controlKind: 'AccountSelect', inputMode: 'editable', visibleWhen: [], requiredWhen: [], constraints: [], sourceRef: { file: 'Form.tsx', line: 1 },
      }],
    } : page) };
    const entityVariants = reduceVariants(witness('entity-witness', "selectedAccount.status === 'ACTIVE'"), families, graph, entityPages, actors);
    expect(entityVariants.variants[0]).toMatchObject({
      feasibility: 'satisfiable',
      entityPrerequisites: [expect.objectContaining({ predicatePath: 'selectedAccount.status', expectedValue: 'ACTIVE', fieldId: 'field.account' })],
    });
    expect(buildDataRequirements(entityVariants, entityPages, actors, { witnesses: witness('entity-witness', "selectedAccount.status === 'ACTIVE'"), behavior: graph })).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'existing-entity', fieldPath: 'accountId', expectedAttributes: { 'selectedAccount.status': 'ACTIVE' } }),
    ]));
  });

  it('creates distinct variants only when a branch changes the active field contract', () => {
    const joint = predicateFromExpression("applicationType === 'JOINT'");
    const personal = predicateFromExpression("applicationType === 'PERSONAL'");
    const field: ReactFieldFact = {
      id: 'field.joint-applicant',
      pageId: 'page.form',
      dataPath: 'jointApplicantId',
      label: 'Joint applicant',
      controlKind: 'CustomerSelect',
      visibleWhen: [joint],
      requiredWhen: [joint],
      constraints: [{
        id: 'constraint.joint-required',
        fieldPath: 'jointApplicantId',
        kind: 'required',
        value: true,
        sourceRef: { file: 'Form.tsx', line: 10 },
      }],
      sourceRef: { file: 'Form.tsx', line: 9 },
    };
    const applicationTypeField: ReactFieldFact = {
      id: 'field.application-type',
      pageId: 'page.form',
      dataPath: 'applicationType',
      label: 'Application type',
      controlKind: 'radio',
      visibleWhen: [{ kind: 'opaque', sourceExpression: 'dynamicSchema.applicationType', reason: 'server-defined field visibility' }],
      requiredWhen: [],
      constraints: [],
      sourceRef: { file: 'Form.tsx', line: 5 },
    };
    const pages: PageContracts = { pages: [{
      id: 'page.form',
      name: 'Form',
      routePatterns: ['/form'],
      fields: [applicationTypeField, field],
      actions: [],
      entryConditions: [],
      completeness: 'exact',
      unresolvedChildComponentRefs: [],
      evidenceRefs: ['field.joint-applicant'],
    }, {
      id: 'page.success',
      name: 'Success',
      routePatterns: ['/success'],
      fields: [{
        id: 'field.success-reference',
        pageId: 'page.success',
        dataPath: 'applicationReference',
        controlKind: 'textbox',
        inputMode: 'editable',
        visibleWhen: [],
        requiredWhen: [],
        constraints: [],
        sourceRef: { file: 'Success.tsx', line: 1 },
      }],
      actions: [],
      entryConditions: [],
      completeness: 'exact',
      unresolvedChildComponentRefs: [],
      evidenceRefs: [],
    }] };
    const graph: BehaviorGraph = {
      nodes: [
        { id: 'page.form', kind: 'screen-state', label: 'Form', attributes: {} },
        { id: 'action.submit', kind: 'action', label: 'Submit', attributes: {} },
        { id: 'operation.submit', kind: 'operation', label: 'Submit', attributes: {} },
        { id: 'page.success', kind: 'screen-state', label: 'Success', attributes: {} },
      ],
      edges: [],
      entryNodeIds: ['page.form'],
      successNodeIds: ['page.success'],
    };
    const families: FlowFamilies = { families: [{
      id: 'application.submit',
      label: 'Submit application',
      operationIds: ['operation.submit'],
      entryNodeIds: ['page.form'],
      successNodeIds: ['page.success'],
      actorRequirementIds: [],
      evidenceRefs: [],
    }] };
    const baseWitness = {
      familyId: 'application.submit',
      nodePath: ['page.form', 'action.submit', 'operation.submit', 'page.success'],
      edgePath: ['edge.1', 'edge.2', 'edge.3'],
      pageSequence: ['page.form', 'page.success'],
      actionSequence: ['action.submit'],
      feasibility: 'satisfiable' as const,
      evidenceRefs: [],
    };
    const witnesses: PathWitnesses = { witnesses: [{
      ...baseWitness,
      id: 'witness.joint',
      pathCondition: joint,
      assignments: { applicationType: 'JOINT' },
    }, {
      ...baseWitness,
      id: 'witness.personal',
      pathCondition: personal,
      assignments: { applicationType: 'PERSONAL' },
    }] };

    const variants = reduceVariants(witnesses, families, graph, pages);
    expect(variants.variants.map((variant) => variant.id)).toEqual([
      'application.submit.joint',
      'application.submit.personal',
    ]);
    expect(variants.variants.every((variant) => variant.feasibility === 'conditional')).toBe(true);

    const actors: ActorRequirements = { actors: [] };
    const requirements = buildDataRequirements(variants, pages, actors, { witnesses, behavior: graph });
    expect(requirements.filter((requirement) => requirement.variantId === 'application.submit.joint').map((requirement) => requirement.fieldPath)).toContain('jointApplicantId');
    expect(requirements.filter((requirement) => requirement.variantId === 'application.submit.personal').map((requirement) => requirement.fieldPath)).not.toContain('jointApplicantId');
    expect(requirements.find((requirement) => (
      requirement.variantId === 'application.submit.joint'
      && requirement.fieldPath === 'applicationType'
    ))?.representativeValue).toBe('JOINT');
    expect(requirements.some((requirement) => requirement.fieldPath === 'applicationReference')).toBe(false);
  });
});
