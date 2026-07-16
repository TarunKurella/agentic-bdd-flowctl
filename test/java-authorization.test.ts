import { describe, expect, it } from 'vitest';
import { extractJava } from '../src/adapters/java.js';
import type { SourceFile } from '../src/adapters/source.js';
import type { FlowctlConfig } from '../src/core/config.js';
import type { ExtractionBundle } from '../src/ir/model.js';
import {
  allPredicates,
  enumeratePredicateModels,
  predicateFromExpression,
  solvePredicate,
} from '../src/ir/predicates.js';
import {
  buildActorRequirements,
  buildBehaviorGraph,
  buildFlowFamilies,
  buildOperationCatalog,
  buildPageContracts,
  reduceVariants,
  searchPaths,
} from '../src/pipeline/builders.js';

describe('Spring authorization extraction', () => {
  it('compiles simple backend throw guards into accepted business-rule alternatives', () => {
    const java = extractJava([javaFile(`
      @RestController
      @RequestMapping("/api/applications")
      public class ApplicationController {
        @PermitAll
        @PostMapping
        public Object submit(@RequestBody ApplicationRequest request) {
          if (request.getApplicationType() != ApplicationType.PERSONAL
              && request.getApplicationType() != ApplicationType.JOINT) {
            throw new IllegalArgumentException();
          }
          Application application = new Application();
          applicationRepository.save(application);
          return application;
        }
      }
    `)]);

    expect(java.endpoints[0]?.domainGuard.kind).not.toBe('opaque');
    expect(enumeratePredicateModels(java.endpoints[0]!.domainGuard).map((model) => (
      model.assignments.applicationType
    )).sort()).toEqual(['JOINT', 'PERSONAL']);
  });

  it('rejects a frontend literal that contradicts a normalized backend success guard', () => {
    const java = extractJava([javaFile(`
      @RestController
      @RequestMapping("/api/applications")
      public class ApplicationController {
        @PermitAll
        @PostMapping
        public Object submit(@RequestBody ApplicationRequest request) {
          if (request.getAge() < 18) {
            throw new IllegalArgumentException();
          }
          Application application = new Application();
          applicationRepository.save(application);
          return application;
        }
      }
    `)]);

    const endpoint = java.endpoints[0]!;
    const combined = allPredicates([
      predicateFromExpression('age === 17'),
      endpoint.domainGuard,
    ]);

    expect(solvePredicate(combined).status).toBe('unsatisfiable');
    expect(endpoint.sourceRef).toMatchObject({
      file: 'backend/ApplicationController.java',
      symbol: 'ApplicationController.submit',
    });
  });

  it('keeps an unannotated endpoint conditional because global security is unresolved', () => {
    const java = extractJava([javaFile(`
      @RestController
      public class ApplicationController {
        @PostMapping("/api/applications")
        public Object submit(Object request) { repository.save(request); return request; }
      }
    `)]);
    expect(java.endpoints[0]?.authorization).toMatchObject({
      status: 'conditional',
      sourceExpression: 'unannotated-endpoint',
    });
  });

  it('applies an exact Spring SecurityFilterChain fallback to unannotated endpoints', () => {
    const java = extractJava([
      javaAt('backend/SecurityConfig.java', `
        @Configuration
        public class SecurityConfig {
          @Bean
          SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
            http.authorizeHttpRequests(requests -> requests
              .requestMatchers("/api/private/**").authenticated()
              .anyRequest().permitAll());
            return http.build();
          }
        }
      `),
      javaFile(`
        @RestController
        public class ApplicationController {
          @PostMapping("/api/login")
          public Object login(Object request) { repository.save(request); return request; }
          @PostMapping("/api/private/applications")
          public Object submit(Object request) { repository.save(request); return request; }
        }
      `),
    ]);

    expect(java.endpoints.find((endpoint) => endpoint.handler === 'login')?.authorization.status).toBe('anonymous');
    expect(java.endpoints.find((endpoint) => endpoint.handler === 'submit')?.authorization.status).toBe('authenticated');
  });

  it('keeps method-specific Spring Security rules separate for the same path', () => {
    const java = extractJava([
      javaAt('backend/SecurityConfig.java', `
        @Configuration
        public class SecurityConfig {
          @Bean
          SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
            http.authorizeHttpRequests(requests -> requests
              .requestMatchers(HttpMethod.GET, "/api/items").permitAll()
              .requestMatchers(HttpMethod.POST, "/api/items").hasAuthority("ITEM_CREATE")
              .anyRequest().authenticated());
            return http.build();
          }
        }
      `),
      javaFile(`
        @RestController
        public class ApplicationController {
          @GetMapping("/api/items")
          public Object list() { return service.list(); }
          @PostMapping("/api/items")
          public Object create(Object request) { repository.save(request); return request; }
        }
      `),
    ]);

    expect(java.endpoints.find((endpoint) => endpoint.method === 'GET')?.authorization.status).toBe('anonymous');
    const create = java.endpoints.find((endpoint) => endpoint.method === 'POST');
    expect(create?.authorization.status).toBe('exact');
    expect(java.permissions.find((permission) => create?.permissionIds.includes(permission.id))?.authority).toBe('ITEM_CREATE');
  });

  it('does not treat a persistence call followed by an explicit failure response as a happy terminal effect', () => {
    const java = extractJava([javaFile(`
      @RestController
      public class ApplicationController {
        @PermitAll
        @PostMapping("/api/applications")
        public ResponseEntity<Object> submit(Object request) {
          applicationRepository.save(request);
          return ResponseEntity.status(HttpStatus.BAD_REQUEST).build();
        }
      }
    `)]);

    expect(java.effects).toEqual([expect.objectContaining({ kind: 'unknown-mutation' })]);
    expect(java.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TERMINAL_EFFECT_UNRESOLVED' }),
    ]));
  });

  it('recognizes a successful JWT response as an authentication-session terminal effect', () => {
    const java = extractJava([javaFile(`
      @RestController
      public class AuthController {
        @PermitAll
        @PostMapping("/api/auth/login")
        public ResponseEntity<JwtResponse> login(@RequestBody JwtRequest request) {
          String token = jwtHelper.generateToken(userDetails);
          JwtResponse response = JwtResponse.builder().token(token).build();
          return new ResponseEntity<>(response, HttpStatus.OK);
        }
      }
    `)]);

    expect(java.effects).toEqual([
      expect.objectContaining({ kind: 'authentication-session-issued' }),
    ]);
  });

  it('follows a unique controller-to-interface-to-service implementation call to a persistence effect', () => {
    const java = extractJava([
      javaAt('backend/OrderController.java', `
        @RestController
        @RequestMapping("/api/orders")
        public class OrderController {
          private final OrderService orderService;
          @PermitAll
          @PostMapping
          public ResponseEntity<Integer> create(@RequestBody OrderDto request) {
            Integer id = orderService.createOrder(request);
            return ResponseEntity.ok(id);
          }
        }
      `),
      javaAt('backend/OrderService.java', `
        public interface OrderService { Integer createOrder(OrderDto request); }
      `),
      javaAt('backend/OrderServiceImpl.java', `
        public class OrderServiceImpl implements OrderService {
          private final OrderRepository orderRepository;
          public Integer createOrder(OrderDto request) {
            Order order = new Order();
            Order saved = orderRepository.save(order);
            return saved.getId();
          }
        }
      `),
    ]);

    expect(java.effects).toEqual([
      expect.objectContaining({
        kind: 'entity-created',
        sourceRef: expect.objectContaining({ file: 'backend/OrderServiceImpl.java' }),
      }),
    ]);
    expect(java.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TERMINAL_EFFECT_UNRESOLVED' }),
    ]));
  });

  it('follows a void service call, normalizes a plural route entity and recognizes repository deleteById', () => {
    const java = extractJava([
      javaAt('backend/OrdersController.java', `
        @RestController
        @RequestMapping("/api/orders")
        public class OrdersController {
          private final OrderService orderService;
          @PermitAll
          @DeleteMapping("/{orderId}")
          public void delete(@PathVariable Integer orderId) {
            orderService.deleteOrder(orderId);
          }
        }
      `),
      javaAt('backend/OrderService.java', `
        public interface OrderService { void deleteOrder(Integer orderId); }
      `),
      javaAt('backend/OrderServiceImpl.java', `
        public class OrderServiceImpl implements OrderService {
          private final OrderRepository orderRepository;
          public void deleteOrder(Integer orderId) {
            orderRepository.deleteById(orderId);
          }
        }
      `),
    ]);

    expect(java.effects).toEqual([
      expect.objectContaining({
        kind: 'entity-deleted',
        entity: 'Orders',
        sourceRef: expect.objectContaining({ file: 'backend/OrderServiceImpl.java' }),
      }),
    ]);
  });

  it('accepts an explicit PermitAll endpoint as anonymous', () => {
    const java = extractJava([javaFile(`
      @RestController
      public class ApplicationController {
        @PermitAll
        @PostMapping("/api/applications")
        public Object submit(Object request) { repository.save(request); return request; }
      }
    `)]);
    expect(java.endpoints[0]?.authorization.status).toBe('anonymous');
  });

  it('treats a class-level literal conjunction as exact required-all authorization', () => {
    const java = extractJava([javaFile(`
      @PreAuthorize(
        "hasAuthority('APPLICATION_READ') and (hasRole('REVIEWER') && hasAuthority('APPLICATION_WRITE'))"
      )
      @RestController
      @RequestMapping("/api/applications")
      public class ApplicationController {
        @PostMapping
        public Object submit(Object request) {
          Application application = new Application();
          applicationRepository.save(application);
          return request;
        }
      }
    `)]);

    expect(java.endpoints[0]?.authorization.status).toBe('exact');
    expect(java.permissions.map((permission) => permission.authority).sort()).toEqual([
      'APPLICATION_READ',
      'APPLICATION_WRITE',
      'ROLE_REVIEWER',
    ]);

    const { catalog, actors } = buildPipeline(java);
    expect(catalog.operations[0]?.inclusion).toBe('included');
    expect(actors.actors[0]).toMatchObject({
      authentication: 'required',
      authoritiesAll: ['APPLICATION_READ', 'APPLICATION_WRITE', 'ROLE_REVIEWER'],
      rolesAll: ['ROLE_REVIEWER'],
      attributePredicates: [],
    });
  });

  it('lets method-level security replace the class rule and refuses to flatten OR into authoritiesAll', () => {
    const java = extractJava([javaFile(`
      @PreAuthorize("hasAuthority('CLASS_AUTHORITY')")
      @RestController
      @RequestMapping("/api/applications")
      public class ApplicationController {
        @PreAuthorize("hasRole('MAKER') or hasRole('CHECKER')")
        @PostMapping("/submit")
        public Object submit(Object request) {
          repository.save(request);
          return request;
        }

        @PostMapping("/read")
        public Object read(Object request) {
          repository.save(request);
          return request;
        }
      }
    `)]);

    const submit = java.endpoints.find((endpoint) => endpoint.handler === 'submit')!;
    const read = java.endpoints.find((endpoint) => endpoint.handler === 'read')!;
    expect(submit.authorization.status).toBe('conditional');
    expect(submit.permissionIds).toEqual([]);
    expect(read.authorization.status).toBe('exact');
    expect(read.permissionIds).toHaveLength(1);
    expect(java.diagnostics.some((diagnostic) => diagnostic.code === 'JAVA_AUTHORIZATION_CONDITIONAL')).toBe(true);
  });

  it('keeps unsupported class-level security annotations conditional instead of treating them as anonymous', () => {
    const java = extractJava([javaFile(`
      @Secured("ROLE_APPLICATION_ADMIN")
      @RestController
      @RequestMapping("/api/applications")
      public class ApplicationController {
        @PostMapping
        public Object submit(Object request) {
          repository.save(request);
          return request;
        }
      }
    `)]);

    expect(java.endpoints[0]?.authorization).toMatchObject({
      status: 'conditional',
      sourceExpression: expect.stringContaining('@Secured'),
      reason: expect.stringContaining('Unsupported security annotation'),
    });
    expect(java.endpoints[0]?.permissionIds).toEqual([]);
  });

  it.each([
    `hasAnyRole('MAKER', 'CHECKER')`,
    `hasAuthority(@authorization.requiredAuthority)`,
  ])('keeps unsupported or dynamic authorization conditional in the actor and flow: %s', (expression) => {
    const java = extractJava([javaFile(`
      @RestController
      @RequestMapping("/api/applications")
      public class ApplicationController {
        @PreAuthorize("${expression}")
        @PostMapping
        public Object submit(Object request) {
          repository.save(request);
          return request;
        }
      }
    `)]);
    const { catalog, actors, variants } = buildPipeline(java);

    expect(java.endpoints[0]?.authorization.status).toBe('conditional');
    expect(catalog.operations[0]?.inclusion).toBe('review-required');
    expect(actors.actors[0]).toMatchObject({
      authentication: 'required',
      authoritiesAll: [],
      rolesAll: [],
      label: 'authenticated principal satisfying unresolved authorization',
    });
    expect(actors.actors[0]?.attributePredicates).toEqual([
      expect.objectContaining({ kind: 'opaque', sourceExpression: expect.stringContaining(expression) }),
    ]);
    expect(variants[0]?.feasibility).toBe('conditional');
  });

  it('parses a bounded multiline endpoint signature and attaches DTO constraints only when its request parameter activates validation', () => {
    const java = extractJava([
      javaAt('backend/ApplicationController.java', `
        @RestController
        @RequestMapping("/api/applications")
        public class ApplicationController {
          @PermitAll
          @PostMapping("/submit")
          public ResponseEntity<ApplicationResponse> submit(
              @jakarta.validation.Valid
              @RequestBody ApplicationRequest request,
              Principal principal
          ) throws IOException {
            applicationRepository.save(request);
            return ResponseEntity.ok(new ApplicationResponse());
          }
        }
      `),
      javaAt('backend/ApplicationRequest.java', `
        public class ApplicationRequest {
          @NotBlank
          private String customerId;

          @NotBlank(groups = Create.class)
          private String internalReference;
        }
      `),
    ]);

    expect(java.endpoints).toHaveLength(1);
    expect(java.endpoints[0]).toMatchObject({
      method: 'POST',
      pathTemplate: '/api/applications/submit',
      handler: 'submit',
      requestType: 'ApplicationRequest',
    });
    const appliedRequiredFields = java.validations.filter((validation) => (
      java.endpoints[0]?.validationIds.includes(validation.id) && validation.kind === 'required'
    )).map((validation) => validation.fieldPath);
    expect(appliedRequiredFields).toEqual(['ApplicationRequest.customerId']);
    expect(java.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: 'ApplicationRequest.internalReference', kind: 'required' }),
    ]));
  });

  it('does not claim DTO constraints are enforced by a plain RequestBody parameter', () => {
    const java = extractJava([
      javaAt('backend/ApplicationController.java', `
        @RestController
        public class ApplicationController {
          @PermitAll
          @PostMapping("/api/applications")
          public Object submit(@RequestBody ApplicationRequest request) {
            repository.save(request);
            return request;
          }
        }
      `),
      javaAt('backend/ApplicationRequest.java', `
        public class ApplicationRequest {
          @NotBlank
          private String customerId;
        }
      `),
    ]);

    expect(java.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: 'ApplicationRequest.customerId', kind: 'required' }),
    ]));
    expect(java.endpoints[0]?.validationIds).toEqual([]);
  });

  it('does not treat a Valid model or query parameter as a JSON request-body contract', () => {
    const java = extractJava([javaAt('backend/ApplicationController.java', `
      @RestController
      public class ApplicationController {
        @PermitAll
        @PostMapping("/api/applications")
        public Object submit(@Valid ApplicationRequest request) {
          repository.save(request);
          return request;
        }
      }
    `)]);

    expect(java.endpoints[0]).not.toHaveProperty('requestType');
    expect(java.endpoints[0]?.validationIds).toEqual([]);
  });

  it.each(['BindingResult', 'Errors'])('keeps validated request bodies followed by %s conditional', (resultType) => {
    const java = extractJava([
      javaAt('backend/ApplicationController.java', `
        @RestController
        public class ApplicationController {
          @PermitAll
          @PostMapping("/api/applications")
          public Object submit(@Valid @RequestBody ApplicationRequest request, ${resultType} errors) {
            repository.save(request);
            return request;
          }
        }
      `),
      javaAt('backend/ApplicationRequest.java', `
        public class ApplicationRequest {
          @NotBlank
          private String customerId;
        }
      `),
    ]);

    expect(java.endpoints[0]?.validationIds).toEqual([]);
    expect(solvePredicate(java.endpoints[0]!.domainGuard).status).toBe('conditional');
    expect(java.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JAVA_VALIDATION_ACTIVATION_CONDITIONAL' }),
    ]));
  });

  it.each([
    ['grouped parameter validation', '@Validated(Create.class) @RequestBody ApplicationRequest request'],
    ['method-level validation', '@RequestBody ApplicationRequest request'],
  ])('keeps unsupported %s conditional without attaching every DTO constraint', (_label, parameter) => {
    const methodAnnotation = _label === 'method-level validation' ? '@Validated' : '';
    const java = extractJava([
      javaAt('backend/ApplicationController.java', `
        @RestController
        public class ApplicationController {
          @PermitAll
          @PostMapping("/api/applications")
          ${methodAnnotation}
          public Object submit(${parameter}) {
            repository.save(request);
            return request;
          }
        }
      `),
      javaAt('backend/ApplicationRequest.java', `
        public class ApplicationRequest {
          @NotBlank
          private String customerId;
        }
      `),
    ]);

    expect(java.endpoints[0]?.validationIds).toEqual([]);
    expect(solvePredicate(java.endpoints[0]!.domainGuard).status).toBe('conditional');
    expect(java.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JAVA_VALIDATION_ACTIVATION_CONDITIONAL' }),
    ]));
  });
});

function buildPipeline(java: ReturnType<typeof extractJava>) {
  const endpoint = java.endpoints[0]!;
  const httpId = 'http.submit';
  const handlerId = 'handler.submit';
  const bundle: ExtractionBundle = {
    sourceDigest: 'sha256:authorization-test',
    sourceFiles: [],
    routes: [],
    pages: [{
      id: 'page.entry',
      name: 'Entry page',
      file: 'EntryPage.tsx',
      routeIds: [],
      sourceRef: { file: 'EntryPage.tsx', line: 1 },
    }],
    handlers: [{
      id: handlerId,
      name: 'submit',
      file: 'EntryPage.tsx',
      calls: [],
      httpOperationIds: [httpId],
      navigationIds: [],
      sourceRef: { file: 'EntryPage.tsx', line: 4 },
    }],
    actions: [{
      id: 'action.submit',
      pageId: 'page.entry',
      component: 'button',
      event: 'onClick',
      accessibleName: 'Submit',
      handlerId,
      visibleWhen: [],
      enabledWhen: [],
      sourceRef: { file: 'EntryPage.tsx', line: 8 },
    }],
    fields: [],
    httpOperations: [{
      id: httpId,
      method: endpoint.method,
      pathTemplate: endpoint.pathTemplate,
      sourceRef: { file: 'api.ts', line: 2 },
    }],
    navigations: [],
    permissions: java.permissions,
    endpoints: [endpoint],
    validations: java.validations,
    effects: java.effects,
    wikiConcepts: [],
    graphifyNodes: [],
    graphifyEdges: [],
    diagnostics: java.diagnostics,
  };
  const config = {
    analysis: { entryRoutes: [], maxPathDepth: 12, maxStateVisits: 2 },
  } as unknown as FlowctlConfig;
  const catalog = buildOperationCatalog(bundle);
  const actors = buildActorRequirements(bundle, catalog);
  const pages = buildPageContracts(bundle);
  const behavior = buildBehaviorGraph(bundle, catalog, pages, config);
  const families = buildFlowFamilies(catalog, actors, behavior);
  const witnesses = searchPaths(behavior, families, config);
  const variants = reduceVariants(witnesses, families, behavior, pages).variants;
  return { catalog, actors, variants };
}

function javaFile(contents: string): SourceFile {
  return javaAt('backend/ApplicationController.java', contents);
}

function javaAt(relativePath: string, contents: string): SourceFile {
  return {
    absolutePath: `/${relativePath}`,
    relativePath,
    language: 'java',
    contents,
  };
}
