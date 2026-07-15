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
  /** Consistency digest over the complete artifact envelope except this field. */
  envelopeDigest?: string;
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
  | 'request-payload'
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
  componentFile?: string;
  sourceRef: SourceRef;
}

export interface ReactHandlerFact {
  id: string;
  name: string;
  file: string;
  calls: string[];
  parameterNames?: string[];
  callSites?: ReactCallSiteFact[];
  httpOperationIds: string[];
  navigationIds: string[];
  normalCompletion?: 'exact' | 'conditional';
  normalCompletionReason?: string;
  sourceRef: SourceRef;
}

export type RequestPayloadCertainty = 'exact' | 'partial' | 'unknown';

export interface RequestPayloadFieldFact {
  name: string;
  value?: ValueRef;
  /**
   * Canonical source-symbol identity for a path-valued payload property. This is
   * intentionally stronger than matching the displayed path text.
   */
  valueSourceIdentity?: string;
  sourceRef: SourceRef;
}

export interface RequestPayloadShape {
  certainty: RequestPayloadCertainty;
  fields: RequestPayloadFieldFact[];
  expression?: string;
  referenceName?: string;
  reason?: string;
  sourceRefs: SourceRef[];
}

export interface ReactCallSiteFact {
  calleeSymbol: string;
  targetSymbol?: string;
  targetFile?: string;
  guard?: Predicate;
  argumentPayloads: RequestPayloadShape[];
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
  handlerResolution?: 'exact' | 'conditional';
  handlerExpression?: string;
  navigationIds?: string[];
  visibleWhen: Predicate[];
  enabledWhen: Predicate[];
  sourceRef: SourceRef;
}

export interface ReactFieldOptionFact {
  value: string | number | boolean;
  label?: string;
  sourceRef: SourceRef;
}

export interface ReactFieldOptionSource {
  status: 'static' | 'partial' | 'runtime' | 'unknown';
  options: ReactFieldOptionFact[];
  expression?: string;
  reason?: string;
  sourceRefs: SourceRef[];
}

export interface ReactFieldFact {
  id: string;
  pageId: string;
  dataPath: string;
  label?: string;
  controlKind: string;
  inputMode?: 'editable' | 'read-only' | 'conditional';
  optionSource?: ReactFieldOptionSource;
  valueBinding?: {
    path: string;
    writable: boolean;
    valueType?: 'string' | 'number' | 'integer' | 'boolean' | 'unknown';
    /** Canonical source-symbol identity for the controlled value expression. */
    sourceIdentity?: string;
    sourceRef: SourceRef;
  };
  visibleWhen: Predicate[];
  requiredWhen: Predicate[];
  constraints: InputConstraint[];
  backendConstraintsByOperationId?: Record<string, InputConstraint[]>;
  backendConstraintsByRequestContractId?: Record<string, InputConstraint[]>;
  sourceRef: SourceRef;
}

export interface HttpOperationFact {
  id: string;
  method: string;
  pathTemplate: string;
  callerSymbol?: string;
  requestExpression?: string;
  payloadShape?: RequestPayloadShape;
  guard?: Predicate;
  sourceRef: SourceRef;
}

export interface NavigationFact {
  id: string;
  fromPageId?: string;
  target: string;
  targetStatus?: 'exact' | 'conditional';
  targetExpression?: string;
  trigger?: 'imperative' | 'declarative';
  guard: Predicate;
  successAfterCallSymbol?: string;
  successAfterCallFile?: string;
  continuationStatus: 'exact' | 'conditional';
  sourceRef: SourceRef;
}

export interface PermissionFact {
  id: string;
  authority: string;
  layer: 'frontend' | 'backend';
  origin?: EvidenceOrigin;
  sourceRef: SourceRef;
}

export interface JavaAuthorizationFact {
  status: 'anonymous' | 'authenticated' | 'exact' | 'conditional';
  sourceExpression?: string;
  reason?: string;
  sourceRefs: SourceRef[];
}

export interface JavaEndpointFact {
  id: string;
  method: string;
  pathTemplate: string;
  controller: string;
  handler: string;
  requestType?: string;
  responseType?: string;
  authorization: JavaAuthorizationFact;
  domainGuard: Predicate;
  permissionIds: string[];
  validationIds: string[];
  terminalEffectIds: string[];
  semanticResolution?: {
    packetId: string;
    reviewer: string;
    approvedAt: string;
    proposalDigest: string;
    evidenceRefs: string[];
  };
  sourceRef: SourceRef;
}

export interface InputConstraint {
  id: string;
  fieldPath: string;
  kind: 'required' | 'min' | 'max' | 'size' | 'pattern' | 'format' | 'enum' | 'type' | 'opaque';
  value?: string | number | boolean | string[];
  domain?: 'length' | 'numeric' | 'format' | 'value-set' | 'type' | 'unknown';
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
  requestContracts?: RequestPayloadContractFact[];
  diagnostics: Diagnostic[];
}

export interface RequestPayloadContractFact {
  id: string;
  actionId: string;
  handlerId: string;
  handlerPath: string[];
  httpOperationId: string;
  endpointId: string;
  payloadShape: RequestPayloadShape;
  dispatchGuard: Predicate;
  requiredFields: string[];
  providedFields: string[];
  literalBindings: Record<string, string | number | boolean | null>;
  /** Exact backend request-field to writable UI-field provenance. */
  uiFieldBindings: Record<string, string>;
  missingRequiredFields: string[];
  unprovenFieldValues: string[];
  invalidFieldValues: string[];
  validationIds: string[];
  status: 'fields-present' | 'required-fields-missing' | 'required-fields-invalid' | 'review-required';
  evidenceRefs: string[];
  sourceRefs: SourceRef[];
}

export interface PageSeed {
  id: string;
  name: string;
  file: string;
  routeIds: string[];
  completeness?: 'exact' | 'conditional';
  unresolvedChildComponentRefs?: SourceRef[];
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
    aliases?: string[];
    familyHint?: string;
    origin: 'deterministic' | 'wiki' | 'semantic-proposed' | 'human-reviewed';
  };
  inclusion: 'included' | 'excluded' | 'review-required';
  requestContractIds?: string[];
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
  completeness: 'exact' | 'conditional';
  unresolvedChildComponentRefs: SourceRef[];
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
  requestPayloadContracts?: Array<{
    id: string;
    status: RequestPayloadContractFact['status'];
    certainty: RequestPayloadCertainty;
    dispatchGuard: Predicate;
    providedFields: string[];
    literalBindings?: Record<string, string | number | boolean | null>;
    uiFieldBindings?: Record<string, string>;
    requiredFields: string[];
    missingRequiredFields: string[];
    unprovenFieldValues?: string[];
    invalidFieldValues?: string[];
  }>;
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

export type PathSearchTruncationReason = 'max-path-depth' | 'max-state-visits';

export interface PathSearchTruncationDetail {
  reason: PathSearchTruncationReason;
  familyId: string;
  /** The rejected state for depth pruning, or attempted target state for visit pruning. */
  nodeId: string;
  /** Present when a transition was rejected by the state-visit bound. */
  edgeId?: string;
  limit: number;
  minimumObserved: number;
  maximumObserved: number;
  count: number;
  /** Lexicographically smallest rejected path represented by this aggregate. */
  sampleNodePath: string[];
  sampleEdgePath: string[];
}

export interface PathSearchReport {
  bounds: {
    maxPathDepth: number;
    maxStateVisits: number;
  };
  enqueuedStates: number;
  dequeuedStates: number;
  truncation: {
    occurred: boolean;
    counts: {
      maxPathDepth: number;
      maxStateVisits: number;
    };
    details: PathSearchTruncationDetail[];
  };
}

export interface PathWitnesses {
  witnesses: PathWitness[];
  /** Optional for compatibility with path-witness artifacts written before v0.2. */
  search?: PathSearchReport;
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
  /**
   * Source path predicates that must be established by the selected actor,
   * rather than by typing into a field on the journey.
   */
  actorAttributeAssignments?: Record<string, string | number | boolean | null>;
  /** Entity/resource state that a selected application fixture must establish. */
  entityPrerequisites?: Array<{
    predicatePath: string;
    expectedValue: string | number | boolean | null;
    pageId: string;
    fieldId: string;
    fieldPath: string;
  }>;
  /** Predicate assignments for which the compiler found no controllable UI or actor input. */
  unboundPathAssignments?: string[];
  feasibility: 'satisfiable' | 'conditional';
  evidenceRefs: string[];
}

export interface FlowVariants {
  variants: FlowVariant[];
  rejectedCandidates?: Diagnostic[];
}

export type DataClassification =
  | 'flow-literal'
  | 'synthetic-constrained'
  | 'derived'
  | 'runtime-option'
  | 'existing-entity'
  | 'authenticated-identity'
  | 'actor-attribute'
  | 'secret-reference'
  | 'external-manual';

export interface DataRequirement {
  id: string;
  variantId: string;
  pageId?: string;
  fieldId?: string;
  actorRequirementId?: string;
  fieldPath: string;
  classification: DataClassification;
  /** Predicate value the resolved actor/data fixture must establish; not a generated test value. */
  expectedValue?: string | number | boolean | null;
  expectedAttributes?: Record<string, string | number | boolean | null>;
  representativeValue?: string | number | boolean | null;
  constraints: InputConstraint[];
  resolutionStrategies: string[];
  status: 'unresolved' | 'generated' | 'bound' | 'verified' | 'blocked';
  evidenceRefs: string[];
}

export interface RuntimeBinding {
  id: string;
  witnessId: string;
  sequence: number;
  groundingRunId: string;
  groundingManifestDigest: string;
  observationProducer: 'flowctl-playwright-adapter-runner';
  targetKind: 'actor-session' | 'screen-state' | 'field' | 'action';
  actorRequirementIds?: string[];
  actorRequirementsDigest?: string;
  identityBindingDigests?: Record<string, string>;
  actorDataRequirementIds?: string[];
  actorDataBindingDigests?: Record<string, string>;
  actorDataResolutionDigests?: Record<string, string>;
  screenStatePhase?: 'entry' | 'intermediate' | 'success';
  actionId?: string;
  fieldId?: string;
  dataRequirementId?: string;
  dataRequirementDigest?: string;
  valueBindingDigest?: string;
  valueAvailability?: 'representative-value' | 'application-value' | 'secret-reference';
  valueResolutionDigest?: string;
  screenId?: string;
  environment: string;
  runtimeConfigDigest: string;
  baseUrl: string;
  locator?: {
    strategy: 'role-and-name' | 'label' | 'test-id' | 'scoped-text' | 'reviewed-css';
    role?: string;
    name?: string;
    value?: string;
  };
  componentAdapter: string;
  adapterManifestDigest: string;
  unique?: boolean;
  actionable?: boolean;
  observedOperationId?: string;
  observedNextStateId?: string;
  observedUrl?: string;
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
  operationCoverage: Array<{
    operationId: string;
    inclusion: OperationCatalogEntry['inclusion'];
    status: 'covered' | 'conditional' | 'uncovered';
    familyId?: string;
    witnessIds: string[];
    variantIds: string[];
    missingStage?: 'frontend-client-join' | 'action-operation-join' | 'success-continuation' | 'flow-family' | 'entry-success-witness' | 'behavior-variant';
    /** Present when this operation's family search hit a configured traversal bound. */
    searchTruncationReasons?: PathSearchTruncationReason[];
  }>;
  /** Optional so coverage artifacts produced before bounded-search reporting remain readable. */
  search?: PathSearchReport;
  unresolved: Diagnostic[];
  claims: string[];
}
