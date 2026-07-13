import path from 'node:path';
import {
  Node,
  Project,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type CallExpression,
  type JsxAttribute,
  type JsxElement,
  type JsxSelfClosingElement,
  type SourceFile,
} from 'ts-morph';
import { stableId } from '../core/stable.js';
import { predicateFromExpression, TRUE } from '../ir/predicates.js';
import type {
  Diagnostic,
  HttpOperationFact,
  NavigationFact,
  PageSeed,
  PermissionFact,
  ReactActionFact,
  ReactFieldFact,
  ReactHandlerFact,
  ReactRouteFact,
  SourceRef,
} from '../ir/model.js';
import type { SourceFile as SnapshotFile } from './source.js';

export interface ReactExtraction {
  routes: ReactRouteFact[];
  pages: PageSeed[];
  handlers: ReactHandlerFact[];
  actions: ReactActionFact[];
  fields: ReactFieldFact[];
  httpOperations: HttpOperationFact[];
  navigations: NavigationFact[];
  permissions: PermissionFact[];
  diagnostics: Diagnostic[];
}

export function extractReact(files: SnapshotFile[]): ReactExtraction {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { target: ScriptTarget.ES2022, jsx: 4 },
  });
  const sourceMap = new Map<string, SourceFile>();
  for (const file of files.filter((candidate) => candidate.language === 'typescript')) {
    const source = project.createSourceFile(`/${file.relativePath}`, file.contents, {
      scriptKind: file.relativePath.endsWith('.tsx') ? ScriptKind.TSX : ScriptKind.TS,
      overwrite: true,
    });
    sourceMap.set(file.relativePath, source);
  }

  const routes: ReactRouteFact[] = [];
  const pages: PageSeed[] = [];
  const handlers: ReactHandlerFact[] = [];
  const actions: ReactActionFact[] = [];
  const fields: ReactFieldFact[] = [];
  const httpOperations: HttpOperationFact[] = [];
  const navigations: NavigationFact[] = [];
  const permissions: PermissionFact[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const [relativePath, source] of sourceMap) {
    const page = discoverPage(source, relativePath);
    if (page) pages.push(page);

    for (const routeNode of [...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement), ...source.getDescendantsOfKind(SyntaxKind.JsxElement)]) {
      const opening = Node.isJsxElement(routeNode) ? routeNode.getOpeningElement() : routeNode;
      const tag = opening.getTagNameNode().getText();
      if (tag === 'Route' || tag.endsWith('.Route')) {
        const pathValue = jsxAttributeValue(opening.getAttribute('path'));
        if (pathValue) {
          const component = componentFromElementAttribute(opening.getAttribute('element'));
          routes.push({
            id: stableId('route', `${relativePath}:${pathValue}:${component ?? ''}`),
            path: normalizeRoute(pathValue),
            ...(component ? { component } : {}),
            sourceRef: sourceRef(relativePath, opening, component),
          });
        }
      }
    }

    const fileHttp: HttpOperationFact[] = [];
    const fileNavigations: NavigationFact[] = [];
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const http = extractHttpCall(call, relativePath);
      if (http) {
        httpOperations.push(http);
        fileHttp.push(http);
      }
      const navigation = extractNavigation(call, relativePath, page?.id);
      if (navigation) {
        navigations.push(navigation);
        fileNavigations.push(navigation);
      }
      const permission = extractPermission(call, relativePath);
      if (permission) permissions.push(permission);
    }

    const fileHandlers = extractHandlers(source, relativePath, fileHttp, fileNavigations);
    handlers.push(...fileHandlers);

    if (page) {
      for (const jsx of [...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement), ...source.getDescendantsOfKind(SyntaxKind.JsxElement)]) {
        const opening = Node.isJsxElement(jsx) ? jsx.getOpeningElement() : jsx;
        const tag = opening.getTagNameNode().getText();
        const action = extractAction(jsx, opening, tag, relativePath, page.id, fileHandlers);
        if (action) actions.push(action);
        const field = extractField(jsx, opening, tag, relativePath, page.id);
        if (field) fields.push(field);
      }
    }
  }

  for (const page of pages) {
    page.routeIds = routes.filter((route) => route.component === page.name).map((route) => route.id);
  }

  if (!pages.length && files.some((file) => file.language === 'typescript')) {
    diagnostics.push({ code: 'NO_REACT_PAGES', severity: 'warning', message: 'TypeScript source was found but no JSX page components were recognized.' });
  }

  return { routes, pages, handlers, actions, fields, httpOperations, navigations, permissions, diagnostics };
}

function discoverPage(source: SourceFile, relativePath: string): PageSeed | undefined {
  const jsxFunctions = source.getFunctions().filter((fn) => fn.getDescendantsOfKind(SyntaxKind.JsxElement).length || fn.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length);
  const variableFunctions = source.getVariableDeclarations().filter((declaration) => {
    const initializer = declaration.getInitializer();
    return initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) &&
      (initializer.getDescendantsOfKind(SyntaxKind.JsxElement).length || initializer.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length);
  });
  const named = jsxFunctions[0]?.getName() ?? variableFunctions[0]?.getName();
  if (!named) return undefined;
  const pageConvention = /(^|\/)pages?\//i.test(relativePath) || /(Page|Screen|View)$/.test(named);
  if (!pageConvention) return undefined;
  const node = jsxFunctions[0] ?? variableFunctions[0]!;
  return {
    id: stableId('page', `${relativePath}:${named}`),
    name: named,
    file: relativePath,
    routeIds: [],
    sourceRef: sourceRef(relativePath, node, named),
  };
}

function extractHandlers(source: SourceFile, relativePath: string, http: HttpOperationFact[], navigations: NavigationFact[]): ReactHandlerFact[] {
  const results: ReactHandlerFact[] = [];
  const candidates: { name: string; node: Node }[] = [];
  source.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).forEach((node) => {
    if (node.getName()) candidates.push({ name: node.getName()!, node });
  });
  source.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach((declaration) => {
    const initializer = declaration.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      candidates.push({ name: declaration.getName(), node: initializer });
    }
  });

  for (const candidate of candidates) {
    const startLine = candidate.node.getStartLineNumber();
    const endLine = candidate.node.getEndLineNumber();
    const calls = candidate.node.getDescendantsOfKind(SyntaxKind.CallExpression).map((call) => call.getExpression().getText());
    results.push({
      id: stableId('handler', `${relativePath}:${candidate.name}`),
      name: candidate.name,
      file: relativePath,
      calls,
      httpOperationIds: http.filter((operation) => positionInRange(operation.sourceRef, startLine, endLine)).map((operation) => operation.id),
      navigationIds: navigations.filter((navigation) => positionInRange(navigation.sourceRef, startLine, endLine)).map((navigation) => navigation.id),
      sourceRef: sourceRef(relativePath, candidate.node, candidate.name),
    });
  }
  return results;
}

function positionInRange(ref: SourceRef, startLine: number, endLine: number): boolean {
  return ref.line >= startLine && ref.line <= endLine;
}

function extractHttpCall(call: CallExpression, relativePath: string): HttpOperationFact | undefined {
  const expression = call.getExpression().getText();
  const args = call.getArguments();
  let method: string | undefined;
  let pathTemplate: string | undefined;

  if (expression === 'fetch' || expression.endsWith('.fetch')) {
    pathTemplate = staticValue(args[0]);
    const optionsText = args[1]?.getText() ?? '';
    method = optionsText.match(/method\s*:\s*['"`]([A-Za-z]+)['"`]/)?.[1]?.toUpperCase() ?? 'GET';
  } else {
    const methodMatch = expression.match(/\.(get|post|put|patch|delete)$/i);
    if (methodMatch?.[1]) {
      method = methodMatch[1].toUpperCase();
      pathTemplate = staticValue(args[0]);
    }
  }

  if (!method || !pathTemplate) return undefined;
  const callerSymbol = enclosingFunctionName(call);
  return {
    id: stableId('http-operation', `${relativePath}:${call.getStart()}:${method}:${pathTemplate}`),
    method,
    pathTemplate: normalizeRoute(pathTemplate),
    ...(callerSymbol ? { callerSymbol } : {}),
    ...(args[1] ? { requestExpression: args[1].getText() } : {}),
    sourceRef: sourceRef(relativePath, call, callerSymbol),
  };
}

function extractNavigation(call: CallExpression, relativePath: string, pageId?: string): NavigationFact | undefined {
  const expression = call.getExpression().getText();
  if (!(expression === 'navigate' || expression.endsWith('.navigate') || expression.endsWith('.push') || expression.endsWith('.replace'))) return undefined;
  const target = staticValue(call.getArguments()[0]);
  if (!target) return undefined;
  const guard = conditionalGuard(call);
  return {
    id: stableId('navigation', `${relativePath}:${call.getStart()}:${target}`),
    ...(pageId ? { fromPageId: pageId } : {}),
    target: normalizeRoute(target),
    guard,
    sourceRef: sourceRef(relativePath, call, target),
  };
}

function extractPermission(call: CallExpression, relativePath: string): PermissionFact | undefined {
  const expression = call.getExpression().getText();
  if (!/(hasPermission|hasAuthority|can|isAllowed)$/.test(expression)) return undefined;
  const authority = staticValue(call.getArguments()[0]);
  if (!authority) return undefined;
  return {
    id: stableId('permission', `frontend:${authority}:${relativePath}:${call.getStart()}`),
    authority,
    layer: 'frontend',
    sourceRef: sourceRef(relativePath, call, authority),
  };
}

function extractAction(
  jsx: JsxElement | JsxSelfClosingElement,
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
  tag: string,
  relativePath: string,
  pageId: string,
  handlers: ReactHandlerFact[],
): ReactActionFact | undefined {
  const eventAttribute = opening.getAttributes().find((attribute) =>
    Node.isJsxAttribute(attribute) && /^on(Click|Submit|Change|Select|KeyDown)$/.test(attribute.getNameNode().getText()),
  );
  const isSemanticAction = ['button', 'a', 'form'].includes(tag.toLowerCase()) || /(Button|Link|MenuItem|Action)$/.test(tag);
  if (!eventAttribute && !isSemanticAction) return undefined;
  if (tag === 'Route' || tag === 'input' || tag === 'select' || tag === 'textarea') return undefined;

  const event = Node.isJsxAttribute(eventAttribute) ? eventAttribute.getNameNode().getText().replace(/^on/, '').toLowerCase() : tag === 'form' ? 'submit' : 'click';
  const handlerText = Node.isJsxAttribute(eventAttribute) ? jsxAttributeExpression(eventAttribute) : undefined;
  const handlerName = handlerText ? firstCallableIdentifier(handlerText) : undefined;
  const handler = handlers.find((candidate) => candidate.name === handlerName);
  const disabled = jsxAttributeExpression(opening.getAttribute('disabled'));
  const accessibleName = jsxAttributeValue(opening.getAttribute('aria-label')) ?? jsxAttributeValue(opening.getAttribute('title')) ?? jsxText(jsx) ?? handlerName;
  return {
    id: stableId('action', `${relativePath}:${opening.getStart()}:${event}:${accessibleName ?? tag}`),
    pageId,
    component: tag,
    event,
    ...(accessibleName ? { accessibleName } : {}),
    ...(handlerName ? { handlerName } : {}),
    ...(handler ? { handlerId: handler.id } : {}),
    visibleWhen: [conditionalGuard(opening)],
    enabledWhen: disabled ? [{ kind: 'not', operand: predicateFromExpression(disabled) }] : [TRUE],
    sourceRef: sourceRef(relativePath, opening, accessibleName),
  };
}

function extractField(
  jsx: JsxElement | JsxSelfClosingElement,
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
  tag: string,
  relativePath: string,
  pageId: string,
): ReactFieldFact | undefined {
  const lower = tag.toLowerCase();
  const fieldLike = ['input', 'select', 'textarea'].includes(lower) || /(Input|Select|Picker|Field|Checkbox|Radio)$/.test(tag);
  if (!fieldLike) return undefined;
  const dataPath = jsxAttributeValue(opening.getAttribute('name')) ?? jsxAttributeValue(opening.getAttribute('data-path')) ?? jsxAttributeValue(opening.getAttribute('id'));
  if (!dataPath) return undefined;
  const required = opening.getAttribute('required');
  const requiredWhen = required ? [conditionalGuard(opening)] : [];
  const constraints: ReactFieldFact['constraints'] = [
    ['minLength', 'min'],
    ['maxLength', 'max'],
    ['pattern', 'pattern'],
  ].flatMap(([attributeName, kind]) => {
    const value = jsxAttributeValue(opening.getAttribute(attributeName!));
    if (!value) return [];
    return [{
      id: stableId('constraint', `${relativePath}:${dataPath}:${attributeName}:${value}`),
      fieldPath: dataPath,
      kind: kind as 'min' | 'max' | 'pattern',
      value: /^\d+$/.test(value) ? Number(value) : value,
      sourceRef: sourceRef(relativePath, opening, dataPath),
    }];
  });
  if (required) {
    constraints.push({
      id: stableId('constraint', `${relativePath}:${dataPath}:required`),
      fieldPath: dataPath,
      kind: 'required',
      value: true,
      sourceRef: sourceRef(relativePath, opening, dataPath),
    });
  }
  return {
    id: stableId('field', `${relativePath}:${dataPath}`),
    pageId,
    dataPath,
    ...((jsxAttributeValue(opening.getAttribute('label')) ?? jsxAttributeValue(opening.getAttribute('aria-label')))
      ? { label: jsxAttributeValue(opening.getAttribute('label')) ?? jsxAttributeValue(opening.getAttribute('aria-label'))! }
      : {}),
    controlKind: lower === 'input' ? jsxAttributeValue(opening.getAttribute('type')) ?? 'textbox' : tag,
    visibleWhen: [conditionalGuard(opening)],
    requiredWhen,
    constraints,
    sourceRef: sourceRef(relativePath, opening, dataPath),
  };
}

function conditionalGuard(node: Node) {
  const binary = node.getFirstAncestorByKind(SyntaxKind.BinaryExpression);
  if (binary?.getOperatorToken().getText() === '&&' && binary.getRight().getStart() <= node.getStart()) {
    return predicateFromExpression(binary.getLeft().getText());
  }
  const conditional = node.getFirstAncestorByKind(SyntaxKind.ConditionalExpression);
  if (conditional) return predicateFromExpression(conditional.getCondition().getText());
  const ifStatement = node.getFirstAncestorByKind(SyntaxKind.IfStatement);
  if (ifStatement) return predicateFromExpression(ifStatement.getExpression().getText());
  return TRUE;
}

function jsxAttributeValue(attribute: Node | undefined): string | undefined {
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  if (!initializer) return 'true';
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralText();
  if (Node.isJsxExpression(initializer)) return staticValue(initializer.getExpression());
  return undefined;
}

function jsxAttributeExpression(attribute: Node | undefined): string | undefined {
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  if (Node.isJsxExpression(initializer)) return initializer.getExpression()?.getText();
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralText();
  return undefined;
}

function componentFromElementAttribute(attribute: Node | undefined): string | undefined {
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined;
  if (!expression) return undefined;
  if (Node.isJsxSelfClosingElement(expression)) return expression.getTagNameNode().getText();
  if (Node.isJsxElement(expression)) return expression.getOpeningElement().getTagNameNode().getText();
  const jsx = expression.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) ?? expression.getFirstDescendantByKind(SyntaxKind.JsxElement);
  if (!jsx) return undefined;
  return Node.isJsxElement(jsx) ? jsx.getOpeningElement().getTagNameNode().getText() : jsx.getTagNameNode().getText();
}

function jsxText(jsx: JsxElement | JsxSelfClosingElement): string | undefined {
  if (!Node.isJsxElement(jsx)) return undefined;
  const text = jsx.getJsxChildren().filter(Node.isJsxText).map((child) => child.getText().trim()).filter(Boolean).join(' ');
  return text || undefined;
}

function staticValue(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isNumericLiteral(node)) return node.getText();
  if (Node.isTemplateExpression(node)) {
    let value = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      value += `{${span.getExpression().getText()}}${span.getLiteral().getLiteralText()}`;
    }
    return value;
  }
  return undefined;
}

function normalizeRoute(value: string): string {
  const normalized = value.replace(/\$\{([^}]+)\}/g, '{$1}').replace(/\/+/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function enclosingFunctionName(node: Node): string | undefined {
  const functionNode = node.getFirstAncestor((ancestor) =>
    Node.isFunctionDeclaration(ancestor) || Node.isMethodDeclaration(ancestor) || Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor),
  );
  if (!functionNode) return undefined;
  if (Node.isFunctionDeclaration(functionNode) || Node.isMethodDeclaration(functionNode)) return functionNode.getName();
  const variable = functionNode.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return variable?.getName();
}

function firstCallableIdentifier(expression: string): string | undefined {
  const direct = expression.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  if (direct) return direct;
  return expression.match(/(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/)?.[1];
}

function sourceRef(relativePath: string, node: Node, symbol?: string): SourceRef {
  const line = node.getStartLineNumber();
  const excerpt = node.getText().replace(/\s+/g, ' ').slice(0, 180);
  return { file: relativePath, line, ...(symbol ? { symbol } : {}), excerpt };
}
