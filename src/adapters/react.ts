import path from 'node:path';
import {
  Node,
  Project,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  VariableDeclarationKind,
  type CallExpression,
  type JsxAttribute,
  type JsxElement,
  type JsxSelfClosingElement,
  type SourceFile,
  type Symbol as MorphSymbol,
} from 'ts-morph';
import { stableId } from '../core/stable.js';
import { allPredicates, predicateFromExpression, TRUE } from '../ir/predicates.js';
import type {
  Diagnostic,
  HttpOperationFact,
  NavigationFact,
  PageSeed,
  PermissionFact,
  Predicate,
  ReactActionFact,
  ReactCallSiteFact,
  ReactFieldFact,
  ReactHandlerFact,
  ReactRouteFact,
  RequestPayloadShape,
  SourceRef,
  ValueRef,
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

export function extractReact(
  files: SnapshotFile[],
  options: { transparentComponents?: string[] } = {},
): ReactExtraction {
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
    for (const routeNode of [...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement), ...source.getDescendantsOfKind(SyntaxKind.JsxElement)]) {
      const opening = Node.isJsxElement(routeNode) ? routeNode.getOpeningElement() : routeNode;
      const tag = opening.getTagNameNode().getText();
      if (tag === 'Route' || tag.endsWith('.Route')) {
        const pathValue = jsxAttributeValue(opening.getAttribute('path'));
        if (pathValue) {
          const componentTarget = componentFromElementAttribute(opening.getAttribute('element'));
          const component = componentTarget?.name;
          routes.push({
            id: stableId('route', `${relativePath}:${pathValue}:${component ?? ''}:${componentTarget?.file ?? ''}`),
            path: normalizeRoute(pathValue),
            ...(component ? { component } : {}),
            ...(componentTarget?.file ? { componentFile: componentTarget.file } : {}),
            sourceRef: sourceRef(relativePath, opening, component),
          });
        }
      }
    }
    routes.push(...extractObjectRouterRoutes(source, relativePath));
  }

  const axiosBasePath = extractAxiosDefaultBasePath([...sourceMap.values()]);
  const handlersByFile = new Map<string, ReactHandlerFact[]>();
  for (const [relativePath, source] of sourceMap) {
    const calls = source.getDescendantsOfKind(SyntaxKind.CallExpression);
    const fileHttp = calls.flatMap((call) => {
      const fact = extractHttpCall(call, relativePath, axiosBasePath);
      return fact ? [fact] : [];
    });
    const fileNavigations = calls.flatMap((call) => {
      const fact = extractNavigation(call, relativePath);
      return fact ? [fact] : [];
    });
    handlersByFile.set(relativePath, extractHandlers(source, relativePath, fileHttp, fileNavigations));
  }

  for (const [relativePath, source] of sourceMap) {
    const discovery = discoverPages(source, relativePath, routes);
    const pageScopes = discovery.pages;
    pages.push(...pageScopes.map((scope) => scope.page));
    diagnostics.push(...discovery.diagnostics);

    const fileHttp: HttpOperationFact[] = [];
    const fileNavigations: NavigationFact[] = [];
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const http = extractHttpCall(call, relativePath, axiosBasePath);
      if (http) {
        httpOperations.push(http);
        fileHttp.push(http);
      }
      const owner = pageScopes.find((scope) => containsNode(scope.node, call));
      const navigation = extractNavigation(call, relativePath, owner?.page.id);
      if (navigation) {
        navigations.push(navigation);
        fileNavigations.push(navigation);
      }
      const permission = extractPermission(call, relativePath);
      if (permission) permissions.push(permission);
    }

    const fileHandlers = handlersByFile.get(relativePath) ?? [];
    handlers.push(...fileHandlers);

    for (const pageScope of pageScopes) {
      const jsxNodes = [
        ...pageScope.node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
        ...pageScope.node.getDescendantsOfKind(SyntaxKind.JsxElement),
      ];
      const renderedJsxNodes = jsxNodes.filter((jsx) => jsxIsInPageRender(pageScope.node, jsx));
      const excludedJsxNodes = jsxNodes.filter((jsx) => !renderedJsxNodes.includes(jsx));
      const unresolvedRenderHelpers = nestedRenderHelpers(pageScope.node, excludedJsxNodes);
      const unresolvedJsxBindings = detachedJsxValueBindings(pageScope.node, excludedJsxNodes);
      if (unresolvedRenderHelpers.length) {
        pageScope.page.completeness = 'conditional';
        diagnostics.push({
          code: 'REACT_RENDER_HELPER_UNRESOLVED',
          severity: 'blocked',
          message: `${pageScope.page.name} calls nested JSX render helper(s) ${unresolvedRenderHelpers.join(', ')}. Their controls are not inlined without a complete interprocedural render proof.`,
          evidenceRefs: [pageScope.page.id],
          scope: pageScope.page.id,
        });
      }
      if (unresolvedJsxBindings.length) {
        pageScope.page.completeness = 'conditional';
        diagnostics.push({
          code: 'REACT_DETACHED_JSX_BINDING_UNRESOLVED',
          severity: 'blocked',
          message: `${pageScope.page.name} may render page-local JSX value binding(s) ${unresolvedJsxBindings.join(', ')}. Their controls are not treated as visible without a direct return-tree proof.`,
          evidenceRefs: [pageScope.page.id],
          scope: pageScope.page.id,
        });
      }
      if (!unresolvedRenderHelpers.length && !unresolvedJsxBindings.length && jsxNodes.length && !renderedJsxNodes.length) {
        pageScope.page.completeness = 'conditional';
        diagnostics.push({
          code: 'REACT_PAGE_RENDER_OUTPUT_UNRESOLVED',
          severity: 'blocked',
          message: `${pageScope.page.name} contains JSX, but none is directly connected to a component return expression. Nested render helpers are not treated as visible controls without a proved render path.`,
          evidenceRefs: [pageScope.page.id],
          scope: pageScope.page.id,
        });
      }
      const composition = collectComposedRenderTree(pageScope.node, relativePath, sourceMap);
      if (composition.unresolved.length) {
        pageScope.page.completeness = 'conditional';
        for (const unresolved of composition.unresolved) {
          pageScope.page.unresolvedChildComponentRefs = dedupeSourceRefs([
            ...(pageScope.page.unresolvedChildComponentRefs ?? []),
            unresolved.sourceRef,
          ]);
          diagnostics.push({
            code: 'REACT_COMPONENT_COMPOSITION_UNRESOLVED',
            severity: 'blocked',
            message: unresolved.reason,
            evidenceRefs: [pageScope.page.id],
            scope: pageScope.page.id,
          });
        }
      }
      for (const context of composition.nodes) {
        const jsx = context.jsx;
        const contextPath = context.relativePath;
        const opening = Node.isJsxElement(jsx) ? jsx.getOpeningElement() : jsx;
        const tag = opening.getTagNameNode().getText();
        const declarative = extractDeclarativeNavigations(opening, tag, contextPath, pageScope.page.id, context.renderGuard);
        navigations.push(...declarative.navigations);
        diagnostics.push(...declarative.diagnostics);
        const action = extractAction(
          jsx,
          opening,
          tag,
          contextPath,
          pageScope.page.id,
          handlersByFile.get(contextPath) ?? [],
          declarative.navigations.map((navigation) => navigation.id),
          context.renderGuard,
        );
        if (action) {
          actions.push(action);
          if (action.handlerResolution === 'conditional') {
            diagnostics.push({
              code: 'REACT_ACTION_HANDLER_UNRESOLVED',
              severity: 'blocked',
              message: `The handler ${action.handlerExpression ?? action.handlerName ?? 'expression'} for ${action.accessibleName ?? action.component} was not resolved to an extracted function.`,
              evidenceRefs: [action.id],
              scope: action.id,
            });
          }
        }
        const field = extractField(jsx, opening, tag, contextPath, pageScope.page.id, context.renderGuard);
        if (field) {
          fields.push(field);
        }
        if (!field && isUnresolvedNativeControl(tag, opening)) {
          const ref = sourceRef(contextPath, opening, tag);
          pageScope.page.completeness = 'conditional';
          pageScope.page.unresolvedChildComponentRefs = dedupeSourceRefs([
            ...(pageScope.page.unresolvedChildComponentRefs ?? []),
            ref,
          ]);
          diagnostics.push({
            code: 'REACT_NATIVE_CONTROL_UNRESOLVED',
            severity: 'blocked',
            message: `${tag} is an interactive native control, but no static name, data-path, id, register(\"field\") call, or controlled value path identifies its business field.`,
            evidenceRefs: [pageScope.page.id],
            scope: pageScope.page.id,
          });
        }
        if (isUnresolvedChildComponent(opening, tag, action, field, declarative.navigations, options.transparentComponents ?? [], sourceMap)) {
          const ref = sourceRef(contextPath, opening, tag);
          pageScope.page.completeness = 'conditional';
          pageScope.page.unresolvedChildComponentRefs = dedupeSourceRefs([
            ...(pageScope.page.unresolvedChildComponentRefs ?? []),
            ref,
          ]);
          diagnostics.push({
            code: 'REACT_CHILD_COMPONENT_UNRESOLVED',
            severity: 'blocked',
            message: `${tag} is rendered by ${pageScope.page.name}, but its controls, guards and validation are not inlined by the bounded React adapter.`,
            evidenceRefs: [pageScope.page.id],
            scope: pageScope.page.id,
          });
        }
      }
    }
  }

  for (const page of pages) {
    page.routeIds = routes.filter((route) => (
      route.component === page.name
      && (route.componentFile ? route.componentFile === page.file : pages.filter((candidate) => candidate.name === route.component).length === 1)
    )).map((route) => route.id);
  }
  for (const route of routes) {
    const candidates = pages.filter((page) => (
      page.name === route.component && (!route.componentFile || page.file === route.componentFile)
    ));
    if (route.component && candidates.length !== 1) {
      diagnostics.push({
        code: 'REACT_ROUTE_COMPONENT_UNRESOLVED',
        severity: 'blocked',
        message: `Route ${route.path} does not resolve to one source page identity for ${route.component}; name-only joins are not used.`,
        evidenceRefs: [route.id, ...candidates.map((page) => page.id)],
        scope: route.id,
      });
    }
  }

  if (!pages.length && files.some((file) => file.language === 'typescript')) {
    diagnostics.push({ code: 'NO_REACT_PAGES', severity: 'warning', message: 'TypeScript source was found but no JSX page components were recognized.' });
  }
  const mergedFields = mergeChoiceFields(fields);
  diagnostics.push(...mergedFields.flatMap((field) => field.constraints
    .filter((constraint) => constraint.kind === 'opaque')
    .map((constraint): Diagnostic => ({
      code: 'FRONTEND_VALIDATION_UNRESOLVED',
      severity: 'warning',
      message: constraint.message ?? `Validation for ${field.dataPath} requires review.`,
      evidenceRefs: [field.id, constraint.id],
      scope: field.id,
    }))));

  return {
    routes,
    pages,
    handlers,
    actions,
    fields: mergedFields,
    httpOperations,
    navigations,
    permissions,
    diagnostics,
  };
}

interface PageScope {
  page: PageSeed;
  node: Node;
  exported: boolean;
}

interface RenderedJsxContext {
  jsx: JsxElement | JsxSelfClosingElement;
  relativePath: string;
  renderGuard: Predicate;
}

interface ComponentTarget {
  node: Node;
  relativePath: string;
}

function collectComposedRenderTree(
  root: Node,
  rootPath: string,
  sourceMap: Map<string, SourceFile>,
): {
  nodes: RenderedJsxContext[];
  unresolved: Array<{ sourceRef: SourceRef; reason: string }>;
} {
  const nodes: RenderedJsxContext[] = [];
  const unresolved: Array<{ sourceRef: SourceRef; reason: string }> = [];
  const maxDepth = 12;
  const maxNodes = 5000;

  const visit = (component: Node, relativePath: string, stack: string[], depth: number, inheritedGuard: Predicate): void => {
    const jsxNodes = [
      ...component.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
      ...component.getDescendantsOfKind(SyntaxKind.JsxElement),
    ].filter((jsx) => jsxIsInPageRender(component, jsx));
    for (const jsx of jsxNodes) {
      if (nodes.length >= maxNodes) {
        unresolved.push({
          sourceRef: sourceRef(relativePath, jsx),
          reason: `React component composition exceeded ${maxNodes} rendered JSX nodes while expanding ${rootPath}.`,
        });
        return;
      }
      nodes.push({ jsx, relativePath, renderGuard: inheritedGuard });
      const opening = Node.isJsxElement(jsx) ? jsx.getOpeningElement() : jsx;
      const target = resolveApplicationComponent(opening, sourceMap);
      if (!target) continue;
      if (componentInvocationDeclaresInteraction(opening)) continue;
      const key = `${target.relativePath}:${target.node.getStart()}`;
      if (stack.includes(key)) {
        unresolved.push({
          sourceRef: sourceRef(relativePath, opening, opening.getTagNameNode().getText()),
          reason: `React component composition found a render cycle through ${opening.getTagNameNode().getText()}.`,
        });
        continue;
      }
      if (depth >= maxDepth) {
        unresolved.push({
          sourceRef: sourceRef(relativePath, opening, opening.getTagNameNode().getText()),
          reason: `React component composition exceeded depth ${maxDepth} at ${opening.getTagNameNode().getText()}.`,
        });
        continue;
      }
      visit(
        target.node,
        target.relativePath,
        [...stack, key],
        depth + 1,
        allPredicates([inheritedGuard, conditionalGuard(opening)]),
      );
    }
  };

  visit(root, rootPath, [`${rootPath}:${root.getStart()}`], 0, TRUE);
  return {
    nodes: dedupe(nodes, (value) => `${value.relativePath}:${value.jsx.getStart()}`),
    unresolved: dedupe(unresolved, (value) => `${value.sourceRef.file}:${value.sourceRef.line}:${value.reason}`),
  };
}

function componentInvocationDeclaresInteraction(
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
): boolean {
  const tag = opening.getTagNameNode().getText();
  const fieldLike = /(Input|Select|Picker|Field|Checkbox|Radio)$/.test(tag);
  const identifiesField = ['name', 'data-path', 'id'].some((name) => jsxAttributeValue(opening.getAttribute(name)) !== undefined)
    || opening.getAttributes().filter(Node.isJsxSpreadAttribute).some((attribute) => (
      Node.isCallExpression(unwrapExpression(attribute.getExpression()))
      && /(?:^|\.)register$/.test((unwrapExpression(attribute.getExpression()) as CallExpression).getExpression().getText())
    ));
  const declaresEvent = opening.getAttributes().some((attribute) => (
    Node.isJsxAttribute(attribute) && /^on(Click|Submit|Change|Select|KeyDown)$/.test(attribute.getNameNode().getText())
  ));
  const declaresNavigation = ['to', 'href'].some((name) => opening.getAttribute(name) !== undefined);
  return (fieldLike && identifiesField) || declaresEvent || declaresNavigation;
}

function resolveApplicationComponent(
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
  sourceMap: Map<string, SourceFile>,
): ComponentTarget | undefined {
  const tagNode = opening.getTagNameNode();
  if (!Node.isIdentifier(tagNode)) return undefined;
  const symbol = tagNode.getSymbol();
  const targetSymbol = symbol?.getAliasedSymbol() ?? symbol;
  for (const declaration of targetSymbol?.getDeclarations() ?? []) {
    const node = componentFunctionNode(declaration);
    const relativePath = declaration.getSourceFile().getFilePath().replace(/^\/+/, '');
    if (node && sourceMap.has(relativePath)) return { node, relativePath };
  }
  return resolveRelativeImportedComponent(tagNode.getText(), opening.getSourceFile(), sourceMap);
}

function componentFunctionNode(declaration: Node): Node | undefined {
  if (Node.isFunctionDeclaration(declaration)) return declaration;
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    return initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
      ? initializer
      : undefined;
  }
  return undefined;
}

function resolveRelativeImportedComponent(
  localName: string,
  owner: SourceFile,
  sourceMap: Map<string, SourceFile>,
): ComponentTarget | undefined {
  const declaration = owner.getImportDeclarations().find((candidate) => {
    if (!candidate.getModuleSpecifierValue().startsWith('.')) return false;
    if (candidate.getDefaultImport()?.getText() === localName) return true;
    return candidate.getNamedImports().some((named) => named.getAliasNode()?.getText() === localName || named.getName() === localName);
  });
  if (!declaration) return undefined;
  const ownerPath = owner.getFilePath().replace(/^\/+/, '');
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), declaration.getModuleSpecifierValue()));
  const targetSource = [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]
    .map((candidate) => sourceMap.get(candidate))
    .find((candidate) => candidate !== undefined);
  if (!targetSource) return undefined;
  const namedImport = declaration.getNamedImports().find((named) => (
    named.getAliasNode()?.getText() === localName || named.getName() === localName
  ));
  const exportedName = namedImport?.getName();
  const functions = [
    ...targetSource.getFunctions(),
    ...targetSource.getVariableDeclarations().flatMap((variable) => {
      const initializer = variable.getInitializer();
      return initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) ? [variable] : [];
    }),
  ];
  const candidate = exportedName
    ? functions.find((node) => (Node.isFunctionDeclaration(node) ? node.getName() : node.getName()) === exportedName)
    : functions.find((node) => (
        Node.isFunctionDeclaration(node)
          ? node.isDefaultExport()
          : Boolean(node.getVariableStatement()?.isDefaultExport())
      )) ?? functions.find((node) => (
        Node.isFunctionDeclaration(node)
          ? node.getName() === localName
          : node.getName() === localName
      ));
  const node = candidate ? componentFunctionNode(candidate) : undefined;
  return node ? { node, relativePath: targetSource.getFilePath().replace(/^\/+/, '') } : undefined;
}

function extractObjectRouterRoutes(source: SourceFile, relativePath: string): ReactRouteFact[] {
  const routes: ReactRouteFact[] = [];
  const routerCalls = source.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => (
    call.getExpression().getText().split('.').at(-1) === 'createBrowserRouter'
  ));
  for (const call of routerCalls) {
    const root = resolveArrayLiteral(call.getArguments()[0]);
    if (!root) continue;
    visitRouteObjects(root, '');
  }
  return dedupe(routes, (route) => route.id);

  function visitRouteObjects(array: import('ts-morph').ArrayLiteralExpression, parentPath: string): void {
    for (const element of array.getElements()) {
      const object = resolveObjectLiteral(element);
      if (!object) continue;
      const pathNode = propertyInitializer(object, 'path');
      const localPath = pathNode ? staticValue(pathNode) : undefined;
      const effectivePath = localPath === undefined ? parentPath : joinRoutePath(parentPath, localPath);
      const children = resolveArrayLiteral(propertyInitializer(object, 'children'));
      const component = componentFromElementExpression(propertyInitializer(object, 'element'));
      if (component && component.name !== 'Navigate' && pathNode) {
        routes.push({
          id: stableId('route', `${relativePath}:${effectivePath}:${component.name}:${component.file ?? ''}`),
          path: normalizeRoute(effectivePath || '/'),
          component: component.name,
          ...(component.file ? { componentFile: component.file } : {}),
          sourceRef: sourceRef(relativePath, object, component.name),
        });
      }
      if (children) visitRouteObjects(children, effectivePath);
    }
  }
}

function resolveArrayLiteral(node: Node | undefined): import('ts-morph').ArrayLiteralExpression | undefined {
  if (!node) return undefined;
  const unwrapped = unwrapExpression(node);
  if (Node.isArrayLiteralExpression(unwrapped)) return unwrapped;
  if (!Node.isIdentifier(unwrapped)) return undefined;
  const initializer = localVariableInitializer(unwrapped, unwrapped.getText());
  return initializer && Node.isArrayLiteralExpression(unwrapExpression(initializer))
    ? unwrapExpression(initializer) as import('ts-morph').ArrayLiteralExpression
    : undefined;
}

function joinRoutePath(parent: string, child: string): string {
  if (child.startsWith('/')) return normalizeRoute(child);
  if (!child) return normalizeRoute(parent || '/');
  return normalizeRoute(`${parent.replace(/\/$/, '')}/${child}`);
}

function discoverPages(
  source: SourceFile,
  relativePath: string,
  routes: ReactRouteFact[],
): { pages: PageScope[]; diagnostics: Diagnostic[] } {
  const jsxFunctions = source.getFunctions().filter((fn) => (
    fn.getName()
    && (fn.getDescendantsOfKind(SyntaxKind.JsxElement).length || fn.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length)
  ));
  const variableFunctions = source.getVariableDeclarations().filter((declaration) => {
    const initializer = declaration.getInitializer();
    const statement = declaration.getVariableStatement();
    return statement?.getParent() === source
      && initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) &&
      (initializer.getDescendantsOfKind(SyntaxKind.JsxElement).length || initializer.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length);
  });
  const candidates: PageScope[] = [
    ...jsxFunctions.map((node) => ({ name: node.getName()!, node, exported: node.isExported() || node.isDefaultExport() })),
    ...variableFunctions.map((declaration) => ({
      name: declaration.getName(),
      node: declaration.getInitializer()!,
      exported: Boolean(declaration.getVariableStatement()?.isExported()),
    })),
  ].map((candidate) => ({
    page: {
      id: stableId('page', `${relativePath}:${candidate.name}`),
      name: candidate.name,
      file: relativePath,
      routeIds: routes.filter((route) => (
        route.component === candidate.name && (!route.componentFile || route.componentFile === relativePath)
      )).map((route) => route.id),
      completeness: 'exact',
      unresolvedChildComponentRefs: [],
      sourceRef: sourceRef(relativePath, candidate.node, candidate.name),
    },
    node: candidate.node,
    exported: candidate.exported,
  }));
  if (!candidates.length) return { pages: [], diagnostics: [] };

  const routed = candidates.filter((candidate) => candidate.page.routeIds.length);
  if (routed.length) return { pages: routed, diagnostics: [] };
  const hasPageSignal = /(^|\/)pages?\//i.test(relativePath)
    || candidates.some((candidate) => /(Page|Screen|View)$/.test(candidate.page.name));
  if (!hasPageSignal) return { pages: [], diagnostics: [] };
  const exportedNamed = candidates.filter((candidate) => candidate.exported && /(Page|Screen|View)$/.test(candidate.page.name));
  if (exportedNamed.length) return { pages: exportedNamed, diagnostics: [] };
  const exported = candidates.filter((candidate) => candidate.exported);
  if (/(^|\/)pages?\//i.test(relativePath) && exported.length === 1) return { pages: exported, diagnostics: [] };
  const conventionNamed = candidates.filter((candidate) => /(Page|Screen|View)$/.test(candidate.page.name));
  if (conventionNamed.length === 1) return { pages: conventionNamed, diagnostics: [] };
  if (/(^|\/)pages?\//i.test(relativePath) && candidates.length === 1) return { pages: candidates, diagnostics: [] };

  const candidateNames = candidates.map((candidate) => candidate.page.name).sort();
  return {
    pages: [],
    diagnostics: [{
      code: 'REACT_PAGE_OWNERSHIP_UNRESOLVED',
      severity: 'blocked',
      message: `Could not choose a routed or uniquely exported page component in ${relativePath}; candidates: ${candidateNames.join(', ')}.`,
      evidenceRefs: candidates.map((candidate) => candidate.page.id),
      scope: relativePath,
    }],
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
      return;
    }
    if (initializer && Node.isCallExpression(initializer)) {
      const callback = initializer.getArguments().find((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument));
      if (callback) candidates.push({ name: declaration.getName(), node: callback });
    }
  });
  source.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach((property) => {
    const initializer = property.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      candidates.push({ name: property.getName(), node: initializer });
    }
  });
  source.getDescendantsOfKind(SyntaxKind.JsxAttribute).forEach((attribute) => {
    if (!/^on(Click|Submit|Change|Select|KeyDown)$/.test(attribute.getNameNode().getText())) return;
    const initializer = attribute.getInitializer();
    const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined;
    if (expression && (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression))) {
      candidates.push({ name: inlineHandlerName(expression), node: expression });
    }
  });

  for (const candidate of dedupe(candidates, (candidate) => `${candidate.name}:${candidate.node.getStart()}`)) {
    const callExpressions = candidate.node.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => (
      nearestEnclosingFunction(call) === candidate.node
    ));
    const calls = callExpressions.map((call) => call.getExpression().getText());
    const callSites: ReactCallSiteFact[] = callExpressions.map((call) => {
      const calleeSymbol = simpleCalleeName(call.getExpression().getText());
      const target = resolveCallTarget(call);
      return {
        calleeSymbol,
        ...(target?.symbol ? { targetSymbol: target.symbol } : {}),
        ...(target?.file ? { targetFile: target.file } : {}),
        guard: allPredicates([conditionalGuard(call), callReachabilityGuard(call, candidate.node)]),
        argumentPayloads: call.getArguments().map((argument) => extractPayloadShape(argument, relativePath)),
        sourceRef: sourceRef(relativePath, call, calleeSymbol),
      };
    });
    const parameterNames = functionParameterNames(candidate.node);
    const normalCompletion = normalCompletionProof(candidate.node);
    results.push({
      id: handlerIdentity(relativePath, candidate.name, candidate.node.getStart()),
      name: candidate.name,
      file: relativePath,
      calls,
      parameterNames,
      callSites,
      httpOperationIds: http.filter((operation) => sourceFactBelongsToCalls(operation.sourceRef, callExpressions)).map((operation) => operation.id),
      navigationIds: navigations.filter((navigation) => sourceFactBelongsToCalls(navigation.sourceRef, callExpressions)).map((navigation) => navigation.id),
      normalCompletion: normalCompletion.status,
      ...(normalCompletion.reason ? { normalCompletionReason: normalCompletion.reason } : {}),
      sourceRef: sourceRef(relativePath, candidate.node, candidate.name),
    });
  }
  return results;
}

function sourceFactBelongsToCalls(ref: SourceRef, calls: CallExpression[]): boolean {
  return calls.some((call) => (
    call.getStartLineNumber() === ref.line
    && (!ref.excerpt || call.getText().replace(/\s+/g, ' ').slice(0, 180) === ref.excerpt)
  ));
}

function nearestEnclosingFunction(node: Node): Node | undefined {
  return node.getFirstAncestor((ancestor) => (
    Node.isFunctionDeclaration(ancestor)
    || Node.isMethodDeclaration(ancestor)
    || Node.isArrowFunction(ancestor)
    || Node.isFunctionExpression(ancestor)
  ));
}

function extractHttpCall(call: CallExpression, relativePath: string, axiosBasePath?: string): HttpOperationFact | undefined {
  const expression = call.getExpression().getText();
  const args = call.getArguments();
  let method: string | undefined;
  let pathTemplate: string | undefined;
  let payloadNode: Node | undefined;
  let payloadShape: RequestPayloadShape | undefined;

  if (expression === 'fetch' || expression.endsWith('.fetch')) {
    pathTemplate = staticValue(args[0]);
    const options = resolveObjectLiteral(args[1]);
    const optionsText = options?.getText() ?? args[1]?.getText() ?? '';
    method = propertyStaticValue(options, 'method')?.toUpperCase()
      ?? optionsText.match(/method\s*:\s*['"`]([A-Za-z]+)['"`]/)?.[1]?.toUpperCase()
      ?? 'GET';
    payloadNode = propertyInitializer(options, 'body');
    if (!payloadNode && ['POST', 'PUT', 'PATCH'].includes(method)) {
      payloadShape = options && !options.getProperties().some(Node.isSpreadAssignment)
        ? emptyPayloadShape(relativePath, args[1] ?? call, 'The request options contain no body property.')
        : unknownPayloadShape(relativePath, args[1] ?? call, 'The fetch request body could not be resolved from its options.');
    }
  } else {
    const methodMatch = expression.match(/\.(get|post|put|patch|delete)$/i);
    if (methodMatch?.[1]) {
      method = methodMatch[1].toUpperCase();
      pathTemplate = staticValue(args[0]);
      if (['POST', 'PUT', 'PATCH'].includes(method)) payloadNode = args[1];
      if (!payloadNode && ['POST', 'PUT', 'PATCH'].includes(method)) {
        payloadShape = emptyPayloadShape(relativePath, call, 'The HTTP client call contains no request payload argument.');
      }
    }
  }

  if (!method || !pathTemplate) return undefined;
  pathTemplate = normalizeHttpPath(pathTemplate, expression, axiosBasePath);
  const callerSymbol = enclosingFunctionName(call);
  payloadShape ??= payloadNode
    ? extractPayloadShape(unwrapJsonSerialization(payloadNode), relativePath)
    : emptyPayloadShape(relativePath, call, 'This HTTP operation has no request body.');
  return {
    id: stableId('http-operation', `${relativePath}:${call.getStart()}:${method}:${pathTemplate}`),
    method,
    pathTemplate: normalizeRoute(pathTemplate),
    ...(callerSymbol ? { callerSymbol } : {}),
    ...(payloadNode ? { requestExpression: unwrapJsonSerialization(payloadNode).getText() } : {}),
    payloadShape,
    guard: allPredicates([
      conditionalGuard(call),
      ...(enclosingFunctionNode(call) ? [callReachabilityGuard(call, enclosingFunctionNode(call)!)] : []),
    ]),
    sourceRef: sourceRef(relativePath, call, callerSymbol),
  };
}

function extractPayloadShape(node: Node, relativePath: string, seenIdentifiers = new Set<string>()): RequestPayloadShape {
  const unwrapped = unwrapJsonSerialization(unwrapExpression(node));
  if (Node.isObjectLiteralExpression(unwrapped)) {
    const fields: RequestPayloadShape['fields'] = [];
    const sourceRefs: SourceRef[] = [sourceRef(relativePath, unwrapped)];
    let dynamic = false;
    for (const property of unwrapped.getProperties()) {
      if (Node.isSpreadAssignment(property)) {
        dynamic = true;
        sourceRefs.push(sourceRef(relativePath, property));
        continue;
      }
      const name = staticPropertyName(property);
      if (!name) {
        dynamic = true;
        sourceRefs.push(sourceRef(relativePath, property));
        continue;
      }
      const fieldRef = sourceRef(relativePath, property, name);
      const payloadValue = payloadPropertyValue(property);
      fields.push({
        name,
        ...(payloadValue.value ? { value: payloadValue.value } : {}),
        ...(payloadValue.sourceIdentity ? { valueSourceIdentity: payloadValue.sourceIdentity } : {}),
        sourceRef: fieldRef,
      });
      sourceRefs.push(fieldRef);
    }
    return {
      certainty: dynamic ? 'partial' : 'exact',
      fields: dedupePayloadFields(fields),
      expression: unwrapped.getText(),
      ...(dynamic ? { reason: 'Object spread or a computed property prevents an exact top-level field set.' } : {}),
      sourceRefs: dedupeSourceRefs(sourceRefs),
    };
  }

  if (Node.isIdentifier(unwrapped)) {
    const name = unwrapped.getText();
    const lookupKey = `${unwrapped.getSourceFile().getFilePath()}:${name}:${unwrapped.getStart()}`;
    if (!seenIdentifiers.has(lookupKey)) {
      const initializer = localVariableInitializer(unwrapped, name);
      if (initializer) {
        const nextSeen = new Set(seenIdentifiers);
        nextSeen.add(lookupKey);
        return extractPayloadShape(initializer, relativePath, nextSeen);
      }
    }
    return {
      certainty: 'unknown',
      fields: [],
      expression: name,
      referenceName: name,
      reason: `Payload expression ${name} must be resolved from its caller or runtime construction.`,
      sourceRefs: [sourceRef(relativePath, unwrapped, name)],
    };
  }

  return unknownPayloadShape(relativePath, unwrapped, `Unsupported payload expression: ${unwrapped.getKindName()}.`);
}

function resolveObjectLiteral(node: Node | undefined): import('ts-morph').ObjectLiteralExpression | undefined {
  if (!node) return undefined;
  const unwrapped = unwrapExpression(node);
  if (Node.isObjectLiteralExpression(unwrapped)) return unwrapped;
  if (!Node.isIdentifier(unwrapped)) return undefined;
  const initializer = localVariableInitializer(unwrapped, unwrapped.getText());
  if (!initializer) return undefined;
  const resolved = unwrapExpression(initializer);
  return Node.isObjectLiteralExpression(resolved) ? resolved : undefined;
}

function propertyInitializer(object: import('ts-morph').ObjectLiteralExpression | undefined, name: string): Node | undefined {
  const property = object?.getProperties().find((candidate) => staticPropertyName(candidate) === name);
  if (!property || !Node.isPropertyAssignment(property)) return undefined;
  return property.getInitializer();
}

function propertyStaticValue(object: import('ts-morph').ObjectLiteralExpression | undefined, name: string): string | undefined {
  return staticValue(propertyInitializer(object, name));
}

function staticPropertyName(node: Node): string | undefined {
  if (Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node) || Node.isMethodDeclaration(node)
    || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    const name = node.getName();
    if (/^['"].*['"]$/.test(name)) return name.slice(1, -1);
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
  }
  return undefined;
}

function payloadPropertyValue(property: Node): { value?: ValueRef; sourceIdentity?: string } {
  if (Node.isShorthandPropertyAssignment(property)) {
    const sourceIdentity = sourceSymbolIdentity(property.getValueSymbol(), '');
    return {
      value: { kind: 'path', path: property.getName() },
      ...(sourceIdentity ? { sourceIdentity } : {}),
    };
  }
  if (!Node.isPropertyAssignment(property)) return {};
  const initializer = property.getInitializer();
  if (!initializer) return {};
  const value = unwrapExpression(initializer);
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
    return { value: { kind: 'literal', value: value.getLiteralText() } };
  }
  if (Node.isNumericLiteral(value)) return { value: { kind: 'literal', value: Number(value.getText()) } };
  if (value.getText() === 'true') return { value: { kind: 'literal', value: true } };
  if (value.getText() === 'false') return { value: { kind: 'literal', value: false } };
  if (value.getText() === 'null') return { value: { kind: 'literal', value: null } };
  if (Node.isIdentifier(value) || Node.isPropertyAccessExpression(value)) {
    const sourceIdentity = sourceValueIdentity(value);
    return {
      value: { kind: 'path', path: value.getText().replace(/\?\./g, '.') },
      ...(sourceIdentity ? { sourceIdentity } : {}),
    };
  }
  return {};
}

function localVariableInitializer(identifier: Node, name: string): Node | undefined {
  if (!Node.isIdentifier(identifier)) return undefined;
  const declarations = identifier.getSymbol()?.getDeclarations() ?? [];
  const variable = declarations.find((declaration) => (
    Node.isVariableDeclaration(declaration)
    && declaration.getName() === name
    && declaration.getSourceFile() === identifier.getSourceFile()
    && declaration.getStart() < identifier.getStart()
  ));
  return Node.isVariableDeclaration(variable) ? variable.getInitializer() : undefined;
}

function unwrapExpression(node: Node): Node {
  let current = node;
  while (Node.isParenthesizedExpression(current) || Node.isAsExpression(current) || Node.isTypeAssertion(current) || Node.isNonNullExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

function unwrapJsonSerialization(node: Node): Node {
  const unwrapped = unwrapExpression(node);
  if (Node.isCallExpression(unwrapped) && unwrapped.getExpression().getText() === 'JSON.stringify') {
    return unwrapped.getArguments()[0] ?? unwrapped;
  }
  return unwrapped;
}

function emptyPayloadShape(relativePath: string, node: Node, reason: string): RequestPayloadShape {
  return {
    certainty: 'exact',
    fields: [],
    expression: '',
    reason,
    sourceRefs: [sourceRef(relativePath, node)],
  };
}

function unknownPayloadShape(relativePath: string, node: Node, reason: string): RequestPayloadShape {
  return {
    certainty: 'unknown',
    fields: [],
    expression: node.getText(),
    reason,
    sourceRefs: [sourceRef(relativePath, node)],
  };
}

function functionParameterNames(node: Node): string[] {
  if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node) || Node.isMethodDeclaration(node)) {
    return node.getParameters().map((parameter) => parameter.getName());
  }
  return [];
}

function simpleCalleeName(expression: string): string {
  return expression.split('.').at(-1) ?? expression;
}

function resolveCallTarget(call: CallExpression): { symbol?: string; file?: string } | undefined {
  const expression = call.getExpression();
  const identifier = Node.isIdentifier(expression)
    ? expression
    : Node.isPropertyAccessExpression(expression)
      ? expression.getNameNode()
      : undefined;
  if (!identifier) return undefined;
  const symbol = identifier.getSymbol();
  const targetSymbol = symbol?.getAliasedSymbol() ?? symbol;
  const declaration = targetSymbol?.getDeclarations().find((candidate) => (
    Node.isFunctionDeclaration(candidate)
    || Node.isVariableDeclaration(candidate)
    || Node.isMethodDeclaration(candidate)
    || Node.isPropertyAssignment(candidate)
  ));
  if (!declaration) return undefined;
  const targetName = Node.isFunctionDeclaration(declaration) || Node.isMethodDeclaration(declaration)
    ? declaration.getName()
    : Node.isVariableDeclaration(declaration)
      ? declaration.getName()
      : Node.isPropertyAssignment(declaration)
        ? declaration.getName()
      : undefined;
  const file = declaration.getSourceFile().getFilePath().replace(/^\//, '');
  return {
    ...(targetName ? { symbol: targetName } : {}),
    ...(file ? { file } : {}),
  };
}

function dedupePayloadFields(fields: RequestPayloadShape['fields']): RequestPayloadShape['fields'] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.name)) return false;
    seen.add(field.name);
    return true;
  });
}

function dedupeSourceRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.file}:${ref.line}:${ref.endLine ?? ''}:${ref.symbol ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupe<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface NavigationTargetAlternative {
  target?: string;
  expression: string;
  guard: Predicate;
  status: 'exact' | 'conditional';
  reason?: string;
}

function extractDeclarativeNavigations(
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
  tag: string,
  relativePath: string,
  pageId: string,
  renderGuard: Predicate = TRUE,
): { navigations: NavigationFact[]; diagnostics: Diagnostic[] } {
  const componentOverride = jsxAttributeNodeExpression(opening.getAttribute('component'))?.getText().split('.').at(-1);
  const baseTag = componentOverride ?? tag.split('.').at(-1);
  const attributeName = baseTag === 'a' ? 'href' : ['Link', 'NavLink', 'Navigate'].includes(baseTag ?? '') ? 'to' : undefined;
  if (!attributeName) return { navigations: [], diagnostics: [] };
  const attribute = opening.getAttribute(attributeName);
  if (!attribute || !Node.isJsxAttribute(attribute)) {
    const id = stableId('navigation', `${relativePath}:${opening.getStart()}:declarative:missing-${attributeName}`);
    return {
      navigations: [{
        id,
        fromPageId: pageId,
        target: '<dynamic>',
        targetStatus: 'conditional',
        targetExpression: `<${tag}> without ${attributeName}`,
        trigger: 'declarative',
        guard: allPredicates([
          renderGuard,
          conditionalGuard(opening),
          opaquePredicate(`<${tag}>`, `Declarative navigation has no ${attributeName} target.`),
        ]),
        continuationStatus: 'conditional',
        sourceRef: sourceRef(relativePath, opening, tag),
      }],
      diagnostics: [{
        code: 'DECLARATIVE_NAVIGATION_TARGET_UNRESOLVED',
        severity: 'warning',
        message: `<${tag}> has no ${attributeName} target that can be connected to a route.`,
        evidenceRefs: [id],
        scope: pageId,
      }],
    };
  }

  const alternatives = declarativeNavigationTargets(attribute);
  const navigations = alternatives.map((alternative, index): NavigationFact => {
    const target = alternative.target ? normalizeNavigationTarget(alternative.target) : '<dynamic>';
    return {
      id: stableId('navigation', `${relativePath}:${opening.getStart()}:declarative:${index}:${target}:${alternative.expression}`),
      fromPageId: pageId,
      target,
      targetStatus: alternative.status,
      targetExpression: alternative.expression,
      trigger: 'declarative',
      guard: allPredicates([
        renderGuard,
        conditionalGuard(opening),
        alternative.guard,
        ...(alternative.status === 'conditional'
          ? [opaquePredicate(alternative.expression, alternative.reason ?? 'Declarative navigation target is computed at runtime.')]
          : []),
      ]),
      continuationStatus: alternative.status,
      sourceRef: sourceRef(relativePath, opening, alternative.target ?? tag),
    };
  });
  const diagnostics = alternatives.flatMap((alternative, index): Diagnostic[] => alternative.status === 'conditional' ? [{
    code: 'DECLARATIVE_NAVIGATION_TARGET_UNRESOLVED',
    severity: 'warning',
    message: alternative.reason ?? `The ${attributeName} target ${alternative.expression} is computed at runtime.`,
    evidenceRefs: [navigations[index]!.id],
    scope: pageId,
  }] : []);
  return { navigations, diagnostics };
}

function declarativeNavigationTargets(attribute: JsxAttribute): NavigationTargetAlternative[] {
  const initializer = attribute.getInitializer();
  if (!initializer) {
    return [{
      expression: attribute.getText(),
      guard: TRUE,
      status: 'conditional',
      reason: 'Declarative navigation target is a bare JSX attribute.',
    }];
  }
  if (Node.isStringLiteral(initializer)) {
    const target = initializer.getLiteralText();
    const absolute = isContextIndependentNavigationTarget(target);
    return [{
      target,
      expression: initializer.getText(),
      guard: TRUE,
      status: absolute ? 'exact' : 'conditional',
      ...(!absolute ? { reason: `Relative navigation target ${target || '<empty>'} requires the active route context.` } : {}),
    }];
  }
  if (!Node.isJsxExpression(initializer) || !initializer.getExpression()) {
    return [{
      expression: initializer.getText(),
      guard: TRUE,
      status: 'conditional',
      reason: 'Declarative navigation target uses an unsupported JSX initializer.',
    }];
  }
  return navigationExpressionAlternatives(initializer.getExpression()!);
}

function navigationExpressionAlternatives(expression: Node): NavigationTargetAlternative[] {
  const unwrapped = unwrapExpression(expression);
  if (Node.isConditionalExpression(unwrapped)) {
    const predicate = predicateFromExpression(unwrapped.getCondition().getText());
    return [
      ...navigationExpressionAlternatives(unwrapped.getWhenTrue()).map((alternative) => ({
        ...alternative,
        guard: allPredicates([predicate, alternative.guard]),
      })),
      ...navigationExpressionAlternatives(unwrapped.getWhenFalse()).map((alternative) => ({
        ...alternative,
        guard: allPredicates([{ kind: 'not' as const, operand: predicate }, alternative.guard]),
      })),
    ];
  }
  const target = staticNavigationValue(unwrapped);
  if (target !== undefined) {
    const absolute = isContextIndependentNavigationTarget(target);
    return [{
      target,
      expression: unwrapped.getText(),
      guard: TRUE,
      status: absolute ? 'exact' : 'conditional',
      ...(!absolute ? { reason: `Relative navigation target ${target || '<empty>'} requires the active route context.` } : {}),
    }];
  }
  const mappedTargets = staticMappedPropertyValues(unwrapped);
  if (mappedTargets.length) {
    return mappedTargets.map((value) => {
      const absolute = isContextIndependentNavigationTarget(value);
      return {
        target: value,
        expression: unwrapped.getText(),
        guard: TRUE,
        status: absolute ? 'exact' as const : 'conditional' as const,
        ...(!absolute ? { reason: `Relative navigation target ${value || '<empty>'} requires the active route context.` } : {}),
      };
    });
  }
  return [{
    expression: unwrapped.getText(),
    guard: TRUE,
    status: 'conditional',
    reason: `Declarative navigation target ${unwrapped.getText()} is computed at runtime.`,
  }];
}

function staticMappedPropertyValues(expression: Node): string[] {
  if (!Node.isIdentifier(expression)) return [];
  const callback = expression.getFirstAncestor((ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor));
  if (!callback || (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback))) return [];
  const call = callback.getParentIfKind(SyntaxKind.CallExpression);
  const callee = call?.getExpression();
  if (!call || !callee || !Node.isPropertyAccessExpression(callee) || callee.getName() !== 'map') return [];
  const parameter = callback.getParameters()[0];
  if (!parameter) return [];
  const binding = parameter.getNameNode();
  let propertyName: string | undefined;
  if (Node.isObjectBindingPattern(binding)) {
    const element = binding.getElements().find((candidate) => (
      candidate.getNameNode().getText() === expression.getText()
    ));
    propertyName = element?.getPropertyNameNode()?.getText() ?? element?.getNameNode().getText();
  } else if (Node.isIdentifier(binding)) {
    const access = expression.getFirstAncestorByKind(SyntaxKind.PropertyAccessExpression);
    if (access?.getExpression().getText() === binding.getText()) propertyName = access.getName();
  }
  if (!propertyName) return [];
  const array = resolveStaticArray(callee.getExpression());
  if (!array) return [];
  return array.getElements().flatMap((element) => {
    const object = resolveObjectLiteral(element);
    const value = object ? staticValue(propertyInitializer(object, propertyName!)) : undefined;
    return value === undefined ? [] : [value];
  });
}

function staticNavigationValue(node: Node): string | undefined {
  const direct = staticValue(node);
  if (direct !== undefined) return direct;
  const scalar = staticScalar(node);
  if (typeof scalar === 'string') return scalar;
  if (!Node.isObjectLiteralExpression(node)) return undefined;
  return propertyStaticValue(node, 'pathname');
}

function normalizeNavigationTarget(value: string): string {
  if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|#)/.test(value)) return value;
  return value.startsWith('/') ? normalizeRoute(value) : value;
}

function isContextIndependentNavigationTarget(value: string): boolean {
  return value.startsWith('/') || /^(?:[A-Za-z][A-Za-z\d+.-]*:|#)/.test(value);
}

function opaquePredicate(sourceExpression: string, reason: string): Predicate {
  return { kind: 'opaque', sourceExpression, reason };
}

function extractNavigation(call: CallExpression, relativePath: string, pageId?: string): NavigationFact | undefined {
  const expression = call.getExpression().getText();
  if (!(expression === 'navigate' || expression.endsWith('.navigate') || expression.endsWith('.push') || expression.endsWith('.replace'))) return undefined;
  const target = staticValue(call.getArguments()[0]);
  if (!target) return undefined;
  const handlerNode = enclosingFunctionNode(call);
  const exactTarget = isContextIndependentNavigationTarget(target);
  const guard = allPredicates([
    conditionalGuard(call),
    ...(handlerNode ? [callReachabilityGuard(call, handlerNode)] : []),
    ...(!exactTarget ? [opaquePredicate(target || '<empty>', 'Relative navigation requires the active route context.')] : []),
  ]);
  const successAfterCall = immediatelyPrecedingAwaitedCall(call);
  const normalizedTarget = normalizeNavigationTarget(target);
  return {
    id: stableId('navigation', `${relativePath}:${call.getStart()}:${normalizedTarget}`),
    ...(pageId ? { fromPageId: pageId } : {}),
    target: normalizedTarget,
    targetStatus: exactTarget ? 'exact' : 'conditional',
    targetExpression: call.getArguments()[0]?.getText() ?? target,
    trigger: 'imperative',
    guard,
    ...(successAfterCall?.symbol ? { successAfterCallSymbol: successAfterCall.symbol } : {}),
    ...(successAfterCall?.file ? { successAfterCallFile: successAfterCall.file } : {}),
    continuationStatus: exactTarget && successAfterCall?.symbol && successAfterCall.file ? 'exact' : 'conditional',
    sourceRef: sourceRef(relativePath, call, target),
  };
}

function immediatelyPrecedingAwaitedCall(navigationCall: CallExpression): { symbol?: string; file?: string } | undefined {
  const statement = navigationCall.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
  const block = statement?.getParentIfKind(SyntaxKind.Block);
  if (!statement || !block) return undefined;
  const statements = block.getStatements();
  const index = statements.findIndex((candidate) => candidate === statement);
  if (index <= 0) return undefined;
  const previous = statements[index - 1]!;
  const awaitedCalls = previous.getDescendantsOfKind(SyntaxKind.AwaitExpression).flatMap((awaitExpression) => {
    const expression = awaitExpression.getExpression();
    return Node.isCallExpression(expression) ? [expression] : expression.getDescendantsOfKind(SyntaxKind.CallExpression).slice(0, 1);
  });
  if (awaitedCalls.length !== 1) return undefined;
  const awaited = awaitedCalls[0]!;
  const target = resolveCallTarget(awaited);
  if (!target?.symbol || !target.file) return undefined;
  return target;
}

function callReachabilityGuard(call: CallExpression, handlerNode: Node) {
  const statement = call.getFirstAncestor((ancestor) => (
    Node.isExpressionStatement(ancestor)
    || Node.isVariableStatement(ancestor)
    || Node.isReturnStatement(ancestor)
    || Node.isThrowStatement(ancestor)
  ));
  const block = statement?.getParentIfKind(SyntaxKind.Block);
  if (!statement || !block || !containsNode(handlerNode, statement)) return TRUE;
  const statements = block.getStatements();
  const index = statements.findIndex((candidate) => candidate === statement);
  const terminator = statements.slice(0, Math.max(0, index)).find((candidate) => (
    Node.isReturnStatement(candidate)
    || Node.isThrowStatement(candidate)
    || candidate.getDescendants().some((descendant) => Node.isReturnStatement(descendant) || Node.isThrowStatement(descendant))
  ));
  return terminator
    ? {
        kind: 'opaque' as const,
        domain: 'unknown' as const,
        sourceExpression: call.getText(),
        reason: `A preceding statement in the same block can return or throw before this call; reachability is not proved.`,
      }
    : TRUE;
}

function normalCompletionProof(node: Node): { status: 'exact' | 'conditional'; reason?: string } {
  const body = (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node) || Node.isMethodDeclaration(node))
    ? node.getBody()
    : undefined;
  if (body && Node.isArrowFunction(node) && !Node.isBlock(body)) return { status: 'exact' };
  if (!body || !Node.isBlock(body)) return { status: 'conditional', reason: 'Handler body is not a statically inspectable block.' };
  const statements = body.getStatements();
  const firstTerminator = statements.find((statement) => Node.isReturnStatement(statement) || Node.isThrowStatement(statement));
  if (firstTerminator && Node.isThrowStatement(firstTerminator)) {
    return { status: 'conditional', reason: 'Handler has an unconditional top-level throw before any normal return.' };
  }
  if (firstTerminator && Node.isReturnStatement(firstTerminator) && !firstTerminator.getExpression()) {
    return { status: 'conditional', reason: 'Handler has an unconditional empty return; downstream call reachability requires review.' };
  }
  return { status: 'exact' };
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
  navigationIds: string[],
  renderGuard: Predicate = TRUE,
): ReactActionFact | undefined {
  const lowerTag = tag.toLowerCase();
  const baseTag = tag.split('.').at(-1) ?? tag;
  if (lowerTag === 'form' || baseTag === 'Navigate') return undefined;

  const ownEventAttribute = opening.getAttributes().find((attribute) =>
    Node.isJsxAttribute(attribute) && /^on(Click|Submit|Change|Select|KeyDown)$/.test(attribute.getNameNode().getText()),
  );
  const inputType = tag === 'input' ? jsxAttributeValue(opening.getAttribute('type'))?.toLowerCase() ?? 'text' : undefined;
  const inputAction = tag === 'input' && ['submit', 'button', 'image'].includes(inputType ?? '');
  const fieldLike = ['input', 'select', 'textarea'].includes(tag) || /(Input|Select|Picker|Field|Checkbox|Radio)$/.test(tag);
  if (fieldLike && !inputAction) return undefined;
  const isSemanticAction = ['button', 'a'].includes(tag) || inputAction || /(Button|Link|NavLink|MenuItem|Action)$/.test(tag);
  if (!ownEventAttribute && !isSemanticAction && !navigationIds.length) return undefined;
  if (baseTag === 'Route') return undefined;

  const submitContext = isSubmitControl(opening, tag)
    ? enclosingFormSubmitAttribute(opening)
    : undefined;
  const eventAttribute = ownEventAttribute ?? submitContext;

  const event = submitContext
    ? 'submit'
    : Node.isJsxAttribute(eventAttribute)
      ? eventAttribute.getNameNode().getText().replace(/^on/, '').toLowerCase()
      : 'click';
  const handlerExpression = Node.isJsxAttribute(eventAttribute) ? jsxAttributeNodeExpression(eventAttribute) : undefined;
  const callableHandlerExpression = eventHandlerCallback(handlerExpression) ?? handlerExpression;
  const handlerText = Node.isJsxAttribute(eventAttribute) ? jsxAttributeExpression(eventAttribute) : undefined;
  const handlerName = callableHandlerExpression && (Node.isArrowFunction(callableHandlerExpression) || Node.isFunctionExpression(callableHandlerExpression))
    ? inlineHandlerName(callableHandlerExpression)
    : callableHandlerExpression ? directCallableIdentifier(callableHandlerExpression.getText()) : undefined;
  const resolvedHandlerId = callableHandlerExpression ? handlerIdentityFromExpression(callableHandlerExpression, relativePath) : undefined;
  const namedHandlers = handlerName ? handlers.filter((candidate) => candidate.name === handlerName) : [];
  const handler = (resolvedHandlerId ? handlers.find((candidate) => candidate.id === resolvedHandlerId) : undefined)
    ?? (namedHandlers.length === 1 ? namedHandlers[0] : undefined);
  const handlerResolution = eventAttribute ? (handler ? 'exact' : 'conditional') : undefined;
  const disabled = booleanAttributePredicate(opening.getAttribute('disabled'));
  const submitClickGuard = submitContext && ownEventAttribute && ownEventAttribute !== submitContext
    ? opaquePredicate(
        jsxAttributeExpression(ownEventAttribute) ?? ownEventAttribute.getText(),
        'A submit control also has its own event handler, which may prevent or transform form submission.',
      )
    : undefined;
  const accessibleName = jsxAttributeValue(opening.getAttribute('aria-label'))
    ?? jsxAttributeValue(opening.getAttribute('title'))
    ?? jsxText(jsx)
    ?? (inputAction ? jsxAttributeValue(opening.getAttribute('value')) : undefined)
    ?? handlerName;
  return {
    id: stableId('action', `${relativePath}:${opening.getStart()}:${event}:${accessibleName ?? tag}`),
    pageId,
    component: tag,
    event,
    ...(accessibleName ? { accessibleName } : {}),
    ...(handlerName ? { handlerName } : {}),
    ...(handler ? { handlerId: handler.id } : {}),
    ...(handlerResolution ? { handlerResolution } : {}),
    ...(handlerText ? { handlerExpression: handlerText } : {}),
    ...(navigationIds.length ? { navigationIds } : {}),
    visibleWhen: [allPredicates([renderGuard, ...visibilityPredicates(opening)])],
    enabledWhen: [allPredicates([
      ...(disabled ? [{ kind: 'not' as const, operand: disabled }] : []),
      ...(submitClickGuard ? [submitClickGuard] : []),
    ])],
    sourceRef: sourceRef(relativePath, opening, accessibleName),
  };
}

function eventHandlerCallback(expression: Node | undefined): Node | undefined {
  if (!expression || !Node.isCallExpression(expression)) return undefined;
  const factory = expression.getExpression().getText().split('.').at(-1);
  if (!['handleSubmit'].includes(factory ?? '')) return undefined;
  const callback = expression.getArguments()[0];
  return callback && (Node.isIdentifier(callback) || Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))
    ? callback
    : undefined;
}

function isSubmitControl(
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
  tag: string,
): boolean {
  const lower = tag.toLowerCase();
  const type = jsxAttributeValue(opening.getAttribute('type'))?.toLowerCase();
  if (tag === 'button') return type === undefined || type === 'submit';
  if (tag === 'input') return type === 'submit' || type === 'image';
  return /Button$/.test(tag) && type === 'submit';
}

function isUnresolvedChildComponent(
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
  tag: string,
  action: ReactActionFact | undefined,
  field: ReactFieldFact | undefined,
  declarativeNavigations: NavigationFact[],
  transparentComponents: string[],
  sourceMap: Map<string, SourceFile>,
): boolean {
  if (!/^[A-Z]/.test(tag) && !tag.includes('.')) return false;
  const baseTag = tag.split('.').at(-1) ?? tag;
  if (['Fragment', 'Suspense', 'Route', 'Routes', 'Outlet', 'Link', 'NavLink', 'Navigate'].includes(baseTag)) return false;
  if (transparentComponents.includes(tag) || transparentComponents.includes(baseTag)) return false;
  if (resolveApplicationComponent(opening, sourceMap)) return false;
  const importedFrom = importedModuleForJsxTag(opening, tag);
  if (importedFrom?.startsWith('@mui/')) return false;
  return !action && !field && declarativeNavigations.length === 0;
}

function importedModuleForJsxTag(
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
  tag: string,
): string | undefined {
  const rootName = tag.split('.')[0];
  return opening.getSourceFile().getImportDeclarations().find((declaration) => (
    declaration.getDefaultImport()?.getText() === rootName
    || declaration.getNamespaceImport()?.getText() === rootName
    || declaration.getNamedImports().some((named) => (
      named.getAliasNode()?.getText() === rootName || named.getName() === rootName
    ))
  ))?.getModuleSpecifierValue();
}

function isUnresolvedNativeControl(
  tag: string,
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
): boolean {
  if (!['input', 'select', 'textarea'].includes(tag)) return false;
  if (tag !== 'input') return true;
  const inputType = jsxAttributeValue(opening.getAttribute('type'))?.toLowerCase() ?? 'text';
  return !['submit', 'button', 'image', 'reset'].includes(inputType);
}

function enclosingFormSubmitAttribute(opening: Node): JsxAttribute | undefined {
  const form = opening.getFirstAncestor((ancestor) => (
    Node.isJsxElement(ancestor)
    && ancestor.getOpeningElement().getTagNameNode().getText().toLowerCase() === 'form'
  ));
  if (!form || !Node.isJsxElement(form)) return undefined;
  const attribute = form.getOpeningElement().getAttribute('onSubmit');
  return attribute && Node.isJsxAttribute(attribute) ? attribute : undefined;
}

function extractField(
  jsx: JsxElement | JsxSelfClosingElement,
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
  tag: string,
  relativePath: string,
  pageId: string,
  renderGuard: Predicate = TRUE,
): ReactFieldFact | undefined {
  const lower = tag.toLowerCase();
  const fieldLike = ['input', 'select', 'textarea'].includes(tag) || /(Input|Select|Picker|Field|Checkbox|Radio)$/.test(tag);
  if (!fieldLike) return undefined;
  if (tag === 'input' && ['submit', 'button', 'image'].includes(jsxAttributeValue(opening.getAttribute('type'))?.toLowerCase() ?? '')) return undefined;
  const valueBinding = fieldValueBinding(opening);
  const dataPath = jsxAttributeValue(opening.getAttribute('name'))
    ?? jsxAttributeValue(opening.getAttribute('data-path'))
    ?? jsxAttributeValue(opening.getAttribute('id'))
    ?? registeredFieldPath(opening)
    ?? valueBinding?.path;
  if (!dataPath) return undefined;
  const required = opening.getAttribute('required');
  const requiredWhen = required ? requiredAttributePredicates(required, opening) : [];
  const controlKind = tag === 'input' ? jsxAttributeValue(opening.getAttribute('type'))?.toLowerCase() ?? 'textbox' : tag;
  const optionSource = fieldOptionSource(jsx, opening, tag, relativePath);
  const constraints = extractFieldConstraints(opening, tag, dataPath, relativePath);
  if (requiredWhen.length) {
    constraints.push({
      id: stableId('constraint', `${relativePath}:${dataPath}:required`),
      fieldPath: dataPath,
      kind: 'required',
      value: true,
      sourceRef: sourceRef(relativePath, opening, dataPath),
    });
  }
  if (optionSource?.status === 'static') {
    constraints.push({
      id: stableId('constraint', `${relativePath}:${pageId}:${dataPath}:options:${optionSource.options.map((option) => String(option.value)).join('|')}`),
      fieldPath: dataPath,
      kind: 'enum',
      domain: 'value-set',
      value: optionSource.options.map((option) => String(option.value)),
      message: `Value must be one of the statically declared ${dataPath} options.`,
      sourceRef: optionSource.sourceRefs[0] ?? sourceRef(relativePath, opening, dataPath),
    });
  } else if (optionSource && optionSource.status !== 'runtime') {
    constraints.push({
      id: stableId('constraint', `${relativePath}:${pageId}:${dataPath}:options:${optionSource.status}:${optionSource.expression ?? ''}`),
      fieldPath: dataPath,
      kind: 'opaque',
      domain: 'value-set',
      message: optionSource.reason ?? `The selectable values for ${dataPath} are not statically complete.`,
      sourceRef: optionSource.sourceRefs[0] ?? sourceRef(relativePath, opening, dataPath),
    });
  }
  const inputMode = fieldInputMode(opening, valueBinding);
  const choice = isChoiceControl(controlKind);
  return {
    id: stableId('field', `${relativePath}:${pageId}:${dataPath}:${controlKind}${choice ? `:${opening.getStart()}` : ''}`),
    pageId,
    dataPath,
    ...(fieldLabel(jsx, opening) ? { label: fieldLabel(jsx, opening)! } : {}),
    controlKind,
    inputMode,
    ...(optionSource ? { optionSource } : {}),
    ...(valueBinding ? { valueBinding } : {}),
    visibleWhen: [allPredicates([renderGuard, ...visibilityPredicates(opening)])],
    requiredWhen,
    constraints,
    sourceRef: sourceRef(relativePath, opening, dataPath),
  };
}

function registeredFieldPath(
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
): string | undefined {
  for (const attribute of opening.getAttributes().filter(Node.isJsxSpreadAttribute)) {
    const expression = unwrapExpression(attribute.getExpression());
    if (!Node.isCallExpression(expression)) continue;
    const callee = expression.getExpression().getText();
    if (callee !== 'register' && !callee.endsWith('.register')) continue;
    const value = staticValue(expression.getArguments()[0]);
    if (value) return value;
  }
  return undefined;
}

function fieldOptionSource(
  jsx: JsxElement | JsxSelfClosingElement,
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
  tag: string,
  relativePath: string,
): ReactFieldFact['optionSource'] | undefined {
  const lower = tag.toLowerCase();
  const inputType = tag === 'input' ? jsxAttributeValue(opening.getAttribute('type'))?.toLowerCase() : undefined;
  const choiceControl = inputType === 'radio' || inputType === 'checkbox' || /(Radio|Checkbox)$/.test(tag);
  if (choiceControl) {
    const valueAttribute = opening.getAttribute('value');
    const value = valueAttribute ? jsxAttributeScalar(valueAttribute) : 'on';
    if (value !== undefined) {
      return {
        status: 'static',
        options: [{
          value,
          ...(fieldLabel(jsx, opening) ? { label: fieldLabel(jsx, opening)! } : {}),
          sourceRef: sourceRef(relativePath, opening, String(value)),
        }],
        sourceRefs: [sourceRef(relativePath, opening, String(value))],
      };
    }
    const expression = jsxAttributeExpression(valueAttribute) ?? valueAttribute?.getText() ?? `${tag}.value`;
    return {
      status: 'runtime',
      options: [],
      expression,
      reason: `Choice value ${expression} is computed at runtime.`,
      sourceRefs: [sourceRef(relativePath, opening, tag)],
    };
  }

  if (tag === 'select') return optionChildrenSource(jsx, relativePath, tag);
  if (!/(Select|Picker)$/.test(tag)) return undefined;

  const optionAttribute = ['options', 'items', 'choices', 'data']
    .map((name) => opening.getAttribute(name))
    .find((attribute): attribute is JsxAttribute => Boolean(attribute && Node.isJsxAttribute(attribute)));
  if (!optionAttribute) {
    const children = optionChildrenSource(jsx, relativePath, tag);
    if (children.status !== 'unknown' || children.options.length) return children;
    const binding = fieldValueBinding(opening);
    if (binding?.writable) {
      return {
        status: 'runtime',
        options: [],
        expression: `external-options:${tag}:${binding.path}`,
        reason: `${tag} is a controlled selector whose option catalog must be resolved from application/runtime data.`,
        sourceRefs: [sourceRef(relativePath, opening, tag), binding.sourceRef],
      };
    }
    return {
      status: 'unknown',
      options: [],
      reason: `${tag} exposes no static options/items/choices/data property or Option children.`,
      sourceRefs: [sourceRef(relativePath, opening, tag)],
    };
  }
  return optionAttributeSource(optionAttribute, relativePath, tag);
}

function optionChildrenSource(
  jsx: JsxElement | JsxSelfClosingElement,
  relativePath: string,
  tag: string,
): NonNullable<ReactFieldFact['optionSource']> {
  if (!Node.isJsxElement(jsx)) {
    return {
      status: 'unknown',
      options: [],
      reason: `${tag} is self-closing and has no static option source.`,
      sourceRefs: [sourceRef(relativePath, jsx, tag)],
    };
  }
  const optionElements = jsx.getDescendantsOfKind(SyntaxKind.JsxElement).filter((element) => (
    element.getOpeningElement().getTagNameNode().getText().split('.').at(-1) === 'option'
    || element.getOpeningElement().getTagNameNode().getText().split('.').at(-1) === 'Option'
  ));
  const options = optionElements.flatMap((element) => {
    const opening = element.getOpeningElement();
    const attribute = opening.getAttribute('value');
    const value = attribute ? jsxAttributeScalar(attribute) : jsxText(element);
    if (value === undefined) return [];
    const label = jsxText(element) ?? jsxAttributeValue(opening.getAttribute('label'));
    return [{
      value,
      ...(label ? { label } : {}),
      sourceRef: sourceRef(relativePath, opening, String(value)),
    }];
  });
  const dynamicExpressions = jsx.getDescendantsOfKind(SyntaxKind.JsxExpression).filter((expression) => (
    !expression.getFirstAncestorByKind(SyntaxKind.JsxAttribute)
    &&
    !expression.getFirstAncestor((ancestor) => (
      Node.isJsxElement(ancestor)
      && ['option', 'Option'].includes(ancestor.getOpeningElement().getTagNameNode().getText().split('.').at(-1) ?? '')
    ))
    && Boolean(expression.getExpression())
  ));
  const unresolvedOptions = optionElements.length !== options.length;
  const dynamic = unresolvedOptions || dynamicExpressions.length > 0;
  const expressions = dynamicExpressions.map((expression) => expression.getExpression()?.getText()).filter((value): value is string => Boolean(value));
  const sourceRefs = dedupeSourceRefs([
    ...options.map((option) => option.sourceRef),
    ...dynamicExpressions.map((expression) => sourceRef(relativePath, expression, tag)),
    ...(optionElements.length || dynamicExpressions.length ? [] : [sourceRef(relativePath, jsx, tag)]),
  ]);
  if (!dynamic && optionElements.length) {
    return { status: 'static', options: dedupeOptions(options), sourceRefs };
  }
  return {
    status: options.length ? 'partial' : expressions.some((expression) => /(?:\.map\s*\(|options|items|choices)/i.test(expression)) ? 'runtime' : 'unknown',
    options: dedupeOptions(options),
    ...(expressions.length ? { expression: expressions.join('; ') } : {}),
    reason: options.length
      ? `${tag} contains both static and computed options.`
      : `${tag} option values are not statically enumerable.`,
    sourceRefs,
  };
}

function optionAttributeSource(attribute: JsxAttribute, relativePath: string, tag: string): NonNullable<ReactFieldFact['optionSource']> {
  const initializer = attribute.getInitializer();
  const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined;
  const array = expression ? resolveStaticArray(expression) : undefined;
  if (expression && array) {
    const options = array.getElements().flatMap((element) => staticArrayOption(element, relativePath));
    const complete = options.length === array.getElements().length;
    return {
      status: complete ? 'static' : options.length ? 'partial' : 'unknown',
      options: dedupeOptions(options),
      expression: expression.getText(),
      ...(!complete ? { reason: `${tag} contains option entries whose values or labels are computed.` } : {}),
      sourceRefs: dedupeSourceRefs([sourceRef(relativePath, attribute, tag), ...options.map((option) => option.sourceRef)]),
    };
  }
  const expressionText = expression?.getText() ?? initializer?.getText() ?? attribute.getText();
  const runtime = Boolean(expression && (
    Node.isIdentifier(expression)
    || Node.isPropertyAccessExpression(expression)
    || Node.isCallExpression(expression)
  ));
  return {
    status: runtime ? 'runtime' : 'unknown',
    options: [],
    expression: expressionText,
    reason: `${tag} option source ${expressionText} is ${runtime ? 'resolved at runtime' : 'not statically enumerable'}.`,
    sourceRefs: [sourceRef(relativePath, attribute, tag)],
  };
}

function resolveStaticArray(node: Node, seen = new Set<string>()): import('ts-morph').ArrayLiteralExpression | undefined {
  const unwrapped = unwrapExpression(node);
  if (Node.isArrayLiteralExpression(unwrapped)) return unwrapped;
  if (!Node.isIdentifier(unwrapped)) return undefined;
  const key = `${unwrapped.getSourceFile().getFilePath()}:${unwrapped.getText()}:${unwrapped.getStart()}`;
  if (seen.has(key)) return undefined;
  const initializer = constantInitializer(unwrapped);
  if (!initializer) return undefined;
  if (Node.isArrayLiteralExpression(initializer)) return initializer;
  if (Node.isAsExpression(initializer)
    && initializer.getTypeNode()?.getText() === 'const'
    && Node.isArrayLiteralExpression(unwrapExpression(initializer))) {
    return unwrapExpression(initializer) as import('ts-morph').ArrayLiteralExpression;
  }
  if (Node.isCallExpression(initializer)
    && initializer.getExpression().getText() === 'Object.freeze'
    && initializer.getArguments()[0]
    && Node.isArrayLiteralExpression(unwrapExpression(initializer.getArguments()[0]!))) {
    return unwrapExpression(initializer.getArguments()[0]!) as import('ts-morph').ArrayLiteralExpression;
  }
  const next = new Set(seen);
  next.add(key);
  return resolveStaticArray(initializer, next);
}

function staticArrayOption(element: Node, relativePath: string): NonNullable<ReactFieldFact['optionSource']>['options'] {
  const scalar = staticScalar(unwrapExpression(element));
  if (scalar !== undefined) {
    return [{ value: scalar, label: String(scalar), sourceRef: sourceRef(relativePath, element, String(scalar)) }];
  }
  if (!Node.isObjectLiteralExpression(element)) return [];
  const valueProperty = ['value', 'id', 'code', 'key']
    .map((name) => propertyInitializer(element, name))
    .find((value) => value !== undefined);
  const value = valueProperty ? staticScalar(unwrapExpression(valueProperty)) : undefined;
  if (value === undefined) return [];
  const labelProperty = ['label', 'name', 'text']
    .map((name) => propertyInitializer(element, name))
    .find((candidate) => candidate !== undefined);
  const labelValue = labelProperty ? staticScalar(unwrapExpression(labelProperty)) : undefined;
  return [{
    value,
    ...(labelValue !== undefined ? { label: String(labelValue) } : {}),
    sourceRef: sourceRef(relativePath, element, String(value)),
  }];
}

function jsxAttributeScalar(attribute: Node | undefined): string | number | boolean | undefined {
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  if (!initializer) return true;
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralText();
  if (!Node.isJsxExpression(initializer) || !initializer.getExpression()) return undefined;
  return staticScalar(unwrapExpression(initializer.getExpression()!));
}

function staticScalar(node: Node, seen = new Set<string>()): string | number | boolean | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isNumericLiteral(node)) return Number(node.getText());
  if (node.getText() === 'true') return true;
  if (node.getText() === 'false') return false;
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    const key = `${node.getSourceFile().getFilePath()}:${node.getText()}:${node.getStart()}`;
    if (seen.has(key)) return undefined;
    const initializer = constantInitializer(node);
    if (!initializer) return undefined;
    const next = new Set(seen);
    next.add(key);
    return staticScalar(unwrapExpression(initializer), next);
  }
  return undefined;
}

function constantInitializer(node: Node): Node | undefined {
  const identifier = Node.isIdentifier(node)
    ? node
    : Node.isPropertyAccessExpression(node)
      ? node.getNameNode()
      : undefined;
  if (!identifier) return undefined;
  const symbol = identifier.getSymbol();
  const target = symbol?.getAliasedSymbol() ?? symbol;
  const declaration = target?.getDeclarations().find((candidate) => (
    Node.isVariableDeclaration(candidate)
    || Node.isEnumMember(candidate)
  ));
  if (!declaration) return undefined;
  if (Node.isVariableDeclaration(declaration)) {
    if (declaration.getVariableStatement()?.getDeclarationKind() !== VariableDeclarationKind.Const) return undefined;
    return declaration.getInitializer();
  }
  if (Node.isEnumMember(declaration)) return declaration.getInitializer();
  return undefined;
}

function fieldLabel(
  jsx: JsxElement | JsxSelfClosingElement,
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
): string | undefined {
  const direct = jsxAttributeValue(opening.getAttribute('label'))
    ?? jsxAttributeValue(opening.getAttribute('aria-label'))
    ?? jsxAttributeValue(opening.getAttribute('title'));
  if (direct) return direct;
  const wrappingLabel = opening.getFirstAncestor((ancestor) => (
    Node.isJsxElement(ancestor)
    && ancestor.getOpeningElement().getTagNameNode().getText().toLowerCase() === 'label'
  ));
  if (wrappingLabel && Node.isJsxElement(wrappingLabel)) {
    const text = jsxText(wrappingLabel);
    if (text) return text;
  }
  const id = jsxAttributeValue(opening.getAttribute('id'));
  if (!id) return undefined;
  const associated = opening.getSourceFile().getDescendantsOfKind(SyntaxKind.JsxElement).find((element) => {
    const labelOpening = element.getOpeningElement();
    return labelOpening.getTagNameNode().getText().toLowerCase() === 'label'
      && jsxAttributeValue(labelOpening.getAttribute('htmlFor')) === id;
  });
  return associated ? jsxText(associated) : undefined;
}

function dedupeOptions(options: NonNullable<ReactFieldFact['optionSource']>['options']): NonNullable<ReactFieldFact['optionSource']>['options'] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${typeof option.value}:${String(option.value)}:${option.label ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeConstraints(constraints: ReactFieldFact['constraints']): ReactFieldFact['constraints'] {
  return [...new Map(constraints.map((constraint) => [constraint.id, constraint])).values()];
}

function extractFieldConstraints(
  opening: ReturnType<JsxElement['getOpeningElement']> | JsxSelfClosingElement,
  tag: string,
  dataPath: string,
  relativePath: string,
): ReactFieldFact['constraints'] {
  const constraints: ReactFieldFact['constraints'] = [];
  const nativeControl = ['input', 'select', 'textarea'].includes(tag);
  const inputType = tag === 'input'
    ? jsxAttributeValue(opening.getAttribute('type'))?.toLowerCase() ?? 'text'
    : undefined;
  const attributes: Array<{
    name: string;
    kind: 'min' | 'max' | 'pattern';
    domain: 'length' | 'numeric' | 'format';
  }> = [
    { name: 'minLength', kind: 'min', domain: 'length' },
    { name: 'maxLength', kind: 'max', domain: 'length' },
    { name: 'pattern', kind: 'pattern', domain: 'format' },
    { name: 'min', kind: 'min', domain: 'numeric' },
    { name: 'max', kind: 'max', domain: 'numeric' },
  ];
  for (const spec of attributes) {
    const attribute = opening.getAttribute(spec.name);
    if (!attribute) continue;
    const supportedByNativeControl = nativeControl && (
      ((spec.name === 'minLength' || spec.name === 'maxLength') && (tag === 'input' || tag === 'textarea'))
      || (spec.name === 'pattern' && tag === 'input')
      || ((spec.name === 'min' || spec.name === 'max') && tag === 'input' && (inputType === 'number' || inputType === 'range'))
    );
    if (!supportedByNativeControl) {
      constraints.push(opaqueFieldConstraint(
        relativePath,
        attribute,
        dataPath,
        spec.name,
        `${spec.name} semantics on ${tag}${inputType ? ` type=${inputType}` : ''} are not proved by the React adapter.`,
      ));
      continue;
    }
    const staticText = jsxAttributeValue(attribute);
    const expression = jsxAttributeExpression(attribute);
    const numeric = spec.domain === 'numeric' || spec.domain === 'length';
    const parsed = staticText !== undefined && (!numeric || /^-?\d+(?:\.\d+)?$/.test(staticText))
      ? numeric ? Number(staticText) : staticText
      : undefined;
    if (parsed === undefined) {
      constraints.push(opaqueFieldConstraint(
        relativePath,
        opening,
        dataPath,
        spec.name,
        `The ${spec.name} constraint is computed or has an unsupported value (${expression ?? staticText ?? 'unknown'}).`,
      ));
      continue;
    }
    constraints.push({
      id: stableId('constraint', `${relativePath}:${dataPath}:${spec.name}:${String(parsed)}`),
      fieldPath: dataPath,
      kind: spec.kind,
      domain: spec.domain,
      value: parsed,
      sourceRef: sourceRef(relativePath, opening, dataPath),
    });
  }

  if (inputType === 'email' || inputType === 'number' || inputType === 'range') {
    const constraintType = inputType === 'email' ? 'email' : 'number';
    constraints.push({
      id: stableId('constraint', `${relativePath}:${dataPath}:type:${constraintType}`),
      fieldPath: dataPath,
      kind: inputType === 'email' ? 'format' : 'type',
      domain: inputType === 'email' ? 'format' : 'type',
      value: constraintType,
      message: `Value must satisfy the browser's ${constraintType} input syntax.`,
      sourceRef: sourceRef(relativePath, opening, dataPath),
    });
  }
  if (inputType && ['url', 'date', 'datetime-local', 'month', 'week', 'time', 'color'].includes(inputType)) {
    constraints.push(opaqueFieldConstraint(
      relativePath,
      opening,
      dataPath,
      `input-type-${inputType}`,
      `Browser input type ${inputType} has format semantics that the supported constraint engine does not reduce.`,
    ));
  }

  for (const unsupported of ['step', 'accept', 'multiple', 'validate', 'validator', 'validationSchema', 'schema', 'rules']) {
    const attribute = opening.getAttribute(unsupported);
    if (!attribute) continue;
    constraints.push(opaqueFieldConstraint(
      relativePath,
      opening,
      dataPath,
      unsupported,
      `The ${unsupported} validation contract is not reduced by the React adapter.`,
    ));
  }
  for (const attribute of opening.getAttributes().filter(Node.isJsxSpreadAttribute)) {
    const registered = extractRegisteredFieldConstraints(attribute, dataPath, relativePath);
    if (registered) {
      constraints.push(...registered);
      continue;
    }
    constraints.push(opaqueFieldConstraint(
      relativePath,
      attribute,
      dataPath,
      'spread-validation',
      `JSX spread ${attribute.getText()} may add validation attributes that are not statically enumerated.`,
    ));
  }
  return dedupeConstraints(constraints);
}

function extractRegisteredFieldConstraints(
  attribute: import('ts-morph').JsxSpreadAttribute,
  dataPath: string,
  relativePath: string,
): ReactFieldFact['constraints'] | undefined {
  const expression = unwrapExpression(attribute.getExpression());
  if (!Node.isCallExpression(expression)) return undefined;
  const callee = expression.getExpression().getText();
  if (callee !== 'register' && !callee.endsWith('.register')) return undefined;
  const registeredPath = staticValue(expression.getArguments()[0]);
  if (registeredPath !== dataPath) return undefined;
  const optionsNode = expression.getArguments()[1];
  if (!optionsNode) return [];
  const options = resolveObjectLiteral(optionsNode);
  if (!options) {
    return [opaqueFieldConstraint(
      relativePath,
      attribute,
      dataPath,
      'register-options',
      `React Hook Form options ${optionsNode.getText()} are not a static object literal.`,
    )];
  }
  const constraints: ReactFieldFact['constraints'] = [];
  for (const property of options.getProperties()) {
    const name = staticPropertyName(property);
    const initializer = Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
    if (!name || !initializer) {
      constraints.push(opaqueFieldConstraint(relativePath, property, dataPath, 'register-option', 'A React Hook Form validation option is computed.'));
      continue;
    }
    const unwrapped = unwrapExpression(initializer);
    const optionObject = resolveObjectLiteral(unwrapped);
    const optionValue = optionObject ? propertyInitializer(optionObject, 'value') : unwrapped;
    const scalar = optionValue ? staticScalar(unwrapExpression(optionValue)) : undefined;
    const source = sourceRef(relativePath, property, dataPath);
    if (name === 'required' && scalar !== false) {
      constraints.push({
        id: stableId('constraint', `${relativePath}:${dataPath}:register:required`),
        fieldPath: dataPath,
        kind: 'required',
        value: true,
        sourceRef: source,
      });
      continue;
    }
    const numeric = name === 'minLength' || name === 'maxLength' || name === 'min' || name === 'max';
    if (numeric && typeof scalar === 'number') {
      constraints.push({
        id: stableId('constraint', `${relativePath}:${dataPath}:register:${name}:${scalar}`),
        fieldPath: dataPath,
        kind: name === 'minLength' || name === 'min' ? 'min' : 'max',
        domain: name === 'minLength' || name === 'maxLength' ? 'length' : 'numeric',
        value: scalar,
        sourceRef: source,
      });
      continue;
    }
    constraints.push(opaqueFieldConstraint(
      relativePath,
      property,
      dataPath,
      `register-${name}`,
      `React Hook Form validation option ${name} is not in the supported static subset.`,
    ));
  }
  return constraints;
}

function opaqueFieldConstraint(
  relativePath: string,
  node: Node,
  dataPath: string,
  key: string,
  message: string,
): ReactFieldFact['constraints'][number] {
  return {
    id: stableId('constraint', `${relativePath}:${dataPath}:${key}:${node.getStart()}:${node.getText()}`),
    fieldPath: dataPath,
    kind: 'opaque',
    domain: 'unknown',
    message,
    sourceRef: sourceRef(relativePath, node, dataPath),
  };
}

function fieldInputMode(
  opening: Node,
  binding: ReactFieldFact['valueBinding'] | undefined,
): NonNullable<ReactFieldFact['inputMode']> {
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return 'conditional';
  const disabled = booleanAttributePredicate(opening.getAttribute('disabled'));
  const readOnly = booleanAttributePredicate(opening.getAttribute('readOnly') ?? opening.getAttribute('readonly'));
  const tag = opening.getTagNameNode().getText();
  const inputType = tag === 'input' ? jsxAttributeValue(opening.getAttribute('type'))?.toLowerCase() ?? 'text' : undefined;
  if (inputType === 'hidden') return 'read-only';
  if ((disabled?.kind === 'constant' && disabled.value) || (readOnly?.kind === 'constant' && readOnly.value)) return 'read-only';
  if ((disabled && disabled.kind !== 'constant') || (readOnly && readOnly.kind !== 'constant')) return 'conditional';
  if (binding && !binding.writable) return 'read-only';
  return 'editable';
}

function fieldValueBinding(opening: Node): ReactFieldFact['valueBinding'] | undefined {
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return undefined;
  const valueAttribute = opening.getAttribute('value') ?? opening.getAttribute('checked');
  if (!valueAttribute || !Node.isJsxAttribute(valueAttribute)) return undefined;
  const initializer = valueAttribute.getInitializer();
  if (!initializer || !Node.isJsxExpression(initializer)) return undefined;
  const expression = initializer.getExpression();
  if (!expression || !(Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression))) return undefined;
  const bindingPath = expression.getText().replace(/\?\./g, '.');
  const changeAttribute = opening.getAttribute('onChange') ?? opening.getAttribute('onSelect');
  const changeExpression = jsxAttributeExpression(changeAttribute);
  const leaf = bindingPath.split('.').at(-1) ?? bindingPath;
  const expectedSetter = `set${leaf.charAt(0).toUpperCase()}${leaf.slice(1)}`;
  const tag = opening.getTagNameNode().getText();
  const nativeControl = ['input', 'select', 'textarea'].includes(tag);
  const escapedSetter = expectedSetter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const setterCall = changeExpression?.match(new RegExp(`\\b${escapedSetter}\\s*\\(([^)]*)\\)`))?.[1];
  const writable = Boolean(changeExpression && (
    (!nativeControl && changeExpression.trim() === expectedSetter)
    || (setterCall && (nativeControl
      ? /(?:target|currentTarget)\.(?:value|valueAsNumber|checked)\b/.test(setterCall)
      : setterCall.trim().length > 0))
  ));
  const valueType = inferBindingValueType(expression, changeExpression, escapedSetter, nativeControl);
  const sourceIdentity = sourceValueIdentity(expression);
  return {
    path: bindingPath,
    writable,
    valueType,
    ...(sourceIdentity ? { sourceIdentity } : {}),
    sourceRef: sourceRef(expression.getSourceFile().getFilePath().replace(/^\//, ''), expression, bindingPath),
  };
}

/**
 * Identifies a source value by its resolved root declaration and property
 * suffix. Text such as `productCode` alone is not provenance: two components
 * can have unrelated local variables with the same name.
 */
function sourceValueIdentity(expression: Node): string | undefined {
  const value = unwrapExpression(expression);
  if (!Node.isIdentifier(value) && !Node.isPropertyAccessExpression(value)) return undefined;
  let root: Node = value;
  while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
  root = unwrapExpression(root);
  if (!Node.isIdentifier(root)) return undefined;
  const symbol = root.getSymbol();
  const normalizedPath = value.getText().replace(/\?\./g, '.');
  const normalizedRoot = root.getText();
  if (!normalizedPath.startsWith(normalizedRoot)) return undefined;
  return sourceSymbolIdentity(symbol, normalizedPath.slice(normalizedRoot.length));
}

function sourceSymbolIdentity(symbol: MorphSymbol | undefined, suffix: string): string | undefined {
  const target = symbol?.getAliasedSymbol() ?? symbol;
  const declarations = target?.getDeclarations() ?? [];
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0]!;
  const sourceFile = declaration.getSourceFile().getFilePath().replace(/^\//, '');
  return `${sourceFile}:${declaration.getStart()}${suffix}`;
}

function inferBindingValueType(
  valueExpression: Node,
  changeExpression: string | undefined,
  escapedSetter: string,
  nativeControl: boolean,
): Exclude<NonNullable<ReactFieldFact['valueBinding']>['valueType'], undefined> {
  if (changeExpression) {
    const setterPrefix = new RegExp(`\\b${escapedSetter}\\s*\\(`);
    if (setterPrefix.test(changeExpression)) {
      if (/\bparseInt\s*\(/.test(changeExpression)) return 'integer';
      if (/\b(?:Number|parseFloat)\s*\(/.test(changeExpression)) return 'number';
      if (/(?:target|currentTarget)\.valueAsNumber\b/.test(changeExpression)) return 'number';
      if (/(?:target|currentTarget)\.checked\b/.test(changeExpression)) return 'boolean';
      if (/(?:target|currentTarget)\.value\b/.test(changeExpression)) return 'string';
    }
  }
  const stateType = inferUseStateValueType(valueExpression);
  if (!nativeControl && changeExpression?.trim() && stateType !== 'unknown') return stateType;
  return stateType;
}

function inferUseStateValueType(expression: Node): Exclude<NonNullable<ReactFieldFact['valueBinding']>['valueType'], undefined> {
  if (!Node.isIdentifier(expression)) return 'unknown';
  const declaration = expression.getSymbol()?.getDeclarations().find(Node.isBindingElement);
  const variable = declaration?.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  const initializer = variable?.getInitializer();
  if (!initializer || !Node.isCallExpression(initializer) || !/(?:^|\.)useState$/.test(initializer.getExpression().getText())) return 'unknown';
  const typeText = initializer.getTypeArguments()[0]?.getText().replace(/\s+/g, '');
  if (typeText === 'string') return 'string';
  if (typeText === 'number') return 'number';
  if (typeText === 'boolean') return 'boolean';
  const initial = initializer.getArguments()[0];
  if (!initial) return 'unknown';
  const scalar = staticScalar(unwrapExpression(initial));
  if (typeof scalar === 'string') return 'string';
  if (typeof scalar === 'number') return 'number';
  if (typeof scalar === 'boolean') return 'boolean';
  return 'unknown';
}

function mergeChoiceFields(fields: ReactFieldFact[]): ReactFieldFact[] {
  const regular = fields.filter((field) => !isChoiceControl(field.controlKind));
  const groups = new Map<string, ReactFieldFact[]>();
  for (const field of fields.filter((candidate) => isChoiceControl(candidate.controlKind))) {
    const choiceKind = /radio/i.test(field.controlKind) ? 'radio' : 'checkbox';
    const key = `${field.pageId}:${field.dataPath}:${choiceKind}`;
    const values = groups.get(key) ?? [];
    values.push(field);
    groups.set(key, values);
  }
  const merged = [...groups.entries()].map(([key, members]): ReactFieldFact => {
    const first = members[0]!;
    const optionSources = members.flatMap((member) => member.optionSource ? [member.optionSource] : []);
    const options = dedupeOptions(optionSources.flatMap((source) => source.options));
    const statuses = new Set(optionSources.map((source) => source.status));
    const status: NonNullable<ReactFieldFact['optionSource']>['status'] = statuses.size === 1
      ? optionSources[0]?.status ?? 'unknown'
      : 'partial';
    const labels = [...new Set(members.map((member) => member.label).filter((label): label is string => Boolean(label)))];
    const bindings = members.map((member) => member.valueBinding).filter((binding): binding is NonNullable<ReactFieldFact['valueBinding']> => Boolean(binding));
    const binding = bindings.length && bindings.every((candidate) => (
      candidate.path === bindings[0]!.path
      && candidate.writable === bindings[0]!.writable
      && candidate.valueType === bindings[0]!.valueType
    )) ? bindings[0] : undefined;
    const inputModes = new Set(members.map((member) => member.inputMode ?? 'editable'));
    const inputMode: NonNullable<ReactFieldFact['inputMode']> = inputModes.size === 1
      ? members[0]?.inputMode ?? 'editable'
      : 'conditional';
    const groupConstraints = members.flatMap((member) => member.constraints)
      .filter((constraint) => !(constraint.kind === 'enum' && constraint.domain === 'value-set'));
    const booleanCheckbox = /checkbox/i.test(first.controlKind)
      && members.length === 1
      && binding?.valueType === 'boolean';
    if (status === 'static' && !booleanCheckbox) {
      groupConstraints.push({
        id: stableId('constraint', `${key}:options:${options.map((option) => String(option.value)).join('|')}`),
        fieldPath: first.dataPath,
        kind: 'enum',
        domain: 'value-set',
        value: options.map((option) => String(option.value)),
        message: `Value must be one of the statically declared ${first.dataPath} options.`,
        sourceRef: optionSources.flatMap((source) => source.sourceRefs)[0] ?? first.sourceRef,
      });
    }
    if (booleanCheckbox) {
      groupConstraints.push({
        id: stableId('constraint', `${key}:type:boolean`),
        fieldPath: first.dataPath,
        kind: 'type',
        domain: 'type',
        value: 'boolean',
        message: `${first.dataPath} is bound from the checkbox checked state.`,
        sourceRef: binding?.sourceRef ?? first.sourceRef,
      });
    }
    if (/checkbox/i.test(first.controlKind) && members.length > 1) {
      groupConstraints.push({
        id: stableId('constraint', `${key}:multi-value-checkbox-group`),
        fieldPath: first.dataPath,
        kind: 'opaque',
        domain: 'value-set',
        message: 'A same-name checkbox group can submit multiple values; scalar binding semantics are not proved.',
        sourceRef: first.sourceRef,
      });
    }
    return {
      id: stableId('field', `${key}:group`),
      pageId: first.pageId,
      dataPath: first.dataPath,
      ...(labels.length === 1 ? { label: labels[0]! } : {}),
      controlKind: /radio/i.test(first.controlKind) ? 'radio' : 'checkbox',
      inputMode,
      optionSource: {
        status,
        options,
        ...(optionSources.map((source) => source.expression).filter(Boolean).length
          ? { expression: optionSources.map((source) => source.expression).filter(Boolean).join('; ') }
          : {}),
        ...(status !== 'static' ? { reason: 'The choice group contains runtime or unresolved option values.' } : {}),
        sourceRefs: dedupeSourceRefs(optionSources.flatMap((source) => source.sourceRefs)),
      },
      ...(binding ? { valueBinding: binding } : {}),
      visibleWhen: [anyPredicate(members.flatMap((member) => member.visibleWhen))],
      requiredWhen: members.some((member) => member.requiredWhen.length)
        ? [anyPredicate(members.flatMap((member) => member.requiredWhen))]
        : [],
      constraints: dedupeConstraints(groupConstraints),
      sourceRef: first.sourceRef,
    };
  });
  return [...regular, ...merged];
}

function isChoiceControl(controlKind: string): boolean {
  return /(?:^|\.)(?:radio|checkbox)$/i.test(controlKind) || /(?:Radio|Checkbox)$/.test(controlKind);
}

function anyPredicate(predicates: Predicate[]): Predicate {
  const flattened = predicates.flatMap((predicate) => predicate.kind === 'any' ? predicate.operands : [predicate]);
  if (flattened.some((predicate) => predicate.kind === 'constant' && predicate.value)) return TRUE;
  const meaningful = flattened.filter((predicate) => !(predicate.kind === 'constant' && !predicate.value));
  if (!meaningful.length) return { kind: 'constant', value: false };
  if (meaningful.length === 1) return meaningful[0]!;
  return { kind: 'any', operands: meaningful };
}

function visibilityPredicates(opening: Node): Predicate[] {
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return [conditionalGuard(opening)];
  const predicates: Predicate[] = [conditionalGuard(opening)];
  const hidden = booleanAttributePredicate(opening.getAttribute('hidden'));
  if (hidden) predicates.push({ kind: 'not', operand: hidden });
  const ariaHidden = opening.getAttribute('aria-hidden');
  if (ariaHidden) {
    const value = jsxAttributeValue(ariaHidden);
    const expression = jsxAttributeExpression(ariaHidden);
    const predicate = value === 'true'
      ? TRUE
      : value === 'false'
        ? { kind: 'constant' as const, value: false }
        : expression
          ? predicateFromExpression(expression)
          : TRUE;
    predicates.push({ kind: 'not', operand: predicate });
  }
  return [allPredicates(predicates)];
}

function booleanAttributePredicate(attribute: Node | undefined): Predicate | undefined {
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  if (!initializer || Node.isStringLiteral(initializer)) return TRUE;
  if (!Node.isJsxExpression(initializer) || !initializer.getExpression()) {
    return opaquePredicate(initializer.getText(), 'Unsupported boolean JSX attribute initializer.');
  }
  const expression = initializer.getExpression()!;
  if (expression.getText() === 'true') return TRUE;
  if (expression.getText() === 'false') return { kind: 'constant', value: false };
  return predicateFromExpression(expression.getText());
}

function requiredAttributePredicates(attribute: Node, opening: Node): Predicate[] {
  if (!Node.isJsxAttribute(attribute)) return [];
  const initializer = attribute.getInitializer();
  if (!initializer || Node.isStringLiteral(initializer)) return [conditionalGuard(opening)];
  if (!Node.isJsxExpression(initializer)) {
    return [{
      kind: 'opaque',
      sourceExpression: initializer.getText(),
      reason: 'Unsupported required attribute initializer.',
    }];
  }
  const expression = initializer.getExpression();
  if (!expression || expression.getText() === 'true') return [conditionalGuard(opening)];
  if (expression.getText() === 'false') return [];
  return [allPredicates([conditionalGuard(opening), predicateFromExpression(expression.getText())])];
}

function conditionalGuard(node: Node) {
  const guards = node.getAncestors().flatMap((ancestor) => {
    if (Node.isBinaryExpression(ancestor) && ancestor.getOperatorToken().getText() === '&&' && containsNode(ancestor.getRight(), node)) {
      return [predicateFromExpression(ancestor.getLeft().getText())];
    }
    if (Node.isConditionalExpression(ancestor)) {
      const predicate = predicateFromExpression(ancestor.getCondition().getText());
      if (containsNode(ancestor.getWhenTrue(), node)) return [predicate];
      if (containsNode(ancestor.getWhenFalse(), node)) return [{ kind: 'not' as const, operand: predicate }];
    }
    if (Node.isIfStatement(ancestor)) {
      const predicate = predicateFromExpression(ancestor.getExpression().getText());
      if (containsNode(ancestor.getThenStatement(), node)) return [predicate];
      const otherwise = ancestor.getElseStatement();
      if (otherwise && containsNode(otherwise, node)) return [{ kind: 'not' as const, operand: predicate }];
    }
    if (Node.isCatchClause(ancestor) || Node.isCaseClause(ancestor) || Node.isDefaultClause(ancestor)) {
      return [{
        kind: 'opaque' as const,
        sourceExpression: ancestor.getText().slice(0, 180),
        reason: 'Catch/switch control flow is not reduced by the React adapter.',
      }];
    }
    return [];
  });
  return guards.length ? allPredicates(guards) : TRUE;
}

function containsNode(container: Node, candidate: Node): boolean {
  return container.getStart() <= candidate.getStart() && container.getEnd() >= candidate.getEnd();
}

function jsxIsInPageRender(pageNode: Node, candidate: Node): boolean {
  return pageRenderExpressions(pageNode).some((expression) => containsNode(expression, candidate));
}

function pageRenderExpressions(pageNode: Node): Node[] {
  const returned: Node[] = pageNode.getDescendantsOfKind(SyntaxKind.ReturnStatement).flatMap((statement) => {
    const expression = statement.getExpression();
    return nearestEnclosingFunction(statement) === pageNode && expression ? [expression] : [];
  });
  if (Node.isArrowFunction(pageNode)) {
    const body = pageNode.getBody();
    if (!Node.isBlock(body)) returned.push(body);
  }
  return returned;
}

function nestedRenderHelpers(pageNode: Node, excludedJsxNodes: Node[]): string[] {
  const helperFunctions = [...new Map(excludedJsxNodes.flatMap((jsx) => {
    const fn = nearestEnclosingFunction(jsx);
    return fn && fn !== pageNode ? [[`${fn.getSourceFile().getFilePath()}:${fn.getStart()}`, fn] as const] : [];
  })).values()];
  const calls = pageRenderExpressions(pageNode).flatMap((expression) => expression.getDescendantsOfKind(SyntaxKind.CallExpression));
  return helperFunctions.filter((fn) => calls.some((call) => callTargetsFunctionNode(call, fn)))
    .map((fn) => nestedFunctionName(fn) ?? `<anonymous@${fn.getStartLineNumber()}>`)
    .sort();
}

function detachedJsxValueBindings(pageNode: Node, excludedJsxNodes: Node[]): string[] {
  const detachedDeclarations = [...new Map(excludedJsxNodes.flatMap((jsx) => {
    if (nearestEnclosingFunction(jsx) !== pageNode) return [];
    const declaration = jsx.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const initializer = declaration?.getInitializer();
    if (!declaration || !initializer || !containsNode(initializer, jsx) || nearestEnclosingFunction(declaration) !== pageNode) return [];
    return [[`${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`, declaration] as const];
  })).values()];
  if (!detachedDeclarations.length) return [];

  const referencedDeclarations = new Set<string>();
  const queuedDeclarations: Node[] = [];
  const seenIdentifiers = new Set<string>();
  const enqueueIdentifiers = (expression: Node) => {
    const identifiers = [
      ...(Node.isIdentifier(expression) ? [expression] : []),
      ...expression.getDescendantsOfKind(SyntaxKind.Identifier),
    ];
    for (const identifier of identifiers) {
      const identifierKey = `${identifier.getSourceFile().getFilePath()}:${identifier.getStart()}`;
      if (seenIdentifiers.has(identifierKey)) continue;
      seenIdentifiers.add(identifierKey);
      const symbol = identifier.getSymbol();
      const resolved = symbol?.getAliasedSymbol() ?? symbol;
      for (const declaration of resolved?.getDeclarations() ?? []) {
        if (!Node.isVariableDeclaration(declaration) || nearestEnclosingFunction(declaration) !== pageNode) continue;
        const declarationKey = `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`;
        if (referencedDeclarations.has(declarationKey)) continue;
        referencedDeclarations.add(declarationKey);
        queuedDeclarations.push(declaration);
      }
    }
  };

  pageRenderExpressions(pageNode).forEach(enqueueIdentifiers);
  while (queuedDeclarations.length && referencedDeclarations.size <= 64) {
    const declaration = queuedDeclarations.shift();
    if (declaration && Node.isVariableDeclaration(declaration)) {
      const initializer = declaration.getInitializer();
      if (initializer) enqueueIdentifiers(initializer);
    }
  }

  return detachedDeclarations.filter((declaration) => (
    referencedDeclarations.has(`${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`)
  )).map((declaration) => declaration.getName()).sort();
}

function callTargetsFunctionNode(call: CallExpression, target: Node): boolean {
  const expression = call.getExpression();
  if (!Node.isIdentifier(expression)) return false;
  const symbol = expression.getSymbol();
  const resolved = symbol?.getAliasedSymbol() ?? symbol;
  return Boolean(resolved?.getDeclarations().some((declaration) => (
    declaration === target
    || (Node.isVariableDeclaration(declaration) && declaration.getInitializer() === target)
  )));
}

function nestedFunctionName(node: Node): string | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) return node.getName();
  const variable = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return variable?.getInitializer() === node ? variable.getName() : undefined;
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

function jsxAttributeNodeExpression(attribute: Node | undefined): Node | undefined {
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  return initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined;
}

function componentFromElementAttribute(attribute: Node | undefined): { name: string; file?: string } | undefined {
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined;
  return componentFromElementExpression(expression);
}

function componentFromElementExpression(expression: Node | undefined): { name: string; file?: string } | undefined {
  if (!expression) return undefined;
  const jsx = Node.isJsxSelfClosingElement(expression) || Node.isJsxElement(expression)
    ? expression
    : expression.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) ?? expression.getFirstDescendantByKind(SyntaxKind.JsxElement);
  if (!jsx) return undefined;
  const tagNode = Node.isJsxElement(jsx) ? jsx.getOpeningElement().getTagNameNode() : jsx.getTagNameNode();
  const displayedName = tagNode.getText();
  if (!Node.isIdentifier(tagNode)) return { name: displayedName };
  const symbol = tagNode.getSymbol();
  const target = symbol?.getAliasedSymbol() ?? symbol;
  const declaration = target?.getDeclarations().find((candidate) => (
    Node.isFunctionDeclaration(candidate) || Node.isVariableDeclaration(candidate)
  ));
  if (!declaration) return { name: displayedName };
  const name = Node.isFunctionDeclaration(declaration)
    ? declaration.getName() ?? displayedName
    : declaration.getName();
  return {
    name,
    file: declaration.getSourceFile().getFilePath().replace(/^\//, ''),
  };
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
      value += `${staticValue(span.getExpression()) ?? `{${span.getExpression().getText()}}`}${span.getLiteral().getLiteralText()}`;
    }
    return value;
  }
  if (Node.isPropertyAccessExpression(node) && node.getExpression().getText() === 'this') {
    const owner = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const initializer = owner?.getProperty(node.getName())?.getInitializer();
    if (initializer) return staticValue(initializer);
  }
  const scalar = staticScalar(unwrapExpression(node));
  if (scalar !== undefined) return String(scalar);
  return undefined;
}

function normalizeRoute(value: string): string {
  const normalized = value.replace(/\$\{([^}]+)\}/g, '{$1}').replace(/\/+/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function extractAxiosDefaultBasePath(sources: SourceFile[]): string | undefined {
  const values = sources.flatMap((source) => source.getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .filter((expression) => expression.getOperatorToken().getKind() === SyntaxKind.EqualsToken
      && expression.getLeft().getText() === 'axios.defaults.baseURL')
    .map((expression) => staticValue(expression.getRight()))
    .filter((value): value is string => Boolean(value))
    .map((value) => urlPath(value)));
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : undefined;
}

function normalizeHttpPath(value: string, expression: string, axiosBasePath?: string): string {
  if (/^https?:\/\//i.test(value)) return urlPath(value);
  const normalized = normalizeRoute(value);
  if (!axiosBasePath || (!expression.startsWith('axios.') && !expression.startsWith('requests.'))) return normalized;
  if (normalized === axiosBasePath || normalized.startsWith(`${axiosBasePath}/`)) return normalized;
  return normalizeRoute(`${axiosBasePath}/${normalized.replace(/^\//, '')}`);
}

function urlPath(value: string): string {
  const match = value.match(/^https?:\/\/[^/]+(\/[^?#]*)?(\?[^#]*)?/i);
  if (!match) return normalizeRoute(value);
  return normalizeRoute(`${match[1] ?? '/'}${match[2] ?? ''}`);
}

function enclosingFunctionName(node: Node): string | undefined {
  const functionNode = enclosingFunctionNode(node);
  if (!functionNode) return undefined;
  if (Node.isFunctionDeclaration(functionNode) || Node.isMethodDeclaration(functionNode)) return functionNode.getName();
  const property = functionNode.getFirstAncestorByKind(SyntaxKind.PropertyAssignment);
  if (property) return property.getName();
  const variable = functionNode.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return variable?.getName();
}

function enclosingFunctionNode(node: Node): Node | undefined {
  return node.getFirstAncestor((ancestor) =>
    Node.isFunctionDeclaration(ancestor) || Node.isMethodDeclaration(ancestor) || Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor),
  );
}

function directCallableIdentifier(expression: string): string | undefined {
  const direct = expression.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  return direct;
}

function inlineHandlerName(node: Node): string {
  return `$inline_${node.getStart()}`;
}

function handlerIdentity(relativePath: string, name: string, declarationStart: number): string {
  return stableId('handler', `${relativePath}:${name}:${declarationStart}`);
}

function handlerIdentityFromExpression(expression: Node, relativePath: string): string | undefined {
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    return handlerIdentity(relativePath, inlineHandlerName(expression), expression.getStart());
  }
  if (!Node.isIdentifier(expression)) return undefined;
  const symbol = expression.getSymbol();
  const target = symbol?.getAliasedSymbol() ?? symbol;
  const declaration = target?.getDeclarations().find((candidate) => (
    Node.isFunctionDeclaration(candidate) || Node.isVariableDeclaration(candidate)
  ));
  if (!declaration) return undefined;
  const sourceFile = declaration.getSourceFile().getFilePath().replace(/^\//, '');
  if (sourceFile !== relativePath) return undefined;
  if (Node.isFunctionDeclaration(declaration) && declaration.getName()) {
    return handlerIdentity(relativePath, declaration.getName()!, declaration.getStart());
  }
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return handlerIdentity(relativePath, declaration.getName(), initializer.getStart());
    }
  }
  return undefined;
}

function sourceRef(relativePath: string, node: Node, symbol?: string): SourceRef {
  const line = node.getStartLineNumber();
  const excerpt = node.getText().replace(/\s+/g, ' ').slice(0, 180);
  return { file: relativePath, line, ...(symbol ? { symbol } : {}), excerpt };
}
