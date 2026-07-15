import { parse } from 'java-parser';
import { stableId } from '../core/stable.js';
import { allPredicates, predicateFromExpression, TRUE } from '../ir/predicates.js';
import type {
  Diagnostic,
  InputConstraint,
  JavaAuthorizationFact,
  JavaEndpointFact,
  PermissionFact,
  Predicate,
  SourceRef,
  TerminalEffectFact,
  ValueRef,
} from '../ir/model.js';
import type { SourceFile } from './source.js';

export interface JavaExtraction {
  endpoints: JavaEndpointFact[];
  validations: InputConstraint[];
  permissions: PermissionFact[];
  effects: TerminalEffectFact[];
  diagnostics: Diagnostic[];
}

interface AnnotationCandidate {
  text: string;
  line: number;
}

interface MethodCandidate {
  name: string;
  requestType?: string;
  responseType?: string;
  line: number;
  annotations: AnnotationCandidate[];
  body: string;
  validationActivation: ValidationActivation;
}

type ValidationActivation =
  | { status: 'active'; sourceExpression: string }
  | { status: 'inactive' }
  | { status: 'conditional'; sourceExpression: string; reason: string };

export function extractJava(files: SourceFile[]): JavaExtraction {
  const endpoints: JavaEndpointFact[] = [];
  const validations: InputConstraint[] = [];
  const permissions: PermissionFact[] = [];
  const effects: TerminalEffectFact[] = [];
  const diagnostics: Diagnostic[] = [];

  const javaFiles = files.filter((file) => file.language === 'java');
  const validationByType = new Map<string, InputConstraint[]>();
  const enumValuesByType = new Map<string, string[]>();
  const ambiguousTypes = new Set<string>();
  const ambiguousEnums = new Set<string>();
  const methodsByFile = new Map(javaFiles.map((file) => [file.relativePath, extractMethods(file)]));
  const requestTypes = new Set([...methodsByFile.values()].flatMap((methods) => (
    methods.flatMap((method) => method.requestType ? [method.requestType] : [])
  )));

  for (const file of javaFiles) {
    const declaration = file.contents.match(/\benum\s+(\w+)\s*\{([\s\S]*?)\}/);
    if (!declaration?.[1] || !declaration[2]) continue;
    const constants = declaration[2]
      .split(';')[0]!
      .split(',')
      .map((value) => value.trim().match(/^([A-Z][A-Z0-9_]*)/)?.[1])
      .filter((value): value is string => Boolean(value));
    if (constants.length) {
      if (enumValuesByType.has(declaration[1])) {
        enumValuesByType.delete(declaration[1]);
        ambiguousEnums.add(declaration[1]);
      } else if (!ambiguousEnums.has(declaration[1])) enumValuesByType.set(declaration[1], constants);
    }
  }

  for (const file of javaFiles) {
    try {
      parse(file.contents);
    } catch (error) {
      diagnostics.push({
        code: 'JAVA_PARSE_FAILED',
        severity: 'warning',
        message: `Java syntax validation failed for ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        scope: file.relativePath,
      });
    }

    const className = file.contents.match(/\b(?:class|record)\s+(\w+)/)?.[1] ?? file.relativePath.split('/').pop()?.replace(/\.java$/, '') ?? 'UnknownType';
    const typeValidations = [
      ...extractValidations(file, className),
      ...(requestTypes.has(className) ? extractTypeConstraints(file, className, enumValuesByType) : []),
    ];
    validations.push(...typeValidations);
    if (validationByType.has(className)) {
      validationByType.delete(className);
      ambiguousTypes.add(className);
    } else if (!ambiguousTypes.has(className)) validationByType.set(className, typeValidations);
  }

  for (const file of javaFiles) {
    const className = file.contents.match(/\bclass\s+(\w+)/)?.[1] ?? file.relativePath.split('/').pop()?.replace(/\.java$/, '') ?? 'UnknownController';
    const classPrefix = classMapping(file.contents);
    const classSecurity = classSecurityAnnotations(file);
    const methods = methodsByFile.get(file.relativePath) ?? extractMethods(file);

    for (const candidate of methods) {
      const mapping = mappingFromAnnotations(candidate.annotations);
      if (!mapping) continue;
      const endpointPath = normalizeRoute(`${classPrefix}/${mapping.path}`);
      const endpointId = stableId('java-endpoint', `${mapping.method}:${endpointPath}:${className}.${candidate.name}`);
      const authorization = extractAuthorization(file, candidate, classSecurity);
      const endpointPermissionIds: string[] = [];

      for (const authority of authorization.authorities) {
        const permission: PermissionFact = {
          id: stableId('permission', `backend:${authority}:${file.relativePath}:${candidate.line}`),
          authority,
          layer: 'backend',
          sourceRef: authorization.fact.sourceRefs[0] ?? ref(file, candidate.line, candidate.name, authorization.fact.sourceExpression),
        };
        permissions.push(permission);
        endpointPermissionIds.push(permission.id);
      }
      if (authorization.fact.status === 'conditional') {
        diagnostics.push({
          code: 'JAVA_AUTHORIZATION_CONDITIONAL',
          severity: 'warning',
          message: `${className}.${candidate.name} has an authorization expression that cannot be reduced to a literal conjunction of hasAuthority/hasRole checks. Actor and flow execution require review.`,
          evidenceRefs: [endpointId],
          scope: file.relativePath,
        });
      }

      const entity = inferEntity(candidate.requestType, className, endpointPath);
      const directEffects = extractEffects(file, candidate, mapping.method, entity);
      const delegatedTarget = directEffects.every((effect) => effect.kind === 'unknown-mutation')
        ? resolveDelegatedMethod(javaFiles, file, candidate)
        : undefined;
      const delegatedEffects = delegatedTarget
        ? extractEffects(delegatedTarget.file, delegatedTarget.method, mapping.method, entity).filter((effect) => effect.kind !== 'unknown-mutation')
        : [];
      const methodEffects = delegatedEffects.length ? delegatedEffects : directEffects;
      const domainGuard = allPredicates([
        extractDomainGuard(file, candidate),
        ...(delegatedEffects.length && delegatedTarget
          ? [extractDomainGuard(delegatedTarget.file, delegatedTarget.method)]
          : []),
        ...(candidate.requestType && (ambiguousTypes.has(candidate.requestType) || ambiguousEnums.has(candidate.requestType))
          ? [{
              kind: 'opaque' as const,
              sourceExpression: `ambiguous-java-type:${candidate.requestType}`,
              reason: `Multiple Java packages declare ${candidate.requestType}; simple-name request type resolution is not exact.`,
            }]
          : []),
        ...(candidate.validationActivation.status === 'conditional'
          ? [{
              kind: 'opaque' as const,
              sourceExpression: candidate.validationActivation.sourceExpression,
              reason: candidate.validationActivation.reason,
            }]
          : []),
      ]);
      effects.push(...methodEffects);
      if (methodEffects.some((effect) => effect.kind === 'unknown-mutation')) {
        diagnostics.push({
          code: 'TERMINAL_EFFECT_UNRESOLVED',
          severity: 'warning',
          message: `${className}.${candidate.name} is mutating, but no concrete persistence, state transition, deletion or external command was resolved. Successful behavior remains conditional.`,
          evidenceRefs: methodEffects.map((effect) => effect.id),
          scope: file.relativePath,
        });
      }
      if (domainGuard.kind === 'opaque') {
        diagnostics.push({
          code: 'JAVA_DOMAIN_GUARD_CONDITIONAL',
          severity: 'warning',
          message: `${className}.${candidate.name} has backend control flow, exception preconditions, or delegated rule checks that are not reducible by the bounded Java guard extractor. The source flow is a conditional candidate, not a proved business happy path.`,
          evidenceRefs: [endpointId],
          scope: file.relativePath,
        });
      }
      if (candidate.validationActivation.status === 'conditional') {
        diagnostics.push({
          code: 'JAVA_VALIDATION_ACTIVATION_CONDITIONAL',
          severity: 'warning',
          message: `${className}.${candidate.name} has request validation activation whose effective groups or cascaded payload semantics are not proved. DTO constraints are not attached as enforced behavior.`,
          evidenceRefs: [endpointId],
          scope: file.relativePath,
        });
      }

      endpoints.push({
        id: endpointId,
        method: mapping.method,
        pathTemplate: endpointPath,
        controller: className,
        handler: candidate.name,
        ...(candidate.requestType ? { requestType: candidate.requestType } : {}),
        ...(candidate.responseType ? { responseType: candidate.responseType } : {}),
        authorization: authorization.fact,
        domainGuard,
        permissionIds: endpointPermissionIds,
        validationIds: candidate.requestType && candidate.validationActivation.status === 'active'
          ? (validationByType.get(candidate.requestType) ?? [])
              .filter(participatesInDefaultValidation)
              .map((validation) => validation.id)
          : [],
        terminalEffectIds: methodEffects.map((effect) => effect.id),
        sourceRef: ref(file, candidate.line, `${className}.${candidate.name}`),
      });
    }
  }

  if (!endpoints.length && javaFiles.length) {
    diagnostics.push({ code: 'NO_JAVA_ENDPOINTS', severity: 'warning', message: 'Java files were found but no Spring-style endpoint mappings were recognized.' });
  }

  return { endpoints, validations, permissions, effects, diagnostics };
}

function extractMethods(file: SourceFile): MethodCandidate[] {
  const lines = file.contents.split(/\r?\n/);
  const methods: MethodCandidate[] = [];
  let annotations: AnnotationCandidate[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith('@')) {
      const annotation = readAnnotation(lines, index);
      annotations.push({ text: annotation.text, line: index + 1 });
      index = annotation.endIndex;
      continue;
    }

    const signatureSource = /\b(?:public|protected|private)\b/.test(trimmed)
      ? readMethodSignature(lines, index)
      : undefined;
    const signature = signatureSource?.text.match(/\b(public|protected|private)\s+(?:(?:static|final|synchronized|native|strictfp|default)\s+)*([\w$<>,?\[\].]+)\s+([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*(?:throws\s+[^{};]+)?\s*\{/);
    if (signature?.[2] && signature[3]) {
      const body = methodBody(lines, signatureSource!.endIndex);
      const requestBinding = requestBindingFromParameters(signature[4] ?? '', annotations);
      methods.push({
        name: signature[3],
        ...(requestBinding.requestType ? { requestType: requestBinding.requestType } : {}),
        responseType: signature[2],
        line: index + 1,
        annotations: [...annotations],
        body,
        validationActivation: requestBinding.validationActivation,
      });
      annotations = [];
      index = signatureSource!.endIndex;
      continue;
    }

    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) annotations = [];
  }
  return methods;
}

function readMethodSignature(
  lines: string[],
  startIndex: number,
  maxLines = 24,
  maxCharacters = 16_384,
): { text: string; endIndex: number } | undefined {
  const parts: string[] = [];
  let parenthesisDepth = 0;
  let sawParenthesis = false;
  let closedParameters = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let blockComment = false;

  for (let index = startIndex; index < lines.length && index < startIndex + maxLines; index += 1) {
    const part = lines[index]!;
    parts.push(part.trim());
    if (parts.reduce((length, value) => length + value.length, 0) > maxCharacters) return undefined;
    let lineComment = false;
    for (let offset = 0; offset < part.length; offset += 1) {
      const character = part[offset]!;
      const next = part[offset + 1];
      if (lineComment) break;
      if (blockComment) {
        if (character === '*' && next === '/') {
          blockComment = false;
          offset += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === '/' && next === '/') {
        lineComment = true;
        continue;
      }
      if (character === '/' && next === '*') {
        blockComment = true;
        offset += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (!sawParenthesis && (character === '{' || character === ';' || character === '=')) return undefined;
      if (character === '(') {
        sawParenthesis = true;
        parenthesisDepth += 1;
      } else if (character === ')' && sawParenthesis) {
        parenthesisDepth -= 1;
        if (parenthesisDepth === 0) closedParameters = true;
      } else if (closedParameters && character === ';') {
        return undefined;
      } else if (closedParameters && character === '{') {
        return { text: parts.join(' ').replace(/\s+/g, ' '), endIndex: index };
      }
    }
  }
  return undefined;
}

function readAnnotation(lines: string[], startIndex: number): { text: string; endIndex: number } {
  const parts: string[] = [];
  let depth = 0;
  let sawParenthesis = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let endIndex = startIndex;

  for (let index = startIndex; index < lines.length; index += 1) {
    const part = lines[index]!.trim();
    parts.push(part);
    endIndex = index;
    for (const character of part) {
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = undefined;
        }
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '(') {
        sawParenthesis = true;
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
      }
    }
    if (!sawParenthesis || (depth <= 0 && !quote)) break;
  }

  return { text: parts.join(' '), endIndex };
}

function classSecurityAnnotations(file: SourceFile): AnnotationCandidate[] {
  const lines = file.contents.split(/\r?\n/);
  let annotations: AnnotationCandidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith('@')) {
      const annotation = readAnnotation(lines, index);
      annotations.push({ text: annotation.text, line: index + 1 });
      index = annotation.endIndex;
      continue;
    }
    if (/\b(?:class|record)\s+\w+/.test(trimmed)) return annotations.filter((annotation) => isSecurityAnnotation(annotation.text));
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    annotations = [];
  }
  return [];
}

function extractAuthorization(
  file: SourceFile,
  candidate: MethodCandidate,
  classAnnotations: AnnotationCandidate[],
): { fact: JavaAuthorizationFact; authorities: string[] } {
  const methodAnnotations = candidate.annotations.filter((annotation) => isSecurityAnnotation(annotation.text));
  const effective = methodAnnotations.length ? methodAnnotations : classAnnotations;
  if (!effective.length) {
    return {
      fact: {
        status: 'conditional',
        sourceExpression: 'unannotated-endpoint',
        reason: 'No endpoint-level permit-all or authorization rule was found; global filters and service/domain authorization were not proved.',
        sourceRefs: [ref(file, candidate.line, candidate.name)],
      },
      authorities: [],
    };
  }

  const sourceExpression = effective.map((annotation) => annotation.text).join(' && ');
  const sourceRefs = effective.map((annotation) => ref(file, annotation.line, candidate.name, annotation.text));
  if (effective.every((annotation) => annotationName(annotation.text) === 'PermitAll')) {
    return { fact: { status: 'anonymous', sourceExpression, sourceRefs }, authorities: [] };
  }
  const parsed = effective.map((annotation) => parseSecurityAnnotation(annotation.text));
  const bodyAuthorization = /\b(?:hasPermission|checkPermission|isOwner|authorize|denyAccessUnless)\s*\(/i.test(candidate.body);
  if (parsed.every((result) => result.status === 'exact') && !bodyAuthorization) {
    return {
      fact: { status: 'exact', sourceExpression, sourceRefs },
      authorities: [...new Set(parsed.flatMap((result) => result.authorities))].sort(),
    };
  }

  return {
    fact: {
      status: 'conditional',
      sourceExpression,
      reason: parsed.find((result) => result.status === 'conditional')?.reason
        ?? (bodyAuthorization
          ? 'In-method authorization or ownership logic was detected but is not reduced by this adapter.'
          : 'Authorization could not be reduced to literal required-all authorities.'),
      sourceRefs,
    },
    authorities: [],
  };
}

const KNOWN_SECURITY_ANNOTATIONS = new Set([
  'PreAuthorize',
  'PostAuthorize',
  'PreFilter',
  'PostFilter',
  'Secured',
  'RolesAllowed',
  'PermitAll',
  'DenyAll',
]);

function annotationName(annotation: string): string | undefined {
  return annotation.match(/^@(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)/)?.[1];
}

function isSecurityAnnotation(annotation: string): boolean {
  const name = annotationName(annotation);
  if (!name) return false;
  return KNOWN_SECURITY_ANNOTATIONS.has(name)
    || /(?:Authoriz|Secured|Roles?Allowed|PermitAll|DenyAll|Permission|Authenticated|AdminOnly|IsAdmin)/i.test(name);
}

type ParsedAuthorization =
  | { status: 'exact'; authorities: string[] }
  | { status: 'conditional'; authorities: []; reason: string };

function parseSecurityAnnotation(annotation: string): ParsedAuthorization {
  if (annotationName(annotation) !== 'PreAuthorize') {
    return {
      status: 'conditional',
      authorities: [],
      reason: `Unsupported security annotation: ${annotationName(annotation) ?? annotation}`,
    };
  }
  const encodedExpression = annotation.match(/\bPreAuthorize\s*\(\s*(?:value\s*=\s*)?"((?:\\.|[^"\\])*)"\s*\)\s*$/s)?.[1];
  if (encodedExpression === undefined) {
    return {
      status: 'conditional',
      authorities: [],
      reason: 'PreAuthorize does not contain one statically readable string expression.',
    };
  }
  const expression = decodeJavaString(encodedExpression);
  const authorities = parseAuthorityConjunction(expression);
  if (!authorities) {
    return {
      status: 'conditional',
      authorities: [],
      reason: 'PreAuthorize is not a literal conjunction of hasAuthority/hasRole checks.',
    };
  }
  return { status: 'exact', authorities };
}

function decodeJavaString(value: string): string {
  return value.replace(/\\([\\"'bfnrt])/g, (_match, escaped: string) => ({
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
  }[escaped] ?? escaped));
}

type SecurityToken =
  | { kind: 'identifier'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'and' }
  | { kind: 'left-parenthesis' }
  | { kind: 'right-parenthesis' };

function tokenizeSecurityExpression(expression: string): SecurityToken[] | undefined {
  const tokens: SecurityToken[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '(') {
      tokens.push({ kind: 'left-parenthesis' });
      index += 1;
      continue;
    }
    if (character === ')') {
      tokens.push({ kind: 'right-parenthesis' });
      index += 1;
      continue;
    }
    if (expression.slice(index, index + 2) === '&&') {
      tokens.push({ kind: 'and' });
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const delimiter = character;
      let value = '';
      let closed = false;
      index += 1;
      while (index < expression.length) {
        const current = expression[index]!;
        if (current === '\\' && index + 1 < expression.length) {
          value += expression[index + 1]!;
          index += 2;
        } else if (current === delimiter) {
          closed = true;
          index += 1;
          break;
        } else {
          value += current;
          index += 1;
        }
      }
      if (!closed) return undefined;
      tokens.push({ kind: 'string', value });
      continue;
    }
    const identifier = expression.slice(index).match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (!identifier) return undefined;
    if (identifier === 'and') tokens.push({ kind: 'and' });
    else tokens.push({ kind: 'identifier', value: identifier });
    index += identifier.length;
  }
  return tokens;
}

function parseAuthorityConjunction(expression: string): string[] | undefined {
  const tokens = tokenizeSecurityExpression(expression);
  if (!tokens?.length) return undefined;
  let index = 0;

  const parseExpression = (): string[] | undefined => {
    const first = parsePrimary();
    if (!first) return undefined;
    const authorities = [...first];
    while (tokens[index]?.kind === 'and') {
      index += 1;
      const next = parsePrimary();
      if (!next) return undefined;
      authorities.push(...next);
    }
    return authorities;
  };

  const parsePrimary = (): string[] | undefined => {
    if (tokens[index]?.kind === 'left-parenthesis') {
      index += 1;
      const nested = parseExpression();
      if (!nested || tokens[index]?.kind !== 'right-parenthesis') return undefined;
      index += 1;
      return nested;
    }
    const call = tokens[index];
    if (call?.kind !== 'identifier' || !['hasAuthority', 'hasRole'].includes(call.value)) return undefined;
    index += 1;
    if (tokens[index]?.kind !== 'left-parenthesis') return undefined;
    index += 1;
    const literal = tokens[index];
    if (literal?.kind !== 'string' || !literal.value) return undefined;
    index += 1;
    if (tokens[index]?.kind !== 'right-parenthesis') return undefined;
    index += 1;
    return [call.value === 'hasRole' ? `ROLE_${literal.value}` : literal.value];
  };

  const authorities = parseExpression();
  if (!authorities || index !== tokens.length) return undefined;
  return [...new Set(authorities)].sort();
}

function resolveDelegatedMethod(
  files: SourceFile[],
  callerFile: SourceFile,
  caller: MethodCandidate,
): { file: SourceFile; method: MethodCandidate } | undefined {
  const calls = [...caller.body.matchAll(/\breturn\s+([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)];
  const matches: Array<{ file: SourceFile; method: MethodCandidate }> = [];
  for (const call of calls) {
    const receiver = call[1];
    const calledMethod = call[2];
    if (!receiver || !calledMethod) continue;
    const receiverType = callerFile.contents.match(new RegExp(`\\b([A-Z][A-Za-z0-9_$]*)\\s+${escapeRegex(receiver)}\\b`))?.[1];
    if (!receiverType) continue;
    const targetFiles = files.filter((file) => (
      file.contents.match(/\b(?:class|record)\s+(\w+)/)?.[1] === receiverType
    ));
    if (targetFiles.length !== 1) continue;
    const targetFile = targetFiles[0]!;
    const target = extractMethods(targetFile).find((candidate) => candidate.name === calledMethod);
    if (!target) continue;
    if (!caller.responseType || !target.responseType || normalizeJavaType(caller.responseType) !== normalizeJavaType(target.responseType)) continue;
    matches.push({ file: targetFile, method: target });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function extractDomainGuard(file: SourceFile, candidate: MethodCandidate): Predicate {
  const body = stripJavaCommentsPreservingLiterals(candidate.body);
  const guards = extractTopLevelThrowGuards(body);
  const successfulPredicates: Predicate[] = [];
  for (const guard of guards) {
    const parsed = normalizeJavaRequestPredicate(
      predicateFromExpression(normalizeJavaGuardExpression(guard.condition)),
    );
    if (parsed.kind === 'opaque') {
      return opaqueDomainGuard(file, candidate, body, guard.start, `if (${guard.condition})`);
    }
    successfulPredicates.push({ kind: 'not', operand: parsed });
  }
  const residual = [...body];
  guards.forEach((guard) => {
    for (let index = guard.start; index < guard.end; index += 1) residual[index] = residual[index] === '\n' ? '\n' : ' ';
  });
  const residualBody = residual.join('');
  const control = residualBody.match(/\b(if|switch|try|catch|for|while|do|throw|assert)\b|\?|\.orElseThrow\s*\(/);
  const namedRuleCall = residualBody.match(/\b(?:validate|verify|check|require|ensure|eligible|authorize|allowed|permitted|exists|ownership|relationship)[A-Za-z0-9_$]*\s*\(/i);
  const unresolved = control ?? namedRuleCall;
  if (!unresolved) return allPredicates(successfulPredicates);
  return opaqueDomainGuard(file, candidate, residualBody, unresolved.index ?? 0, unresolved[0].trim());
}

const JAVA_REQUEST_ROOTS = new Set(['request', 'dto', 'command', 'input']);

function normalizeJavaRequestPredicate(predicate: Predicate): Predicate {
  switch (predicate.kind) {
    case 'not':
      return { ...predicate, operand: normalizeJavaRequestPredicate(predicate.operand) };
    case 'all':
    case 'any':
      return { ...predicate, operands: predicate.operands.map(normalizeJavaRequestPredicate) };
    case 'exists':
      return { ...predicate, value: normalizeJavaRequestValue(predicate.value) };
    case 'compare':
      return {
        ...predicate,
        left: normalizeJavaRequestValue(predicate.left),
        right: normalizeJavaRequestValue(predicate.right),
      };
    case 'member-of':
      return {
        ...predicate,
        value: normalizeJavaRequestValue(predicate.value),
        values: predicate.values.map(normalizeJavaRequestValue),
      };
    case 'constant':
    case 'opaque':
      return predicate;
  }
}

function normalizeJavaRequestValue(value: ValueRef): ValueRef {
  if (value.kind !== 'path') return value;
  const [root, ...segments] = value.path.split('.');
  if (!root || !JAVA_REQUEST_ROOTS.has(root) || segments.length === 0) return value;
  return { ...value, path: segments.join('.') };
}

function opaqueDomainGuard(
  file: SourceFile,
  candidate: MethodCandidate,
  body: string,
  index: number,
  expression: string,
): Predicate {
  const lineOffset = body.slice(0, index).split(/\r?\n/).length - 1;
  const sourceLine = candidate.line + lineOffset;
  return {
    kind: 'opaque',
    sourceExpression: `${file.relativePath}:${sourceLine}:${expression}`,
    reason: 'Backend acceptance control flow or a rule/precondition call was detected, but its successful branch is not reducible by the bounded Java guard extractor.',
  };
}

interface JavaThrowGuard {
  condition: string;
  start: number;
  end: number;
}

function extractTopLevelThrowGuards(body: string): JavaThrowGuard[] {
  const guards: JavaThrowGuard[] = [];
  const matcher = /\bif\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(body))) {
    if (braceDepthAt(body, match.index) !== 1) continue;
    const open = body.indexOf('(', match.index);
    const close = matchingDelimiter(body, open, '(', ')');
    if (close < 0) continue;
    let cursor = close + 1;
    while (/\s/.test(body[cursor] ?? '')) cursor += 1;
    let end: number;
    let statement: string;
    if (body[cursor] === '{') {
      const closingBrace = matchingDelimiter(body, cursor, '{', '}');
      if (closingBrace < 0) continue;
      statement = body.slice(cursor + 1, closingBrace).trim();
      end = closingBrace + 1;
    } else {
      const semicolon = body.indexOf(';', cursor);
      if (semicolon < 0) continue;
      statement = body.slice(cursor, semicolon + 1).trim();
      end = semicolon + 1;
    }
    if (!/^throw\b[\s\S]*;\s*$/.test(statement)) continue;
    guards.push({ condition: body.slice(open + 1, close).trim(), start: match.index, end });
    matcher.lastIndex = end;
  }
  return guards;
}

function normalizeJavaGuardExpression(source: string): string {
  return source
    .replace(/\bObjects\.isNull\s*\(([^()]+)\)/g, '($1 === null)')
    .replace(/\bObjects\.nonNull\s*\(([^()]+)\)/g, '($1 !== null)')
    .replace(/(['"][^'"]*['"])\.equals\s*\(([^()]+)\)/g, '($2 === $1)')
    .replace(/([A-Za-z_$][\w$.]*)\.equals\s*\((['"][^'"]*['"]|[A-Z][\w$]*\.[A-Z][A-Z0-9_]*)\)/g, '($1 === $2)')
    .replace(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.get([A-Z][A-Za-z0-9_$]*)\s*\(\s*\)/g, (_match, root: string, name: string) => `${root}.${name[0]!.toLowerCase()}${name.slice(1)}`)
    .replace(/\b(request|command|dto|input)\.([a-z][A-Za-z0-9_$]*)\s*\(\s*\)/g, '$1.$2')
    .replace(/([=!]==?|[<>]=?)\s*[A-Z][A-Za-z0-9_$]*\.([A-Z][A-Z0-9_]*)\b/g, '$1 "$2"')
    .replace(/\bthis\./g, '')
    .trim();
}

function matchingDelimiter(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function braceDepthAt(source: string, end: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < end; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
  }
  return depth;
}

function stripJavaCommentsPreservingLiterals(source: string): string {
  let result = '';
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        result += '\n';
      } else result += ' ';
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        result += '  ';
        index += 1;
      } else result += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
    } else if (character === '/' && next === '/') {
      lineComment = true;
      result += '  ';
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      result += '  ';
      index += 1;
    } else result += character;
  }
  return result;
}

function normalizeJavaType(value: string): string {
  return value.replace(/\s+/g, '').replace(/^ResponseEntity<(.+)>$/, '$1');
}

function methodBody(lines: string[], startIndex: number): string {
  let depth = 0;
  let started = false;
  const body: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!;
    body.push(line);
    for (const character of line) {
      if (character === '{') {
        depth += 1;
        started = true;
      }
      if (character === '}') depth -= 1;
    }
    if (started && depth <= 0) break;
  }
  return body.join('\n');
}

interface JavaAnnotationUse {
  name: string;
  text: string;
  arguments?: string;
  start: number;
  end: number;
}

interface RequestParameterCandidate {
  requestType?: string;
  annotations: JavaAnnotationUse[];
}

function requestBindingFromParameters(
  parameters: string,
  methodAnnotations: AnnotationCandidate[],
): { requestType?: string; validationActivation: ValidationActivation } {
  const parsed = splitTopLevelJavaParameters(parameters).map((parameter) => {
    const annotations = javaAnnotationUses(parameter);
    const requestType = javaParameterType(parameter, annotations);
    return {
      ...(requestType ? { requestType } : {}),
      annotations,
    } satisfies RequestParameterCandidate;
  });
  const requestBodies = parsed.filter((parameter) => parameter.annotations.some((annotation) => annotation.name === 'RequestBody'));
  const candidates = requestBodies;
  if (candidates.length > 1) {
    return {
      validationActivation: {
        status: 'conditional',
        sourceExpression: candidates.flatMap((candidate) => candidate.annotations.map((annotation) => annotation.text)).join(' && '),
        reason: 'Multiple request-parameter candidates were found; the bounded adapter cannot prove which payload receives Bean Validation.',
      },
    };
  }
  const candidate = candidates[0];
  if (!candidate) return { validationActivation: { status: 'inactive' } };

  const parameterValidation = candidate.annotations.filter((annotation) => (
    annotation.name === 'Valid' || annotation.name === 'Validated'
  ));
  const groupedOrUnsupported = parameterValidation.find((annotation) => annotation.arguments?.trim());
  if (groupedOrUnsupported) {
    return {
      ...(candidate.requestType ? { requestType: candidate.requestType } : {}),
      validationActivation: {
        status: 'conditional',
        sourceExpression: groupedOrUnsupported.text,
        reason: 'Validation groups or annotation arguments are not reduced, so attaching every DTO constraint would invent enforcement.',
      },
    };
  }
  const candidateIndex = parsed.indexOf(candidate);
  const resultParameter = parsed[candidateIndex + 1]?.requestType;
  if (parameterValidation.length && (resultParameter === 'BindingResult' || resultParameter === 'Errors')) {
    return {
      ...(candidate.requestType ? { requestType: candidate.requestType } : {}),
      validationActivation: {
        status: 'conditional',
        sourceExpression: `${parameterValidation.map((annotation) => annotation.text).join(' && ')} -> ${resultParameter}`,
        reason: `${resultParameter} receives validation failures, so the bounded adapter cannot claim DTO constraints are enforced before controller effects.`,
      },
    };
  }
  if (parameterValidation.length) {
    return {
      ...(candidate.requestType ? { requestType: candidate.requestType } : {}),
      validationActivation: {
        status: 'active',
        sourceExpression: parameterValidation.map((annotation) => annotation.text).join(' && '),
      },
    };
  }

  const methodValidation = methodAnnotations.filter((annotation) => {
    const name = annotationName(annotation.text);
    return name === 'Valid' || name === 'Validated';
  });
  if (methodValidation.length) {
    return {
      ...(candidate.requestType ? { requestType: candidate.requestType } : {}),
      validationActivation: {
        status: 'conditional',
        sourceExpression: methodValidation.map((annotation) => annotation.text).join(' && '),
        reason: 'A method-level validation annotation does not by itself prove cascaded validation of this request-body object across Spring versions and method-validation configuration.',
      },
    };
  }
  return {
    ...(candidate.requestType ? { requestType: candidate.requestType } : {}),
    validationActivation: { status: 'inactive' },
  };
}

function participatesInDefaultValidation(validation: InputConstraint): boolean {
  return !/\bgroups?\s*=/.test(validation.sourceRef.excerpt ?? '');
}

function javaAnnotationUses(source: string): JavaAnnotationUse[] {
  const annotations: JavaAnnotationUse[] = [];
  const matcher = /@(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source))) {
    let end = matcher.lastIndex;
    while (/\s/.test(source[end] ?? '')) end += 1;
    let argumentsBody: string | undefined;
    if (source[end] === '(') {
      const close = matchingDelimiter(source, end, '(', ')');
      if (close < 0) {
        annotations.push({
          name: annotationName(match[0]) ?? match[0].slice(1),
          text: source.slice(match.index),
          arguments: source.slice(end + 1),
          start: match.index,
          end: source.length,
        });
        break;
      }
      argumentsBody = source.slice(end + 1, close);
      end = close + 1;
    }
    annotations.push({
      name: annotationName(match[0]) ?? match[0].slice(1),
      text: source.slice(match.index, end),
      ...(argumentsBody !== undefined ? { arguments: argumentsBody } : {}),
      start: match.index,
      end,
    });
    matcher.lastIndex = end;
  }
  return annotations;
}

function javaParameterType(parameter: string, annotations: JavaAnnotationUse[]): string | undefined {
  const characters = [...parameter];
  for (const annotation of annotations) {
    for (let index = annotation.start; index < annotation.end; index += 1) characters[index] = ' ';
  }
  const stripped = characters.join('').replace(/\bfinal\b/g, ' ').trim();
  const declaration = stripped.match(/^([\s\S]*\S)\s+[A-Za-z_$][\w$]*$/);
  if (!declaration?.[1]) return undefined;
  const normalized = declaration[1].replace(/\s+/g, '').replace(/(?:\.\.\.|\[\])+$/g, '');
  const outerType = normalized.split('<')[0];
  return outerType?.split('.').at(-1) || undefined;
}

function splitTopLevelJavaParameters(parameters: string): string[] {
  const results: string[] = [];
  let start = 0;
  let parentheses = 0;
  let angles = 0;
  let braces = 0;
  let brackets = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < parameters.length; index += 1) {
    const character = parameters[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    else if (character === '<') angles += 1;
    else if (character === '>') angles = Math.max(0, angles - 1);
    else if (character === '{') braces += 1;
    else if (character === '}') braces = Math.max(0, braces - 1);
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets = Math.max(0, brackets - 1);
    else if (character === ',' && parentheses === 0 && angles === 0 && braces === 0 && brackets === 0) {
      if (parameters.slice(start, index).trim()) results.push(parameters.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (parameters.slice(start).trim()) results.push(parameters.slice(start).trim());
  return results;
}

function classMapping(contents: string): string {
  const classIndex = contents.search(/\bclass\s+\w+/);
  const beforeClass = classIndex >= 0 ? contents.slice(Math.max(0, classIndex - 800), classIndex) : contents;
  const mappings = [...beforeClass.matchAll(/@RequestMapping\s*\(([^)]*)\)/g)];
  return annotationPath(mappings.at(-1)?.[1] ?? '');
}

function mappingFromAnnotations(annotations: AnnotationCandidate[]): { method: string; path: string } | undefined {
  for (const annotation of annotations) {
    const direct = annotation.text.match(/@(Get|Post|Put|Patch|Delete)Mapping\s*(?:\((.*)\))?/);
    if (direct?.[1]) return { method: direct[1].toUpperCase(), path: annotationPath(direct[2] ?? '') };
    const generic = annotation.text.match(/@RequestMapping\s*\((.*)\)/);
    if (generic?.[1]) {
      const method = generic[1].match(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/)?.[1];
      if (method) return { method, path: annotationPath(generic[1]) };
    }
  }
  return undefined;
}

function annotationPath(body: string): string {
  return body.match(/(?:value|path)\s*=\s*['"]([^'"]+)['"]/)?.[1]
    ?? body.match(/['"]([^'"]+)['"]/)?.[1]
    ?? '';
}

function extractValidations(file: SourceFile, className: string): InputConstraint[] {
  const lines = file.contents.split(/\r?\n/);
  const results: InputConstraint[] = extractRecordValidations(file, className);
  let annotations: { line: number; text: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith('@')) {
      annotations.push({ line: index + 1, text: trimmed });
      continue;
    }
    const field = trimmed.match(/\b(?:private|protected|public)\s+[\w<>,?\[\].]+\s+(\w+)\s*[;=]/)?.[1];
    if (field && annotations.length) {
      for (const annotation of annotations) {
        const parsedConstraints = validationsFromAnnotation(annotation.text);
        for (const parsed of parsedConstraints) {
          results.push({
            id: stableId('validation', `${file.relativePath}:${className}.${field}:${annotation.text}:${parsed.kind}:${String(parsed.value)}`),
            fieldPath: `${className}.${field}`,
            kind: parsed.kind,
            ...(parsed.value !== undefined ? { value: parsed.value } : {}),
            ...(parsed.domain ? { domain: parsed.domain } : {}),
            ...(parsed.message ? { message: parsed.message } : {}),
            sourceRef: ref(file, annotation.line, `${className}.${field}`, annotation.text),
          });
        }
      }
      annotations = [];
      continue;
    }
    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) annotations = [];
  }
  return results;
}

function extractRecordValidations(file: SourceFile, className: string): InputConstraint[] {
  const header = file.contents.match(new RegExp(`\\brecord\\s+${escapeRegex(className)}\\s*\\(([\\s\\S]*?)\\)\\s*\\{`));
  if (!header?.[1] || header.index === undefined) return [];
  const components = splitJavaComponents(header[1]);
  return components.flatMap((component) => {
    const annotations = [...component.matchAll(/@[A-Za-z_$][\w$.]*(?:\s*\([^)]*\))?/g)].map((match) => match[0]);
    const withoutAnnotations = component.replace(/@[A-Za-z_$][\w$.]*(?:\s*\([^)]*\))?/g, ' ').trim();
    const field = withoutAnnotations.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1];
    if (!field || !annotations.length) return [];
    const line = file.contents.slice(0, header.index! + header[0].indexOf(component)).split(/\r?\n/).length;
    return annotations.flatMap((annotation) => validationsFromAnnotation(annotation).map((parsed) => ({
      id: stableId('validation', `${file.relativePath}:${className}.${field}:${annotation}:${parsed.kind}:${String(parsed.value)}`),
      fieldPath: `${className}.${field}`,
      kind: parsed.kind,
      ...(parsed.value !== undefined ? { value: parsed.value } : {}),
      ...(parsed.domain ? { domain: parsed.domain } : {}),
      ...(parsed.message ? { message: parsed.message } : {}),
      sourceRef: ref(file, line, `${className}.${field}`, annotation),
    })));
  });
}

function extractTypeConstraints(
  file: SourceFile,
  className: string,
  enumValuesByType: Map<string, string[]>,
): InputConstraint[] {
  const declarations: Array<{ field: string; type: string; line: number; annotations: string[] }> = [];
  const lines = file.contents.split(/\r?\n/);
  let annotations: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith('@')) {
      annotations.push(trimmed);
      continue;
    }
    const field = trimmed.match(/\b(?:private|protected|public)\s+(?:static\s+)?(?:final\s+)?([\w$<>,?\[\].]+)\s+(\w+)\s*[;=]/);
    if (field?.[1] && field[2]) {
      declarations.push({ field: field[2], type: field[1], line: index + 1, annotations: [...annotations] });
      annotations = [];
      continue;
    }
    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) annotations = [];
  }

  const recordHeader = file.contents.match(new RegExp(`\\brecord\\s+${escapeRegex(className)}\\s*\\(([\\s\\S]*?)\\)\\s*\\{`));
  if (recordHeader?.[1] && recordHeader.index !== undefined) {
    for (const component of splitJavaComponents(recordHeader[1])) {
      const componentAnnotations = [...component.matchAll(/@[A-Za-z_$][\w$.]*(?:\s*\([^)]*\))?/g)].map((match) => match[0]);
      const declaration = component.replace(/@[A-Za-z_$][\w$.]*(?:\s*\([^)]*\))?/g, ' ').trim()
        .match(/^([\w$<>,?\[\].]+)\s+([A-Za-z_$][\w$]*)$/);
      if (!declaration?.[1] || !declaration[2]) continue;
      const offset = recordHeader[0].indexOf(component);
      const line = file.contents.slice(0, recordHeader.index + Math.max(0, offset)).split(/\r?\n/).length;
      declarations.push({ field: declaration[2], type: declaration[1], line, annotations: componentAnnotations });
    }
  }

  return declarations.flatMap((declaration) => {
    const source = ref(file, declaration.line, `${className}.${declaration.field}`, declaration.type);
    const constraints = constraintsForJavaType(declaration.type, enumValuesByType).map((constraint) => ({
      id: stableId('validation', `${file.relativePath}:${className}.${declaration.field}:java-type:${declaration.type}:${constraint.kind}:${String(constraint.value)}`),
      fieldPath: `${className}.${declaration.field}`,
      ...constraint,
      sourceRef: source,
    }));
    if (declaration.annotations.some((annotation) => /@(JsonDeserialize|JsonCreator|JsonTypeInfo|JsonFormat)\b/.test(annotation))) {
      constraints.push({
        id: stableId('validation', `${file.relativePath}:${className}.${declaration.field}:custom-json-binding`),
        fieldPath: `${className}.${declaration.field}`,
        kind: 'opaque',
        domain: 'type',
        message: 'Custom Jackson deserialization for this field is outside the supported type proof.',
        sourceRef: source,
      });
    }
    return constraints;
  });
}

function constraintsForJavaType(
  declaredType: string,
  enumValuesByType: Map<string, string[]>,
): Array<Pick<InputConstraint, 'kind' | 'value' | 'domain' | 'message'>> {
  const type = declaredType.replace(/\s+/g, '');
  const simple = type.replace(/^java\.lang\./, '');
  const enumValues = enumValuesByType.get(simple);
  if (enumValues) return [{ kind: 'enum', value: enumValues, domain: 'value-set' }];
  if (simple === 'String' || simple === 'CharSequence') return [{ kind: 'type', value: 'string', domain: 'type' }];
  if (['char', 'Character'].includes(simple)) return [
    { kind: 'type', value: 'string', domain: 'type' },
    { kind: 'min', value: 1, domain: 'length' },
    { kind: 'max', value: 1, domain: 'length' },
  ];
  if (['byte', 'Byte'].includes(simple)) return integerType(-128, 127);
  if (['short', 'Short'].includes(simple)) return integerType(-32768, 32767);
  if (['int', 'Integer'].includes(simple)) return integerType(-2147483648, 2147483647);
  if (['long', 'Long'].includes(simple)) return integerType(-9007199254740991, 9007199254740991);
  if (simple === 'BigInteger') return [{ kind: 'type', value: 'integer', domain: 'type' }];
  if (['float', 'Float', 'double', 'Double', 'BigDecimal'].includes(simple)) {
    return [{ kind: 'type', value: 'number', domain: 'type' }];
  }
  if (['boolean', 'Boolean'].includes(simple)) return [{ kind: 'type', value: 'boolean', domain: 'type' }];
  return [{
    kind: 'opaque',
    domain: 'type',
    message: `Java request type ${declaredType} requires a deserialization adapter before value compatibility is proved.`,
  }];
}

function integerType(minimum: number, maximum: number): Array<Pick<InputConstraint, 'kind' | 'value' | 'domain'>> {
  return [
    { kind: 'type', value: 'integer', domain: 'type' },
    { kind: 'min', value: minimum, domain: 'numeric' },
    { kind: 'max', value: maximum, domain: 'numeric' },
  ];
}

function splitJavaComponents(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '<' || character === '[') depth += 1;
    else if (character === ')' || character === '>' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function validationsFromAnnotation(annotation: string): { kind: InputConstraint['kind']; value?: string | number | boolean; domain?: InputConstraint['domain']; message?: string }[] {
  const message = annotation.match(/message\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (/@(NotNull|NotBlank|NotEmpty)\b/.test(annotation)) return [{ kind: 'required', value: true, ...(message ? { message } : {}) }];
  const min = annotation.match(/@Min\s*\(\s*(?:value\s*=\s*)?(\d+)/)?.[1];
  if (min) return [{ kind: 'min', value: Number(min), domain: 'numeric', ...(message ? { message } : {}) }];
  const max = annotation.match(/@Max\s*\(\s*(?:value\s*=\s*)?(\d+)/)?.[1];
  if (max) return [{ kind: 'max', value: Number(max), domain: 'numeric', ...(message ? { message } : {}) }];
  const size = annotation.match(/@Size\s*\(([^)]*)\)/)?.[1];
  if (size) {
    const minimum = size.match(/min\s*=\s*(\d+)/)?.[1];
    const maximum = size.match(/max\s*=\s*(\d+)/)?.[1];
    return [
      ...(minimum ? [{ kind: 'min' as const, value: Number(minimum), domain: 'length' as const, ...(message ? { message } : {}) }] : []),
      ...(maximum ? [{ kind: 'max' as const, value: Number(maximum), domain: 'length' as const, ...(message ? { message } : {}) }] : []),
    ];
  }
  const pattern = annotation.match(/@Pattern\s*\([^)]*regexp\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (pattern) return [{ kind: 'pattern', value: pattern, domain: 'format', ...(message ? { message } : {}) }];
  if (/^@(Json|Schema|Deprecated|Override|SuppressWarnings)\b/.test(annotation)) return [];
  return [{
    kind: 'opaque',
    domain: 'unknown',
    message: `Unsupported validation annotation ${annotation.match(/^@[^\s(]+/)?.[0] ?? annotation}.`,
  }];
}

function extractEffects(file: SourceFile, candidate: MethodCandidate, method: string, entity: string): TerminalEffectFact[] {
  const results: TerminalEffectFact[] = [];
  const statusMatch = topLevelMatch(candidate.body, /\b([A-Za-z_$][\w$]*)\.setStatus\s*\(\s*(?:[A-Za-z_$][\w$]*\.)?([A-Z][A-Z0-9_]*)/);
  const statusEntity = statusMatch?.[1] ? entityForExpression(file, candidate, statusMatch[1]) : undefined;
  const status = statusMatch?.[2];
  if (status && statusEntity && sameEntity(statusEntity, entity)) {
    results.push({
      id: stableId('terminal-effect', `${file.relativePath}:${candidate.name}:${entity}:state:${status}`),
      entity,
      kind: 'state-changed',
      toState: status,
      sourceRef: ref(file, candidate.line, candidate.name, `state → ${status}`),
    });
  }
  const persistence = topLevelMatch(candidate.body, /\b([A-Za-z_$][\w$]*)\.(?:save|persist)\s*\(\s*(new\s+[A-Z][\w$]*|[A-Za-z_$][\w$]*)/);
  const persistedEntity = persistence?.[2]
    ? entityForExpression(file, candidate, persistence[2], persistence[1])
    : undefined;
  if (persistence && persistedEntity && sameEntity(persistedEntity, entity) && !results.length) {
    results.push({
      id: stableId('terminal-effect', `${file.relativePath}:${candidate.name}:${entity}:${method}`),
      entity,
      kind: method === 'POST' ? 'entity-created' : 'state-changed',
      sourceRef: ref(file, candidate.line, candidate.name, `${method} persists ${entity}`),
    });
  }
  const deletion = topLevelMatch(candidate.body, /\b([A-Za-z_$][\w$]*)\.(?:delete|remove)\s*\(\s*(new\s+[A-Z][\w$]*|[A-Za-z_$][\w$]*)/);
  const deletedEntity = deletion?.[2] ? entityForExpression(file, candidate, deletion[2], deletion[1]) : undefined;
  if (method === 'DELETE' && deletion && deletedEntity && sameEntity(deletedEntity, entity) && !results.length) {
    results.push({
      id: stableId('terminal-effect', `${file.relativePath}:${candidate.name}:${entity}:deleted`),
      entity,
      kind: 'entity-deleted',
      sourceRef: ref(file, candidate.line, candidate.name),
    });
  }
  const publication = topLevelMatch(candidate.body, /\b([A-Za-z_$][\w$]*)\.(?:publish|send)\s*\(\s*(new\s+[A-Z][\w$]*|[A-Za-z_$][\w$]*)/);
  const publishedEntity = publication?.[2] ? entityForExpression(file, candidate, publication[2]) : undefined;
  if (publication && publishedEntity && sameEntity(publishedEntity, entity) && !results.length) {
    results.push({
      id: stableId('terminal-effect', `${file.relativePath}:${candidate.name}:${entity}:external`),
      entity,
      kind: 'external-command',
      sourceRef: ref(file, candidate.line, candidate.name),
    });
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !results.length) {
    results.push({
      id: stableId('terminal-effect', `${file.relativePath}:${candidate.name}:${entity}:unknown`),
      entity,
      kind: 'unknown-mutation',
      sourceRef: ref(file, candidate.line, candidate.name),
    });
  }
  return results;
}

function entityForExpression(
  file: SourceFile,
  candidate: MethodCandidate,
  expression: string,
  repositoryReceiver?: string,
): string | undefined {
  const constructed = expression.match(/^new\s+([A-Z][\w$]*)/)?.[1];
  if (constructed) return constructed;
  const identifier = expression.trim();
  const declared = candidate.body.match(new RegExp(`\\b([A-Z][A-Za-z0-9_$]*)\\s+${escapeRegex(identifier)}\\b`))?.[1];
  if (declared) return declared;
  if (!repositoryReceiver) return undefined;
  const repositoryType = file.contents.match(new RegExp(`\\b([A-Z][A-Za-z0-9_$]*)Repository\\s+${escapeRegex(repositoryReceiver)}\\b`))?.[1];
  if (repositoryType) return repositoryType;
  return file.contents.match(new RegExp(`\\b(?:Repository|CrudRepository|JpaRepository)\\s*<\\s*([A-Z][A-Za-z0-9_$]*)[^>]*>\\s+${escapeRegex(repositoryReceiver)}\\b`))?.[1];
}

function sameEntity(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(?:Entity|Model)$/i, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function topLevelMatch(body: string, pattern: RegExp): RegExpMatchArray | undefined {
  const sanitized = sanitizeJavaBody(body);
  const flags = pattern.flags.replace('g', '');
  const match = new RegExp(pattern.source, flags).exec(sanitized);
  if (!match || match.index === undefined) return undefined;
  let depth = 0;
  for (let index = 0; index < match.index; index += 1) {
    if (sanitized[index] === '{') depth += 1;
    if (sanitized[index] === '}') depth -= 1;
  }
  return depth === 1 ? match : undefined;
}

function sanitizeJavaBody(source: string): string {
  let result = '';
  let quote: '"' | "'" | undefined;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (current === '\n') {
        lineComment = false;
        result += '\n';
      } else result += ' ';
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        result += '  ';
        index += 1;
      } else result += current === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = undefined;
      result += current === '\n' ? '\n' : ' ';
      continue;
    }
    if (current === '/' && next === '/') {
      lineComment = true;
      result += '  ';
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      result += '  ';
      index += 1;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      result += ' ';
      continue;
    }
    result += current;
  }
  return result;
}

function inferEntity(requestType: string | undefined, controller: string, endpointPath: string): string {
  const fromRequest = requestType?.replace(/(?:Create|Update|Submit|Joint|Personal)?Request$/, '');
  if (fromRequest && fromRequest !== requestType) return fromRequest || requestType!;
  const fromController = controller.replace(/Controller$/, '');
  if (fromController !== controller) return fromController;
  return endpointPath.split('/').filter(Boolean).at(-1)?.replace(/\{.*\}/, '') || 'Entity';
}

function normalizeRoute(value: string): string {
  const normalized = value.replace(/\/+/g, '/').replace(/\/$/, '');
  return normalized.startsWith('/') ? normalized || '/' : `/${normalized}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ref(file: SourceFile, line: number, symbol?: string, excerpt?: string): SourceRef {
  return { file: file.relativePath, line, ...(symbol ? { symbol } : {}), ...(excerpt ? { excerpt } : {}) };
}
