import { parse } from 'java-parser';
import { stableId } from '../core/stable.js';
import type {
  Diagnostic,
  InputConstraint,
  JavaEndpointFact,
  PermissionFact,
  SourceRef,
  TerminalEffectFact,
} from '../ir/model.js';
import type { SourceFile } from './source.js';

export interface JavaExtraction {
  endpoints: JavaEndpointFact[];
  validations: InputConstraint[];
  permissions: PermissionFact[];
  effects: TerminalEffectFact[];
  diagnostics: Diagnostic[];
}

interface MethodCandidate {
  name: string;
  requestType?: string;
  responseType?: string;
  line: number;
  annotations: string[];
  body: string;
}

export function extractJava(files: SourceFile[]): JavaExtraction {
  const endpoints: JavaEndpointFact[] = [];
  const validations: InputConstraint[] = [];
  const permissions: PermissionFact[] = [];
  const effects: TerminalEffectFact[] = [];
  const diagnostics: Diagnostic[] = [];

  const javaFiles = files.filter((file) => file.language === 'java');
  const validationByType = new Map<string, InputConstraint[]>();

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
    const typeValidations = extractValidations(file, className);
    validations.push(...typeValidations);
    validationByType.set(className, typeValidations);
  }

  for (const file of javaFiles) {
    const className = file.contents.match(/\bclass\s+(\w+)/)?.[1] ?? file.relativePath.split('/').pop()?.replace(/\.java$/, '') ?? 'UnknownController';
    const classPrefix = classMapping(file.contents);
    const methods = extractMethods(file);

    for (const candidate of methods) {
      const mapping = mappingFromAnnotations(candidate.annotations);
      if (!mapping) continue;
      const endpointPath = normalizeRoute(`${classPrefix}/${mapping.path}`);
      const endpointId = stableId('java-endpoint', `${mapping.method}:${endpointPath}:${className}.${candidate.name}`);
      const endpointPermissionIds: string[] = [];

      for (const annotation of candidate.annotations) {
        const authorities = [...annotation.matchAll(/hasAuthority\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]!).concat(
          [...annotation.matchAll(/hasRole\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => `ROLE_${match[1]!}`),
        );
        for (const authority of authorities) {
          const permission: PermissionFact = {
            id: stableId('permission', `backend:${authority}:${file.relativePath}:${candidate.line}`),
            authority,
            layer: 'backend',
            sourceRef: ref(file, candidate.line, candidate.name, annotation),
          };
          permissions.push(permission);
          endpointPermissionIds.push(permission.id);
        }
      }

      const entity = inferEntity(candidate.requestType, className, endpointPath);
      const methodEffects = extractEffects(file, candidate, mapping.method, entity);
      effects.push(...methodEffects);

      endpoints.push({
        id: endpointId,
        method: mapping.method,
        pathTemplate: endpointPath,
        controller: className,
        handler: candidate.name,
        ...(candidate.requestType ? { requestType: candidate.requestType } : {}),
        ...(candidate.responseType ? { responseType: candidate.responseType } : {}),
        permissionIds: endpointPermissionIds,
        validationIds: candidate.requestType ? (validationByType.get(candidate.requestType) ?? []).map((validation) => validation.id) : [],
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
  let annotations: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith('@')) {
      annotations.push(trimmed);
      continue;
    }

    const signature = trimmed.match(/\b(public|protected|private)\s+(?:static\s+)?([\w<>,?\[\].]+)\s+(\w+)\s*\((.*)\)\s*(?:throws\s+[^{]+)?\s*\{?/);
    if (signature?.[2] && signature[3] && annotations.some((annotation) => /(Mapping|PreAuthorize)/.test(annotation))) {
      const body = methodBody(lines, index);
      const requestType = requestTypeFromParameters(signature[4] ?? '');
      methods.push({
        name: signature[3],
        ...(requestType ? { requestType } : {}),
        responseType: signature[2],
        line: index + 1,
        annotations: [...annotations],
        body,
      });
      annotations = [];
      continue;
    }

    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) annotations = [];
  }
  return methods;
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

function requestTypeFromParameters(parameters: string): string | undefined {
  for (const parameter of parameters.split(',')) {
    if (!/(RequestBody|Valid)/.test(parameter)) continue;
    const stripped = parameter.replace(/@\w+(?:\([^)]*\))?/g, '').trim();
    const parts = stripped.split(/\s+/);
    if (parts.length >= 2) return parts[parts.length - 2];
  }
  return undefined;
}

function classMapping(contents: string): string {
  const classIndex = contents.search(/\bclass\s+\w+/);
  const beforeClass = classIndex >= 0 ? contents.slice(Math.max(0, classIndex - 800), classIndex) : contents;
  const mappings = [...beforeClass.matchAll(/@RequestMapping\s*\(([^)]*)\)/g)];
  return annotationPath(mappings.at(-1)?.[1] ?? '');
}

function mappingFromAnnotations(annotations: string[]): { method: string; path: string } | undefined {
  for (const annotation of annotations) {
    const direct = annotation.match(/@(Get|Post|Put|Patch|Delete)Mapping\s*(?:\((.*)\))?/);
    if (direct?.[1]) return { method: direct[1].toUpperCase(), path: annotationPath(direct[2] ?? '') };
    const generic = annotation.match(/@RequestMapping\s*\((.*)\)/);
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
  const results: InputConstraint[] = [];
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

function validationsFromAnnotation(annotation: string): { kind: InputConstraint['kind']; value?: string | number | boolean; message?: string }[] {
  const message = annotation.match(/message\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (/@(NotNull|NotBlank|NotEmpty)\b/.test(annotation)) return [{ kind: 'required', value: true, ...(message ? { message } : {}) }];
  const min = annotation.match(/@Min\s*\(\s*(?:value\s*=\s*)?(\d+)/)?.[1];
  if (min) return [{ kind: 'min', value: Number(min), ...(message ? { message } : {}) }];
  const max = annotation.match(/@Max\s*\(\s*(?:value\s*=\s*)?(\d+)/)?.[1];
  if (max) return [{ kind: 'max', value: Number(max), ...(message ? { message } : {}) }];
  const size = annotation.match(/@Size\s*\(([^)]*)\)/)?.[1];
  if (size) {
    const minimum = size.match(/min\s*=\s*(\d+)/)?.[1];
    const maximum = size.match(/max\s*=\s*(\d+)/)?.[1];
    return [
      ...(minimum ? [{ kind: 'min' as const, value: Number(minimum), ...(message ? { message } : {}) }] : []),
      ...(maximum ? [{ kind: 'max' as const, value: Number(maximum), ...(message ? { message } : {}) }] : []),
    ];
  }
  const pattern = annotation.match(/@Pattern\s*\([^)]*regexp\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (pattern) return [{ kind: 'pattern', value: pattern, ...(message ? { message } : {}) }];
  return [];
}

function extractEffects(file: SourceFile, candidate: MethodCandidate, method: string, entity: string): TerminalEffectFact[] {
  const results: TerminalEffectFact[] = [];
  const status = candidate.body.match(/(?:setStatus\s*\(|status\s*=\s*)(?:\w+\.)?([A-Z][A-Z0-9_]*)/)?.[1];
  if (status) {
    results.push({
      id: stableId('terminal-effect', `${file.relativePath}:${candidate.name}:${entity}:state:${status}`),
      entity,
      kind: 'state-changed',
      toState: status,
      sourceRef: ref(file, candidate.line, candidate.name, `state → ${status}`),
    });
  }
  if (/\.(?:save|persist)\s*\(/.test(candidate.body) && !results.length) {
    results.push({
      id: stableId('terminal-effect', `${file.relativePath}:${candidate.name}:${entity}:${method}`),
      entity,
      kind: method === 'POST' ? 'entity-created' : 'state-changed',
      sourceRef: ref(file, candidate.line, candidate.name, `${method} persists ${entity}`),
    });
  }
  if (method === 'DELETE' && !results.length) {
    results.push({
      id: stableId('terminal-effect', `${file.relativePath}:${candidate.name}:${entity}:deleted`),
      entity,
      kind: 'entity-deleted',
      sourceRef: ref(file, candidate.line, candidate.name),
    });
  }
  if (/\.(?:publish|send)\s*\(/.test(candidate.body) && !results.length) {
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

function ref(file: SourceFile, line: number, symbol?: string, excerpt?: string): SourceRef {
  return { file: file.relativePath, line, ...(symbol ? { symbol } : {}), ...(excerpt ? { excerpt } : {}) };
}
