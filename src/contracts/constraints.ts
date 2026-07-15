import type { InputConstraint } from '../ir/model.js';

export type ConstraintEvaluationStatus = 'valid' | 'invalid' | 'conditional';

export interface ConstraintEvaluation {
  status: ConstraintEvaluationStatus;
  issues: string[];
}

export function evaluateConstraintValue(
  constraints: InputConstraint[],
  value: string | number | boolean | null,
  representation: 'json-literal' | 'ui-input' = 'ui-input',
): ConstraintEvaluation {
  const invalid: string[] = [];
  const conditional: string[] = [];
  for (const constraint of constraints) {
    if (constraint.kind === 'opaque') {
      conditional.push(`constraint ${constraint.id} is opaque and requires a reviewed resolver`);
      continue;
    }
    if (constraint.kind === 'size') {
      conditional.push(`constraint ${constraint.id} uses an unsupported size representation`);
      continue;
    }
    if (constraint.kind === 'required' && constraint.value !== false
      && (value === null || (typeof value === 'string' && value.trim().length === 0))) {
      invalid.push('a non-empty value is required');
    }
    if (constraint.kind === 'type' && typeof constraint.value === 'string'
      && !valueMatchesType(value, constraint.value, representation)) {
      invalid.push(`value does not satisfy ${constraint.value} ${representation === 'json-literal' ? 'JSON' : 'input'} type`);
    }
    if (constraint.kind === 'min' && typeof constraint.value === 'number') {
      const actual = constraintMeasure(value, constraint.domain);
      if (actual === undefined || actual < constraint.value) invalid.push(`minimum ${constraint.value} is not satisfied`);
    }
    if (constraint.kind === 'max' && typeof constraint.value === 'number') {
      const actual = constraintMeasure(value, constraint.domain);
      if (actual === undefined || actual > constraint.value) invalid.push(`maximum ${constraint.value} is exceeded`);
    }
    if (constraint.kind === 'pattern' && typeof constraint.value === 'string') {
      if (typeof value !== 'string') {
        invalid.push('pattern requires a string value');
      } else if (!portablePattern(constraint.value)) {
        conditional.push('pattern uses a Java/browser construct outside the portable constraint subset');
      } else {
        try {
          if (!new RegExp(`^(?:${constraint.value})$`).test(value)) invalid.push('pattern is not satisfied');
        } catch {
          conditional.push('pattern cannot be validated by the supported constraint engine');
        }
      }
    }
    if (constraint.kind === 'format') {
      if (constraint.value === 'email') {
        if (typeof value !== 'string' || !htmlEmailSyntax(value)) invalid.push('value is not a valid browser email input');
      } else {
        conditional.push(`format ${String(constraint.value)} is not supported by the constraint engine`);
      }
    }
    if (constraint.kind === 'enum' && Array.isArray(constraint.value) && !constraint.value.includes(String(value))) {
      invalid.push(`value is not one of ${constraint.value.join(', ')}`);
    }
  }
  if (invalid.length) return { status: 'invalid', issues: invalid };
  if (conditional.length) return { status: 'conditional', issues: conditional };
  return { status: 'valid', issues: [] };
}

export function evaluateConstraintSet(constraints: InputConstraint[]): ConstraintEvaluationStatus | 'unsatisfiable' {
  if (constraints.some((constraint) => constraint.kind === 'opaque' || constraint.kind === 'size')) return 'conditional';
  const types = new Set(constraints
    .filter((constraint) => constraint.kind === 'type' && typeof constraint.value === 'string')
    .map((constraint) => String(constraint.value)));
  if (types.size > 1) return 'unsatisfiable';

  const enums = constraints.filter((constraint) => constraint.kind === 'enum');
  if (enums.some((constraint) => !Array.isArray(constraint.value) || constraint.value.length === 0)) return 'unsatisfiable';
  if (enums.length) {
    const candidates = enums
      .map((constraint) => new Set((constraint.value as string[]).map(String)))
      .reduce((left, right) => new Set([...left].filter((value) => right.has(value))));
    if (!candidates.size) return 'unsatisfiable';
    const results = [...candidates].map((candidate) => evaluateConstraintValue(constraints, candidate, 'ui-input').status);
    if (results.includes('valid')) return 'valid';
    if (results.includes('conditional')) return 'conditional';
    return 'unsatisfiable';
  }

  for (const domain of ['length', 'numeric'] as const) {
    const minimums = constraints.filter((constraint) => (
      constraint.kind === 'min' && constraint.domain === domain && typeof constraint.value === 'number'
    )).map((constraint) => constraint.value as number);
    const maximums = constraints.filter((constraint) => (
      constraint.kind === 'max' && constraint.domain === domain && typeof constraint.value === 'number'
    )).map((constraint) => constraint.value as number);
    if (minimums.length && maximums.length && Math.max(...minimums) > Math.min(...maximums)) return 'unsatisfiable';
  }
  const required = constraints.some((constraint) => constraint.kind === 'required' && constraint.value !== false);
  const maximumLength = constraints.filter((constraint) => (
    constraint.kind === 'max' && constraint.domain === 'length' && typeof constraint.value === 'number'
  )).map((constraint) => constraint.value as number);
  if (required && maximumLength.length && Math.min(...maximumLength) < 1) return 'unsatisfiable';
  if (constraints.some((constraint) => (
    (constraint.kind === 'min' || constraint.kind === 'max')
    && (constraint.domain === undefined || constraint.domain === 'unknown')
  ))) return 'conditional';
  for (const constraint of constraints.filter((candidate) => candidate.kind === 'pattern')) {
    if (typeof constraint.value !== 'string' || !portablePattern(constraint.value)) return 'conditional';
    try {
      new RegExp(`^(?:${constraint.value})$`);
    } catch {
      return 'conditional';
    }
    // A compilable regular expression is not itself a constructive witness,
    // especially when combined with length/type constraints.
    return 'conditional';
  }
  // Structural checks can prove a contradiction, but they cannot prove that
  // arbitrary combinations (for example email + maxLength) have a model.  A
  // runnable flow therefore needs one concrete value that passes the complete
  // supported constraint set.  Absence of a witness is review-required, not a
  // satisfiability claim.
  return representativeValueForConstraints(constraints) !== undefined ? 'valid' : 'conditional';
}

export function representativeValueForConstraints(
  constraints: InputConstraint[],
): string | number | boolean | null | undefined {
  if (constraints.some((constraint) => constraint.kind === 'opaque' || constraint.kind === 'size')) return undefined;
  const candidates: Array<string | number | boolean | null> = [];
  for (const constraint of constraints.filter((candidate) => candidate.kind === 'enum' && Array.isArray(candidate.value))) {
    candidates.push(...(constraint.value as string[]));
  }
  if (constraints.some((constraint) => constraint.kind === 'format' && constraint.value === 'email')) {
    candidates.push('test@example.com');
  }
  const expectedTypes = constraints.filter((constraint) => constraint.kind === 'type').map((constraint) => constraint.value);
  if (expectedTypes.includes('boolean')) candidates.push(true, false);
  if (expectedTypes.includes('integer') || expectedTypes.includes('number')
    || constraints.some((constraint) => constraint.domain === 'numeric')) {
    const minimum = Math.max(0, ...constraints.filter((constraint) => (
      constraint.kind === 'min' && constraint.domain === 'numeric' && typeof constraint.value === 'number'
    )).map((constraint) => constraint.value as number));
    candidates.push(expectedTypes.includes('integer') ? Math.ceil(minimum) : minimum, 1);
  }
  const minimumLength = Math.max(
    constraints.some((constraint) => constraint.kind === 'required' && constraint.value !== false) ? 1 : 0,
    ...constraints.filter((constraint) => (
      constraint.kind === 'min' && constraint.domain === 'length' && typeof constraint.value === 'number'
    )).map((constraint) => constraint.value as number),
  );
  const seedLength = Math.max(1, minimumLength);
  candidates.push('A'.repeat(seedLength), 'TEST', 'test', '1234567890');
  return candidates.find((candidate) => evaluateConstraintValue(constraints, candidate, 'ui-input').status === 'valid');
}

function valueMatchesType(
  value: string | number | boolean | null,
  expected: string,
  representation: 'json-literal' | 'ui-input',
): boolean {
  if (expected === 'string') return typeof value === 'string';
  if (expected === 'boolean') return typeof value === 'boolean'
    || (representation === 'ui-input' && (value === 'true' || value === 'false'));
  if (expected === 'integer') {
    const numeric = representation === 'json-literal'
      ? typeof value === 'number' ? value : Number.NaN
      : numericValue(value);
    return Number.isFinite(numeric) && Number.isInteger(numeric);
  }
  if (expected === 'number') {
    const numeric = representation === 'json-literal'
      ? typeof value === 'number' ? value : Number.NaN
      : numericValue(value);
    return Number.isFinite(numeric);
  }
  return false;
}

function numericValue(value: string | number | boolean | null): number {
  return typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
}

function constraintMeasure(value: string | number | boolean | null, domain: InputConstraint['domain']): number | undefined {
  if (domain === 'numeric') {
    const numeric = numericValue(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  if (domain === 'length') return typeof value === 'string' ? value.length : undefined;
  return typeof value === 'number' ? value : typeof value === 'string' ? value.length : undefined;
}

function portablePattern(value: string): boolean {
  return !/(?:\\[AzGQE]|\\[pP]\{|\(\?[<!=:]|\(\?[a-zA-Z-]+\)|\+\+|\*\+|\?\+|\{[^}]+\}\+|&&)/.test(value);
}

function htmlEmailSyntax(value: string): boolean {
  return /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)*$/i.test(value);
}
