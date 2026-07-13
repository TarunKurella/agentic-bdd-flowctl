import { describe, expect, it } from 'vitest';
import { canonicalize, stableId, stableJson } from '../src/core/stable.js';
import { predicateFromExpression, solvePredicate } from '../src/ir/predicates.js';
import { routeMatches } from '../src/pipeline/builders.js';

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
});
