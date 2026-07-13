import { describe, expect, it } from 'vitest';
import { canonicalize, stableId, stableJson } from '../src/core/stable.js';
import { predicateFromExpression, solvePredicate } from '../src/ir/predicates.js';
import { buildDataRequirements, reduceVariants, routeMatches } from '../src/pipeline/builders.js';
import type { ActorRequirements, BehaviorGraph, FlowFamilies, PageContracts, PathWitnesses, ReactFieldFact } from '../src/ir/model.js';

describe('stable compiler primitives', () => {
  it('generates deterministic IDs and canonical JSON', () => {
    expect(stableId('route', '/applications/:id')).toBe(stableId('route', '/applications/:id'));
    expect(stableJson({ z: 1, a: { d: 2, c: 1 } })).toBe(stableJson(canonicalize({ a: { c: 1, d: 2 }, z: 1 })));
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

  it('matches React and Java dynamic route templates', () => {
    expect(routeMatches('/applications/{response.applicationId}/confirmation', '/applications/:applicationId/confirmation')).toBe(true);
    expect(routeMatches('/applications/review', '/applications/:applicationId/confirmation')).toBe(false);
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
    const pages: PageContracts = { pages: [{
      id: 'page.form',
      name: 'Form',
      routePatterns: ['/form'],
      fields: [field],
      actions: [],
      entryConditions: [],
      evidenceRefs: ['field.joint-applicant'],
    }, {
      id: 'page.success',
      name: 'Success',
      routePatterns: ['/success'],
      fields: [],
      actions: [],
      entryConditions: [],
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

    const actors: ActorRequirements = { actors: [] };
    const requirements = buildDataRequirements(variants, pages, actors);
    expect(requirements.filter((requirement) => requirement.variantId === 'application.submit.joint').map((requirement) => requirement.fieldPath)).toContain('jointApplicantId');
    expect(requirements.filter((requirement) => requirement.variantId === 'application.submit.personal').map((requirement) => requirement.fieldPath)).not.toContain('jointApplicantId');
  });
});
