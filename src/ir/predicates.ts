import type { Predicate, ValueRef } from './model.js';

export const TRUE: Predicate = { kind: 'constant', value: true };

function parseLiteral(raw: string): ValueRef {
  const trimmed = raw.trim();
  if (/^['"`].*['"`]$/.test(trimmed)) {
    return { kind: 'literal', value: trimmed.slice(1, -1) };
  }
  if (trimmed === 'true' || trimmed === 'false') {
    return { kind: 'literal', value: trimmed === 'true' };
  }
  if (trimmed === 'null' || trimmed === 'undefined') {
    return { kind: 'literal', value: null };
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { kind: 'literal', value: Number(trimmed) };
  }
  return { kind: 'path', path: trimmed.replace(/\?\./g, '.') };
}

export function predicateFromExpression(expression?: string): Predicate {
  const source = expression?.trim();
  if (!source) return TRUE;

  const andParts = splitTopLevel(source, '&&');
  if (andParts.length > 1) {
    return { kind: 'all', operands: andParts.map(predicateFromExpression) };
  }
  const orParts = splitTopLevel(source, '||');
  if (orParts.length > 1) {
    return { kind: 'any', operands: orParts.map(predicateFromExpression) };
  }

  if (source.startsWith('!')) {
    return { kind: 'not', operand: predicateFromExpression(source.slice(1)) };
  }

  const comparison = source.match(/^(.+?)\s*(===|==|!==|!=|>=|<=|>|<)\s*(.+)$/);
  if (comparison) {
    const [, left, operator, right] = comparison;
    const operators = {
      '===': 'eq',
      '==': 'eq',
      '!==': 'neq',
      '!=': 'neq',
      '>': 'gt',
      '>=': 'gte',
      '<': 'lt',
      '<=': 'lte',
    } as const;
    return {
      kind: 'compare',
      left: parseLiteral(left ?? ''),
      operator: operators[operator as keyof typeof operators],
      right: parseLiteral(right ?? ''),
    };
  }

  if (/^[A-Za-z_$][\w$?.]*$/.test(source)) {
    return { kind: 'compare', left: { kind: 'path', path: source.replace(/\?\./g, '.') }, operator: 'eq', right: { kind: 'literal', value: true } };
  }

  return { kind: 'opaque', sourceExpression: source, reason: 'unsupported-expression' };
}

function splitTopLevel(source: string, operator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    if (character === ')' || character === ']' || character === '}') depth -= 1;
    if (depth === 0 && source.slice(index, index + operator.length) === operator) {
      parts.push(source.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (parts.length) parts.push(source.slice(start).trim());
  return parts;
}

export function allPredicates(predicates: Predicate[]): Predicate {
  const flattened = predicates.flatMap((predicate) => predicate.kind === 'all' ? predicate.operands : [predicate]);
  const meaningful = flattened.filter((predicate) => !(predicate.kind === 'constant' && predicate.value));
  if (!meaningful.length) return TRUE;
  if (meaningful.length === 1) return meaningful[0]!;
  return { kind: 'all', operands: meaningful };
}

export interface ConstraintResult {
  status: 'satisfiable' | 'unsatisfiable' | 'conditional';
  assignments: Record<string, string | number | boolean | null>;
  reason?: string;
}

export function solvePredicate(predicate: Predicate): ConstraintResult {
  const assignments: Record<string, string | number | boolean | null> = {};
  let conditional = false;

  function visit(current: Predicate, negated = false): boolean {
    if (current.kind === 'constant') return negated ? !current.value : current.value;
    if (current.kind === 'opaque') {
      conditional = true;
      return true;
    }
    if (current.kind === 'not') return visit(current.operand, !negated);
    if (current.kind === 'all') {
      return negated
        ? current.operands.some((operand) => visit(operand, true))
        : current.operands.every((operand) => visit(operand));
    }
    if (current.kind === 'any') {
      return negated
        ? current.operands.every((operand) => visit(operand, true))
        : current.operands.some((operand) => visit(operand));
    }
    if (current.kind === 'exists') {
      if (current.value.kind === 'path') assignments[current.value.path] = !negated;
      return true;
    }
    if (current.kind === 'member-of') {
      if (current.value.kind === 'path' && current.values[0]?.kind === 'literal') {
        assignments[current.value.path] = current.values[0].value;
      } else conditional = true;
      return true;
    }
    if (current.kind === 'compare') {
      if (current.left.kind !== 'path' || current.right.kind !== 'literal') {
        conditional = true;
        return true;
      }
      const operator = negated
        ? ({ eq: 'neq', neq: 'eq', gt: 'lte', gte: 'lt', lt: 'gte', lte: 'gt' } as const)[current.operator]
        : current.operator;
      if (operator === 'eq') {
        const existing = assignments[current.left.path];
        if (existing !== undefined && existing !== current.right.value) return false;
        assignments[current.left.path] = current.right.value;
      } else if (operator === 'neq') {
        const existing = assignments[current.left.path];
        if (existing !== undefined && existing === current.right.value) return false;
      } else {
        conditional = true;
      }
      return true;
    }
    return true;
  }

  const satisfiable = visit(predicate);
  if (!satisfiable) return { status: 'unsatisfiable', assignments, reason: 'contradictory equality constraints' };
  return { status: conditional ? 'conditional' : 'satisfiable', assignments };
}

export function predicateLabel(predicate: Predicate): string {
  if (predicate.kind === 'constant') return String(predicate.value);
  if (predicate.kind === 'opaque') return predicate.sourceExpression;
  if (predicate.kind === 'not') return `not (${predicateLabel(predicate.operand)})`;
  if (predicate.kind === 'all') return predicate.operands.map(predicateLabel).join(' and ');
  if (predicate.kind === 'any') return predicate.operands.map(predicateLabel).join(' or ');
  if (predicate.kind === 'exists') return `${valueLabel(predicate.value)} exists`;
  if (predicate.kind === 'member-of') return `${valueLabel(predicate.value)} in (${predicate.values.map(valueLabel).join(', ')})`;
  return `${valueLabel(predicate.left)} ${predicate.operator} ${valueLabel(predicate.right)}`;
}

function valueLabel(value: ValueRef): string {
  if (value.kind === 'literal') return JSON.stringify(value.value);
  if (value.kind === 'binding') return `$${value.bindingId}`;
  return value.path;
}
