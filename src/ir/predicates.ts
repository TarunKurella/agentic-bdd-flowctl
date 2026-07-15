import type { Predicate, ValueRef } from './model.js';

export const TRUE: Predicate = { kind: 'constant', value: true };

function parseValue(raw: string): ValueRef | undefined {
  const trimmed = raw.trim();
  if (/^(['"]).*\1$/.test(trimmed)) {
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
  if (/^[A-Za-z_$][\w$]*(?:\?\.[A-Za-z_$][\w$]*|\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) {
    return { kind: 'path', path: trimmed.replace(/\?\./g, '.') };
  }
  return undefined;
}

export function predicateFromExpression(expression?: string): Predicate {
  const source = stripOuterParentheses(expression?.trim() ?? '');
  if (!source) return TRUE;

  const orParts = splitTopLevel(source, '||');
  if (orParts.length > 1) {
    return { kind: 'any', operands: orParts.map(predicateFromExpression) };
  }
  const andParts = splitTopLevel(source, '&&');
  if (andParts.length > 1) {
    return { kind: 'all', operands: andParts.map(predicateFromExpression) };
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
    const leftValue = parseValue(left ?? '');
    const rightValue = parseValue(right ?? '');
    if (!leftValue || !rightValue) {
      return { kind: 'opaque', sourceExpression: source, reason: 'unsupported-comparison-operand' };
    }
    return {
      kind: 'compare',
      left: leftValue,
      operator: operators[operator as keyof typeof operators],
      right: rightValue,
    };
  }

  if (/^[A-Za-z_$][\w$?.]*$/.test(source)) {
    return { kind: 'compare', left: { kind: 'path', path: source.replace(/\?\./g, '.') }, operator: 'eq', right: { kind: 'literal', value: true } };
  }

  return { kind: 'opaque', sourceExpression: source, reason: 'unsupported-expression' };
}

function stripOuterParentheses(source: string): string {
  let value = source.trim();
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0;
    let quote: string | undefined;
    let wrapsWholeExpression = true;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (quote) {
        if (character === quote && value[index - 1] !== '\\') quote = undefined;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        continue;
      }
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (depth === 0 && index < value.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
      if (depth < 0) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression || depth !== 0) break;
    value = value.slice(1, -1).trim();
  }
  return value;
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

export interface PredicateModel extends Omit<ConstraintResult, 'status'> {
  predicate: Predicate;
  status: 'satisfiable' | 'conditional';
}

/**
 * Split the finite alternatives we can prove into separate models before flow
 * signatures are calculated.  Keeping `A || B` as one witness makes fields
 * that only exist in A and fields that only exist in B appear active together.
 *
 * The expansion is deliberately bounded.  If distributive expansion would
 * exceed the limit, the original predicate is retained as one conditional
 * model instead of silently dropping branches or claiming exact coverage.
 */
export function enumeratePredicateModels(predicate: Predicate, limit = 32): PredicateModel[] {
  const expanded = expandPredicateAlternatives(predicate, limit);
  if (expanded.overflow) {
    const result = solvePredicate(predicate);
    if (result.status === 'unsatisfiable') return [];
    return [{
      predicate: allPredicates([
        predicate,
        {
          kind: 'opaque',
          sourceExpression: `predicate-model-limit:${limit}`,
          reason: `Predicate alternatives exceed the bounded model limit of ${limit}.`,
        },
      ]),
      status: 'conditional',
      assignments: result.assignments,
      reason: `predicate alternatives exceed ${limit}`,
    }];
  }

  const models = expanded.branches.flatMap((branch): PredicateModel[] => {
    const result = solvePredicate(branch);
    return result.status === 'unsatisfiable' ? [] : [{ predicate: branch, ...result, status: result.status }];
  });
  return [...new Map(models.map((model) => [
    `${predicateLabel(model.predicate)}:${JSON.stringify(model.assignments)}`,
    model,
  ])).values()];
}

function expandPredicateAlternatives(predicate: Predicate, limit: number): { branches: Predicate[]; overflow: boolean } {
  const expand = (current: Predicate, negated = false): { branches: Predicate[]; overflow: boolean } => {
    if (current.kind === 'not') return expand(current.operand, !negated);
    if (current.kind === 'constant') {
      return { branches: [{ kind: 'constant', value: negated ? !current.value : current.value }], overflow: false };
    }
    if (current.kind === 'all' || current.kind === 'any') {
      const conjunction = (current.kind === 'all') !== negated;
      if (!conjunction) {
        const alternatives: Predicate[] = [];
        for (const operand of current.operands) {
          const nested = expand(operand, negated);
          if (nested.overflow || alternatives.length + nested.branches.length > limit) {
            return { branches: [], overflow: true };
          }
          alternatives.push(...nested.branches);
        }
        return { branches: alternatives, overflow: false };
      }

      let products: Predicate[] = [TRUE];
      for (const operand of current.operands) {
        const nested = expand(operand, negated);
        if (nested.overflow || products.length * nested.branches.length > limit) {
          return { branches: [], overflow: true };
        }
        products = products.flatMap((left) => nested.branches.map((right) => allPredicates([left, right])));
      }
      return { branches: products, overflow: false };
    }
    if (!negated && current.kind === 'member-of'
      && current.value.kind === 'path'
      && current.values.every((value) => value.kind === 'literal')) {
      if (current.values.length > limit) return { branches: [], overflow: true };
      return {
        branches: current.values.map((value) => ({
          kind: 'compare',
          left: current.value,
          operator: 'eq',
          right: value,
        })),
        overflow: false,
      };
    }
    return {
      branches: [negated ? { kind: 'not', operand: current } : current],
      overflow: false,
    };
  };
  return expand(predicate);
}

export function solvePredicate(predicate: Predicate): ConstraintResult {
  type Literal = string | number | boolean | null;
  type Bound = { value: number; inclusive: boolean };
  type Environment = {
    assignments: Map<string, Literal>;
    exclusions: Map<string, Set<Literal>>;
    lowerBounds: Map<string, Bound>;
    upperBounds: Map<string, Bound>;
    conditional: boolean;
  };

  const initial = (): Environment => ({
    assignments: new Map(),
    exclusions: new Map(),
    lowerBounds: new Map(),
    upperBounds: new Map(),
    conditional: false,
  });
  const clone = (environment: Environment): Environment => ({
    assignments: new Map(environment.assignments),
    exclusions: new Map([...environment.exclusions].map(([key, values]) => [key, new Set(values)])),
    lowerBounds: new Map(environment.lowerBounds),
    upperBounds: new Map(environment.upperBounds),
    conditional: environment.conditional,
  });
  const inverted = { eq: 'neq', neq: 'eq', gt: 'lte', gte: 'lt', lt: 'gte', lte: 'gt' } as const;

  const withinBounds = (environment: Environment, path: string, value: Literal): boolean => {
    const lower = environment.lowerBounds.get(path);
    const upper = environment.upperBounds.get(path);
    if ((lower || upper) && typeof value !== 'number') return false;
    if (typeof value !== 'number') return true;
    if (lower && (value < lower.value || (value === lower.value && !lower.inclusive))) return false;
    if (upper && (value > upper.value || (value === upper.value && !upper.inclusive))) return false;
    return true;
  };

  const setEqual = (environment: Environment, path: string, value: Literal): boolean => {
    if (environment.assignments.has(path) && environment.assignments.get(path) !== value) return false;
    if (environment.exclusions.get(path)?.has(value)) return false;
    if (!withinBounds(environment, path, value)) return false;
    environment.assignments.set(path, value);
    return true;
  };

  const setNotEqual = (environment: Environment, path: string, value: Literal): boolean => {
    if (environment.assignments.has(path) && environment.assignments.get(path) === value) return false;
    const values = environment.exclusions.get(path) ?? new Set<Literal>();
    values.add(value);
    environment.exclusions.set(path, values);
    if (typeof value === 'boolean' && !environment.assignments.has(path)) {
      environment.assignments.set(path, !value);
    }
    return boundsConsistent(environment, path);
  };

  const strongerLower = (left: Bound | undefined, right: Bound): Bound => {
    if (!left || right.value > left.value) return right;
    if (right.value < left.value) return left;
    return { value: left.value, inclusive: left.inclusive && right.inclusive };
  };
  const strongerUpper = (left: Bound | undefined, right: Bound): Bound => {
    if (!left || right.value < left.value) return right;
    if (right.value > left.value) return left;
    return { value: left.value, inclusive: left.inclusive && right.inclusive };
  };

  const boundsConsistent = (environment: Environment, path: string): boolean => {
    const lower = environment.lowerBounds.get(path);
    const upper = environment.upperBounds.get(path);
    if (lower && upper && (lower.value > upper.value || (lower.value === upper.value && (!lower.inclusive || !upper.inclusive)))) return false;
    if (lower && upper && lower.value === upper.value && lower.inclusive && upper.inclusive
      && environment.exclusions.get(path)?.has(lower.value)) return false;
    if (environment.assignments.has(path) && !withinBounds(environment, path, environment.assignments.get(path)!)) return false;
    return true;
  };

  const setBound = (environment: Environment, path: string, operator: 'gt' | 'gte' | 'lt' | 'lte', value: number): boolean => {
    if (operator === 'gt' || operator === 'gte') {
      environment.lowerBounds.set(path, strongerLower(environment.lowerBounds.get(path), { value, inclusive: operator === 'gte' }));
    } else {
      environment.upperBounds.set(path, strongerUpper(environment.upperBounds.get(path), { value, inclusive: operator === 'lte' }));
    }
    return boundsConsistent(environment, path);
  };

  const solve = (current: Predicate, environment: Environment, negated = false): Environment[] => {
    if (current.kind === 'constant') return (negated ? !current.value : current.value) ? [environment] : [];
    if (current.kind === 'opaque') {
      environment.conditional = true;
      return [environment];
    }
    if (current.kind === 'not') return solve(current.operand, environment, !negated);
    if (current.kind === 'all' || current.kind === 'any') {
      const conjunction = (current.kind === 'all') !== negated;
      if (conjunction) {
        let environments = [environment];
        for (const operand of current.operands) {
          environments = environments.flatMap((candidate) => solve(operand, candidate, negated));
          if (!environments.length) break;
        }
        return environments;
      }
      return current.operands.flatMap((operand) => solve(operand, clone(environment), negated));
    }
    if (current.kind === 'exists') {
      if (current.value.kind !== 'path') {
        environment.conditional = true;
        return [environment];
      }
      return setEqual(environment, current.value.path, !negated) ? [environment] : [];
    }
    if (current.kind === 'member-of') {
      if (current.value.kind !== 'path' || current.values.some((value) => value.kind !== 'literal')) {
        environment.conditional = true;
        return [environment];
      }
      const memberPath = current.value.path;
      const values = current.values.map((value) => value.kind === 'literal' ? value.value : null);
      if (negated) return values.every((value) => setNotEqual(environment, memberPath, value)) ? [environment] : [];
      return values.flatMap((value) => {
        const candidate = clone(environment);
        return setEqual(candidate, memberPath, value) ? [candidate] : [];
      });
    }
    if (current.kind === 'compare') {
      if (current.left.kind !== 'path' || current.right.kind !== 'literal') {
        environment.conditional = true;
        return [environment];
      }
      const operator = negated ? inverted[current.operator] : current.operator;
      if (operator === 'eq') return setEqual(environment, current.left.path, current.right.value) ? [environment] : [];
      if (operator === 'neq') return setNotEqual(environment, current.left.path, current.right.value) ? [environment] : [];
      if (typeof current.right.value !== 'number') {
        environment.conditional = true;
        return [environment];
      }
      return setBound(environment, current.left.path, operator, current.right.value) ? [environment] : [];
    }
    environment.conditional = true;
    return [environment];
  };

  const solutions = solve(predicate, initial());
  if (!solutions.length) return { status: 'unsatisfiable', assignments: {}, reason: 'contradictory supported constraints' };
  const selected = solutions.find((environment) => !environment.conditional) ?? solutions[0]!;
  for (const path of new Set([...selected.lowerBounds.keys(), ...selected.upperBounds.keys()])) {
    if (selected.assignments.has(path)) continue;
    const representative = representativeNumber(selected, path);
    if (representative !== undefined) selected.assignments.set(path, representative);
  }
  const assignments = Object.fromEntries(selected.assignments);
  return { status: selected.conditional ? 'conditional' : 'satisfiable', assignments };

  function representativeNumber(environment: Environment, path: string): number | undefined {
    const lower = environment.lowerBounds.get(path);
    const upper = environment.upperBounds.get(path);
    const candidates: number[] = [];
    if (lower) candidates.push(lower.inclusive ? lower.value : lower.value + 1);
    if (upper) candidates.push(upper.inclusive ? upper.value : upper.value - 1);
    if (lower && upper) candidates.push((lower.value + upper.value) / 2);
    const excluded = environment.exclusions.get(path);
    return candidates.find((candidate) => (
      Number.isFinite(candidate)
      && withinBounds(environment, path, candidate)
      && !excluded?.has(candidate)
    ));
  }
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
