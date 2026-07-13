export type EvidenceOrigin =
  | 'source-extracted'
  | 'graphify-extracted'
  | 'graphify-inferred'
  | 'wiki-derived'
  | 'semantic-proposed'
  | 'runtime-observed'
  | 'human-reviewed';

export interface SourceRef {
  file: string;
  line: number;
  endLine?: number;
  symbol?: string;
  excerpt?: string;
}

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error' | 'blocked';
  message: string;
  evidenceRefs?: string[];
  scope?: string;
}

export interface ArtifactMeta {
  artifactType: string;
  schemaVersion: string;
  producer: string;
  producerVersion: string;
  sourceDigest: string;
  configDigest: string;
  inputDigests: Record<string, string>;
  contentDigest: string;
  status: 'raw' | 'proposed' | 'validated' | 'reviewed' | 'generated' | 'grounded' | 'verified' | 'stale';
  unresolved: Diagnostic[];
}

export interface ArtifactEnvelope<T> {
  meta: ArtifactMeta;
  data: T;
}

export type EvidenceNodeKind =
  | 'source-file'
  | 'route'
  | 'page'
  | 'component'
  | 'control'
  | 'field'
  | 'handler'
  | 'predicate'
  | 'http-client-operation'
  | 'java-endpoint'
  | 'dto-field'
  | 'validation'
  | 'permission'
  | 'navigation'
  | 'terminal-effect'
  | 'visible-outcome'
  | 'concept';

export interface EvidenceNode {
  id: string;
  kind: EvidenceNodeKind;
  canonicalKey: string;
  label: string;
  attributes: Record<string, unknown>;
  origin: EvidenceOrigin;
  confidence: 'exact' | 'corroborated' | 'semantic' | 'unresolved';
  sourceRefs: SourceRef[];
}

export type EvidenceEdgeKind =
  | 'renders'
  | 'contains'
  | 'triggers'
  | 'calls'
  | 'requests'
  | 'handled-by'
  | 'guards'
  | 'validates'
  | 'requires'
  | 'navigates-to'
  | 'establishes'
  | 'binds-response'
  | 'displays'
  | 'references';

export interface EvidenceEdge {
  id: string;
  from: string;
  to: string;
  kind: EvidenceEdgeKind;
  guard?: Predicate;
  origin: EvidenceOrigin;
  confidence: 'exact' | 'corroborated' | 'semantic' | 'unresolved';
  sourceRefs: SourceRef[];
}

export interface EvidenceGraph {
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
  diagnostics: Diagnostic[];
}

export type ValueRef =
  | { kind: 'path'; path: string }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'binding'; bindingId: string };

export type Predicate =
  | { kind: 'constant'; value: boolean }
  | { kind: 'not'; operand: Predicate }
  | { kind: 'all'; operands: Predicate[] }
  | { kind: 'any'; operands: Predicate[] }
  | { kind: 'exists'; value: ValueRef }
  | {
      kind: 'compare';
      left: ValueRef;
      operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
      right: ValueRef;
    }
  | { kind: 'member-of'; value: ValueRef; values: ValueRef[] }
  | { kind: 'opaque'; sourceExpression: string; reason: string };

export interface ReactRouteFact {
  id: string;
  path: string;
  component?: string;
  sourceRef: SourceRef;
}

export interface ReactHandlerFact {
  id: string;
  name: string;
  file: string;
  calls: string[];
  httpOperationIds: string[];
  navigationIds: string[];
  sourceRef: SourceRef;
}

export interface ReactActionFact {
  id: string;
  pageId: string;
  component: string;
  event: string;
  accessibleName?: string;
  handlerName?: string;
  handlerId?: string;
  visibleWhen: Predicate[];
  enabledWhen: Predicate[];
  sourceRef: SourceRef;
}

export interface ReactFieldFact {
  id: string;
  pageId: string;
  dataPath: string;
  label?: string;
  controlKind: string;
  visibleWhen: Predicate[];
  requiredWhen: Predicate[];
  constraints: InputConstraint[];
  sourceRef: SourceRef;
}

export interface HttpOperationFact {
  id: string;
  method: string;
  pathTemplate: string;
  callerSymbol?: string;
  requestExpression?: string;
  sourceRef: SourceRef;
}

export interface NavigationFact {
  id: string;
  fromPageId?: string;
  target: string;
  guard: Predicate;
  sourceRef: SourceRef;
}

export interface PermissionFact {
  id: string;
  authority: string;
  layer: 'frontend' | 'backend';
  sourceRef: SourceRef;
}

export interface JavaEndpointFact {
  id: string;
  method: string;
  pathTemplate: string;
  controller: string;
  handler: string;
  requestType?: string;
  responseType?: string;
  permissionIds: string[];
  validationIds: string[];
  terminalEffectIds: string[];
  sourceRef: SourceRef;
}

export interface InputConstraint {
  id: string;
  fieldPath: string;
  kind: 'required' | 'min' | 'max' | 'size' | 'pattern' | 'enum' | 'opaque';
  value?: string | number | boolean | string[];
  message?: string;
  sourceRef: SourceRef;
}

export interface TerminalEffectFact {
  id: string;
  entity: string;
  kind: 'entity-created' | 'state-changed' | 'entity-deleted' | 'external-command' | 'unknown-mutation';
  toState?: string;
  sourceRef: SourceRef;
}

export interface WikiConcept {
  id: string;
  canonicalLabel: string;
  aliases: string[];
  sourceRef: SourceRef;
}

export interface ExtractionBundle {
  sourceDigest: string;
  sourceFiles: SourceRef[];
  routes: ReactRouteFact[];
  pages: PageSeed[];
  handlers: ReactHandlerFact[];
  actions: ReactActionFact[];
  fields: ReactFieldFact[];
  httpOperations: HttpOperationFact[];
  navigations: NavigationFact[];
  permissions: PermissionFact[];
  endpoints: JavaEndpointFact[];
  validations: InputConstraint[];
  effects: TerminalEffectFact[];
  wikiConcepts: WikiConcept[];
  graphifyNodes: EvidenceNode[];
  graphifyEdges: EvidenceEdge[];
  diagnostics: Diagnostic[];
}

export interface PageSeed {
  id: string;
  name: string;
  file: string;
  routeIds: string[];
  sourceRef: SourceRef;
}

export interface OperationCatalogEntry {
  id: string;
  method: string;
  pathTemplate: string;
  frontendOperationIds: string[];
  backendEndpointId: string;
  actorRequirementIds: string[];
  validationIds: string[];
  terminalEffectIds: string[];
  businessCommand: {
    machineName: string;
    label: string;
    origin: 'deterministic' | 'wiki' | 'semantic-proposed' | 'human-reviewed';
  };
  inclusion: 'included' | 'excluded' | 'review-required';
  evidenceRefs: string[];
}

export interface OperationCatalog {
  operations: OperationCatalogEntry[];
}

export interface PageContract {
  id: string;
  name: string;
  routePatterns: string[];
  fields: ReactFieldFact[];
  actions: ReactActionFact[];
  entryConditions: Predicate[];
  evidenceRefs: string[];
}

export interface PageContracts {
  pages: PageContract[];
}

export interface ActorRequirement {
  id: string;
  authentication: 'anonymous' | 'required';
  authoritiesAll: string[];
  rolesAll: string[];
  attributePredicates: Predicate[];
  relationships: string[];
  label: string;
  evidenceRefs: string[];
}

export interface ActorRequirements {
  actors: ActorRequirement[];
}

export type BehaviorNodeKind = 'screen-state' | 'action' | 'operation' | 'outcome';

export interface BehaviorNode {
  id: string;
  kind: BehaviorNodeKind;
  label: string;
  referenceId?: string;
  attributes: Record<string, unknown>;
}

export type Effect =
  | { kind: 'navigate'; target: string }
  | { kind: 'invoke-operation'; operationId: string }
  | { kind: 'entity-transition'; effectId: string }
  | { kind: 'show-outcome'; outcomeId: string }
  | { kind: 'binding-write'; bindingId: string; source: string };

export interface BehaviorEdge {
  id: string;
  from: string;
  to: string;
  guard: Predicate;
  effects: Effect[];
  outcome: 'neutral' | 'success' | 'error' | 'cancel';
  evidenceRefs: string[];
}

export interface BehaviorGraph {
  nodes: BehaviorNode[];
  edges: BehaviorEdge[];
  entryNodeIds: string[];
  successNodeIds: string[];
}

export interface FlowFamily {
  id: string;
  label: string;
  operationIds: string[];
  entryNodeIds: string[];
  successNodeIds: string[];
  actorRequirementIds: string[];
  evidenceRefs: string[];
}

export interface FlowFamilies {
  families: FlowFamily[];
}

export interface PathWitness {
  id: string;
  familyId: string;
  nodePath: string[];
  edgePath: string[];
  pageSequence: string[];
  actionSequence: string[];
  pathCondition: Predicate;
  assignments: Record<string, string | number | boolean | null>;
  feasibility: 'satisfiable' | 'conditional';
  evidenceRefs: string[];
}

export interface PathWitnesses {
  witnesses: PathWitness[];
}

export interface FlowVariant {
  id: string;
  familyId: string;
  label: string;
  witnessIds: string[];
  behaviorSignature: string;
  actorRequirementIds: string[];
  pathCondition: Predicate;
  pageSequence: string[];
  actionSequence: string[];
  operationIds: string[];
  dataRequirementIds: string[];
  feasibility: 'satisfiable' | 'conditional';
  evidenceRefs: string[];
}

export interface FlowVariants {
  variants: FlowVariant[];
}

export type DataClassification =
  | 'flow-literal'
  | 'synthetic-constrained'
  | 'derived'
  | 'runtime-option'
  | 'existing-entity'
  | 'authenticated-identity'
  | 'secret-reference'
  | 'external-manual';

export interface DataRequirement {
  id: string;
  variantId: string;
  fieldPath: string;
  classification: DataClassification;
  constraints: InputConstraint[];
  resolutionStrategies: string[];
  status: 'unresolved' | 'generated' | 'bound' | 'verified' | 'blocked';
  evidenceRefs: string[];
}

export interface RuntimeBinding {
  id: string;
  actionId: string;
  screenId: string;
  environment: string;
  locator: {
    strategy: 'role-and-name' | 'label' | 'test-id' | 'scoped-text' | 'reviewed-css';
    role?: string;
    name?: string;
    value?: string;
  };
  componentAdapter: string;
  unique: boolean;
  actionable: boolean;
  observedOperationId?: string;
  observedNextStateId?: string;
  evidenceRefs: string[];
}

export interface RuntimeBindings {
  bindings: RuntimeBinding[];
}

export interface CoverageReport {
  scope: {
    sourceFiles: number;
    sourceDigest: string;
    maxPathDepth: number;
    maxStateVisits: number;
  };
  counts: Record<string, number>;
  unresolved: Diagnostic[];
  claims: string[];
}
