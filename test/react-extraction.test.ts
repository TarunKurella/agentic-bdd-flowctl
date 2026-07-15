import { describe, expect, it } from 'vitest';
import { extractReact } from '../src/adapters/react.js';
import type { SourceFile } from '../src/adapters/source.js';
import { solvePredicate } from '../src/ir/predicates.js';

describe('React flow extraction', () => {
  it('extracts nested createBrowserRouter object routes with source-resolved pages', () => {
    const result = extractReact([
      tsxAt('frontend/src/router.tsx', `
        import { createBrowserRouter } from 'react-router-dom';
        import HomePage from './HomePage';
        import CheckoutPage from './CheckoutPage';
        export const router = createBrowserRouter([{ path: '/', element: <main />, children: [
          { path: '', element: <HomePage /> },
          { path: 'checkout', element: <CheckoutPage /> },
        ] }]);
      `),
      tsxAt('frontend/src/HomePage.tsx', `export default function HomePage() { return <h1>Home</h1>; }`),
      tsxAt('frontend/src/CheckoutPage.tsx', `export default function CheckoutPage() { return <button>Place order</button>; }`),
    ]);

    expect(result.routes.map((route) => [route.path, route.component])).toEqual(expect.arrayContaining([
      ['/', 'HomePage'],
      ['/checkout', 'CheckoutPage'],
    ]));
    expect(result.pages.find((page) => page.name === 'HomePage')?.routeIds).toHaveLength(1);
    expect(result.pages.find((page) => page.name === 'CheckoutPage')?.routeIds).toHaveLength(1);
  });

  it('normalizes axios base URLs and resolves common callback wrappers across handlers', () => {
    const result = extractReact([
      tsxAt('frontend/src/api.ts', `
        import axios from 'axios';
        axios.defaults.baseURL = 'http://localhost:8080/api/';
        const requests = { post: (url: string, body: object) => axios.post(url, body) };
        const Account = { login: (values: object) => requests.post('auth/login', values) };
        export default { Account };
      `),
      tsxAt('frontend/src/state.ts', `
        import agent from './api';
        declare function createAsyncThunk(name: string, callback: Function): unknown;
        export const signInUser = createAsyncThunk('auth/login', async (data: object) => agent.Account.login(data));
      `),
      tsxAt('frontend/src/LoginPage.tsx', `
        import { signInUser } from './state';
        export function LoginPage() {
          async function submitForm(data: object) { await signInUser(data); }
          return <form onSubmit={handleSubmit(submitForm)}><button type="submit">Sign in</button></form>;
        }
      `),
    ]);

    expect(result.httpOperations.find((operation) => operation.method === 'POST')).toMatchObject({
      pathTemplate: '/api/auth/login',
      callerSymbol: 'login',
    });
    expect(result.actions[0]).toMatchObject({ handlerName: 'submitForm', handlerResolution: 'exact' });
    expect(result.handlers.find((handler) => handler.name === 'signInUser')?.callSites).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetFile: 'frontend/src/api.ts', targetSymbol: 'login' }),
    ]));
  });

  it('extracts guarded declarative routes and leaves dynamic targets conditional', () => {
    const result = extractReact([tsx(`
      export function RoutingPage() {
        return <main>
          {enabled && <Link to="/review">Review</Link>}
          <Link to={joint ? '/joint' : '/personal'}>Continue</Link>
          <Link to="review">Relative review</Link>
          <a href="/help">Help</a>
          <Navigate to={redirectTarget} />
        </main>;
      }
    `)]);

    const review = result.navigations.find((navigation) => navigation.target === '/review')!;
    expect(review).toMatchObject({ targetStatus: 'exact', trigger: 'declarative', continuationStatus: 'exact' });
    expect(solvePredicate(review.guard).assignments).toMatchObject({ enabled: true });

    const joint = result.navigations.find((navigation) => navigation.target === '/joint')!;
    const personal = result.navigations.find((navigation) => navigation.target === '/personal')!;
    expect(solvePredicate(joint.guard).assignments).toMatchObject({ joint: true });
    expect(solvePredicate(personal.guard).assignments).toMatchObject({ joint: false });
    expect(result.actions.find((action) => action.accessibleName === 'Continue')?.navigationIds).toEqual([
      joint.id,
      personal.id,
    ]);
    const relative = result.navigations.find((navigation) => navigation.target === 'review')!;
    expect(relative.targetStatus).toBe('conditional');
    expect(solvePredicate(relative.guard).status).toBe('conditional');

    const dynamic = result.navigations.find((navigation) => navigation.target === '<dynamic>')!;
    expect(dynamic).toMatchObject({ targetStatus: 'conditional', targetExpression: 'redirectTarget' });
    expect(solvePredicate(dynamic.guard).status).toBe('conditional');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DECLARATIVE_NAVIGATION_TARGET_UNRESOLVED', evidenceRefs: [dynamic.id] }),
    ]));
  });

  it('uses the visible submit control as the form action', () => {
    const result = extractReact([tsx(`
      export function SubmitPage() {
        async function submitApplication() {}
        return <form onSubmit={submitApplication}>
          <input name="customerId" />
          <button type="submit" disabled={busy}>Create application</button>
        </form>;
      }
    `)]);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      component: 'button',
      event: 'submit',
      accessibleName: 'Create application',
      handlerName: 'submitApplication',
    });
    expect(result.actions[0]?.handlerId).toBe(result.handlers.find((handler) => handler.name === 'submitApplication')?.id);
    expect(solvePredicate(result.actions[0]!.enabledWhen[0]!).assignments).toMatchObject({ busy: false });
  });

  it('retains guards and arguments from inline action handlers', () => {
    const result = extractReact([tsx(`
      export function InlineHandlerPage() {
        async function submitApplication(payload: unknown) {}
        return <button onClick={() => eligible && submitApplication({ applicationType: 'JOINT' })}>Submit</button>;
      }
    `)]);

    const action = result.actions[0]!;
    expect(action.handlerName).toMatch(/^\$inline_/);
    const handler = result.handlers.find((candidate) => candidate.id === action.handlerId)!;
    const submit = handler.callSites?.find((callSite) => callSite.calleeSymbol === 'submitApplication')!;
    expect(solvePredicate(submit.guard!).assignments).toMatchObject({ eligible: true });
    expect(submit.argumentPayloads[0]).toMatchObject({
      certainty: 'exact',
      fields: [expect.objectContaining({ name: 'applicationType', value: { kind: 'literal', value: 'JOINT' } })],
    });
  });

  it('prefers routed page exports and scopes controls to their component', () => {
    const result = extractReact([
      tsxAt('frontend/src/pages/Application.tsx', `
        function HelperCard() { return <button onClick={openHelp}>Helper action</button>; }
        export function ApplicationPage() { return <button onClick={submitApplication}>Submit application</button>; }
      `),
      tsxAt('frontend/src/AppRoutes.tsx', `
        export function AppRoutes() { return <Routes><Route path="/apply" element={<ApplicationPage />} /></Routes>; }
      `),
      tsxAt('frontend/src/ui/CustomerSelect.tsx', `
        export function CustomerSelect() { return <select name="customer"><option value="one">One</option></select>; }
      `),
    ]);

    expect(result.pages).toEqual([
      expect.objectContaining({ name: 'ApplicationPage', routeIds: [expect.any(String)] }),
    ]);
    expect(result.actions.map((action) => action.accessibleName)).toEqual(['Submit application']);
    expect(result.fields).toHaveLength(0);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'REACT_PAGE_OWNERSHIP_UNRESOLVED')).toBe(false);
  });

  it('blocks ambiguous page ownership instead of assigning a whole file to the first helper', () => {
    const result = extractReact([tsxAt('frontend/src/pages/Ambiguous.tsx', `
      function FirstCard() { return <button>First</button>; }
      function SecondCard() { return <button>Second</button>; }
    `)]);

    expect(result.pages).toHaveLength(0);
    expect(result.actions).toHaveLength(0);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REACT_PAGE_OWNERSHIP_UNRESOLVED', severity: 'blocked' }),
    ]));
  });

  it('marks uninlined custom child components as incomplete page evidence', () => {
    const result = extractReact([tsx(`
      export function CompositePage() {
        return <Layout><AddressForm /></Layout>;
      }
    `)]);

    expect(result.pages[0]).toMatchObject({ completeness: 'conditional' });
    expect(result.pages[0]?.unresolvedChildComponentRefs?.map((ref) => ref.symbol)).toEqual(['AddressForm', 'Layout']);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'REACT_CHILD_COMPONENT_UNRESOLVED')).toHaveLength(2);
  });

  it('composes source-owned layout components and unfolds finite mapped router links', () => {
    const result = extractReact([
      tsxAt('frontend/src/router.tsx', `
        import { createBrowserRouter } from 'react-router-dom';
        import App from './App';
        import LoginPage from './LoginPage';
        export const router = createBrowserRouter([{ path: '/', element: <App />, children: [
          { path: 'login', element: <LoginPage /> },
        ] }]);
      `),
      tsxAt('frontend/src/App.tsx', `
        import Header from './Header';
        import { Outlet } from 'react-router-dom';
        export default function App() { return <main><Header /><Outlet /></main>; }
      `),
      tsxAt('frontend/src/Header.tsx', `
        import { Box, List, ListItem } from '@mui/material';
        import { NavLink } from 'react-router-dom';
        const accountLinks = [
          { title: 'Login', path: '/login' },
          { title: 'Register', path: '/register' },
        ];
        export default function Header() { return <Box><List>{accountLinks.map(({ title, path }) => (
          <ListItem component={NavLink} to={path} key={path}>{title}</ListItem>
        ))}</List></Box>; }
      `),
      tsxAt('frontend/src/LoginPage.tsx', `export default function LoginPage() { return <h1>Login</h1>; }`),
    ]);

    const app = result.pages.find((page) => page.name === 'App');
    expect(app).toBeDefined();
    expect(result.navigations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromPageId: app?.id, target: '/login', targetStatus: 'exact' }),
      expect.objectContaining({ fromPageId: app?.id, target: '/register', targetStatus: 'exact' }),
    ]));
    expect(result.actions.find((action) => action.pageId === app?.id)?.navigationIds).toHaveLength(2);
    expect(result.diagnostics.filter((diagnostic) => (
      diagnostic.code === 'REACT_CHILD_COMPONENT_UNRESOLVED'
      && ['Header', 'Box', 'List', 'ListItem'].some((name) => diagnostic.message.includes(name))
    ))).toHaveLength(0);
  });

  it('uses reviewed transparent containers without hiding unknown interactive children', () => {
    const result = extractReact([tsx(`
      export function CompositePage() { return <Layout><AddressForm /></Layout>; }
    `)], { transparentComponents: ['Layout'] });

    expect(result.pages[0]).toMatchObject({ completeness: 'conditional' });
    expect(result.pages[0]?.unresolvedChildComponentRefs?.map((ref) => ref.symbol)).toEqual(['AddressForm']);
  });

  it('infers common registered and controlled native fields without silently dropping them', () => {
    const result = extractReact([tsx(`
      export function RegistrationPage() {
        return <main>
          <input {...register("email")} />
          <input value={phone} onChange={(event) => setPhone(event.target.value)} />
        </main>;
      }
    `)]);

    expect(result.fields.map((field) => field.dataPath)).toEqual(['email', 'phone']);
    expect(result.fields.find((field) => field.dataPath === 'phone')).toMatchObject({
      inputMode: 'editable',
      valueBinding: { path: 'phone', writable: true },
    });
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'REACT_NATIVE_CONTROL_UNRESOLVED')).toBe(false);
  });

  it('compiles the supported static React Hook Form register options without an opaque spread constraint', () => {
    const result = extractReact([tsx(`
      export function RegistrationPage() {
        return <input {...register('username', { required: 'Username is required', minLength: 3 })} />;
      }
    `)]);

    expect(result.fields[0]?.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'required', value: true }),
      expect.objectContaining({ kind: 'min', domain: 'length', value: 3 }),
    ]));
    expect(result.fields[0]?.constraints.some((constraint) => constraint.kind === 'opaque')).toBe(false);
  });

  it('marks unidentified native controls conditional, skips hidden values, and keeps uncontrolled defaults editable', () => {
    const result = extractReact([tsx(`
      export function NativeControlsPage() {
        return <main>
          <input {...fieldProps} />
          <input name="csrf" type="hidden" value={csrf} />
          <input name="country" defaultValue="IN" />
          <input name="accepted" type="checkbox" defaultChecked />
        </main>;
      }
    `)]);

    expect(result.pages[0]).toMatchObject({ completeness: 'conditional' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REACT_NATIVE_CONTROL_UNRESOLVED', severity: 'blocked' }),
    ]));
    expect(result.fields.find((field) => field.dataPath === 'csrf')?.inputMode).toBe('read-only');
    expect(result.fields.find((field) => field.dataPath === 'country')?.inputMode).toBe('editable');
    expect(result.fields.find((field) => field.dataPath === 'accepted')?.inputMode).toBe('editable');
  });

  it('resolves same-named handlers by lexical declaration identity', () => {
    const result = extractReact([tsxAt('frontend/src/pages/Shared.tsx', `
      async function submitFirst() { return fetch('/api/first', { method: 'POST' }); }
      async function submitSecond() { return fetch('/api/second', { method: 'POST' }); }
      export function FirstPage() {
        const handleSubmit = async () => submitFirst();
        return <button onClick={handleSubmit}>First submit</button>;
      }
      export function SecondPage() {
        const handleSubmit = async () => submitSecond();
        return <button onClick={handleSubmit}>Second submit</button>;
      }
      export function AppRoutes() { return <Routes>
        <Route path="/first" element={<FirstPage />} />
        <Route path="/second" element={<SecondPage />} />
      </Routes>; }
    `)]);
    const first = result.actions.find((action) => action.accessibleName === 'First submit')!;
    const second = result.actions.find((action) => action.accessibleName === 'Second submit')!;

    expect(first.handlerId).not.toBe(second.handlerId);
    expect(result.handlers.find((handler) => handler.id === first.handlerId)?.calls).toContain('submitFirst');
    expect(result.handlers.find((handler) => handler.id === second.handlerId)?.calls).toContain('submitSecond');
  });

  it('joins duplicate component names to routes by source declaration', () => {
    const result = extractReact([
      tsxAt('frontend/src/one/ReviewPage.tsx', `export function ReviewPage() { return <button>One</button>; }`),
      tsxAt('frontend/src/two/ReviewPage.tsx', `export function ReviewPage() { return <button>Two</button>; }`),
      tsxAt('frontend/src/AppRoutes.tsx', `
        import { ReviewPage as FirstReview } from './one/ReviewPage';
        import { ReviewPage as SecondReview } from './two/ReviewPage';
        export function AppRoutes() { return <Routes>
          <Route path="/one" element={<FirstReview />} />
          <Route path="/two" element={<SecondReview />} />
        </Routes>; }
      `),
    ]);
    const one = result.pages.find((page) => page.file.includes('/one/'))!;
    const two = result.pages.find((page) => page.file.includes('/two/'))!;
    const oneRoute = result.routes.find((route) => route.path === '/one')!;
    const twoRoute = result.routes.find((route) => route.path === '/two')!;

    expect(one.routeIds).toEqual([oneRoute.id]);
    expect(two.routeIds).toEqual([twoRoute.id]);
    expect(oneRoute.componentFile).toBe('frontend/src/one/ReviewPage.tsx');
    expect(twoRoute.componentFile).toBe('frontend/src/two/ReviewPage.tsx');
  });

  it('merges same-name choice controls into stable page-scoped groups with static options', () => {
    const source = tsx(`
      export function ApplicationTypePage() {
        return <main>
          <label><input type="radio" name="applicationType" value="PERSONAL" required />Personal</label>
          <label><input type="radio" name="applicationType" value="JOINT" />Joint</label>
          <label><input type="checkbox" name="features" value="PAPERLESS" />Paperless</label>
          <label><input type="checkbox" name="features" value="ALERTS" />Alerts</label>
        </main>;
      }
    `);
    const first = extractReact([source]);
    const second = extractReact([source]);

    expect(first.fields).toHaveLength(2);
    const applicationType = first.fields.find((field) => field.dataPath === 'applicationType')!;
    expect(applicationType).toMatchObject({ controlKind: 'radio' });
    expect(applicationType.optionSource).toMatchObject({
      status: 'static',
      options: [
        { value: 'PERSONAL', label: 'Personal' },
        { value: 'JOINT', label: 'Joint' },
      ],
    });
    expect(applicationType.requiredWhen).toHaveLength(1);
    expect(applicationType.constraints.filter((constraint) => constraint.kind === 'enum')).toEqual([
      expect.objectContaining({ value: ['PERSONAL', 'JOINT'], domain: 'value-set' }),
    ]);
    expect(applicationType.id).toBe(second.fields.find((field) => field.dataPath === 'applicationType')?.id);
    expect(new Set(first.fields.map((field) => field.id)).size).toBe(first.fields.length);

    expect(first.fields.find((field) => field.dataPath === 'features')?.optionSource?.options.map((option) => option.value)).toEqual([
      'PAPERLESS',
      'ALERTS',
    ]);
  });

  it('distinguishes static, runtime, and unknown select option sources', () => {
    const result = extractReact([tsx(`
      const STATIC_TIERS = [{ value: 'GOLD', label: 'Gold' }, { value: 'SILVER', label: 'Silver' }] as const;
      export function ProductPage() {
        return <main>
          <select name="country" value={country} onChange={(event) => setCountry(event.target.value)}>
            <option value="IN">India</option>
            <option value="GB">United Kingdom</option>
          </select>
          <Select name="tier" options={STATIC_TIERS} />
          <CustomerSelect name="customerId" options={customers} />
          <AccountPicker name="accountId" value={accountId} onChange={setAccountId} />
          <ProductPicker name="productCode" />
        </main>;
      }
    `)]);

    expect(result.fields.find((field) => field.dataPath === 'country')?.optionSource).toMatchObject({
      status: 'static',
      options: [{ value: 'IN', label: 'India' }, { value: 'GB', label: 'United Kingdom' }],
    });
    expect(result.fields.find((field) => field.dataPath === 'country')?.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'enum', value: ['IN', 'GB'] }),
    ]));
    expect(result.fields.find((field) => field.dataPath === 'tier')?.optionSource).toMatchObject({
      status: 'static',
      options: [{ value: 'GOLD', label: 'Gold' }, { value: 'SILVER', label: 'Silver' }],
    });
    expect(result.fields.find((field) => field.dataPath === 'customerId')?.optionSource?.status).toBe('runtime');
    expect(result.fields.find((field) => field.dataPath === 'accountId')?.optionSource).toMatchObject({
      status: 'runtime',
      expression: expect.stringContaining('external-options:AccountPicker'),
    });
    expect(result.fields.find((field) => field.dataPath === 'productCode')?.optionSource?.status).toBe('unknown');
    expect(result.fields.find((field) => field.dataPath === 'customerId')?.constraints.some((constraint) => constraint.kind === 'opaque')).toBe(false);
    expect(result.fields.find((field) => field.dataPath === 'accountId')?.constraints.some((constraint) => constraint.kind === 'opaque')).toBe(false);
    expect(result.fields.find((field) => field.dataPath === 'productCode')?.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'opaque', domain: 'value-set' }),
    ]));
  });

  it('extracts supported browser constraints and makes unsupported validation explicit', () => {
    const result = extractReact([tsx(`
      export function ValidationPage() {
        return <main>
          <input name="age" type="number" min={18} max="65" step="1" />
          <input name="email" type="email" required />
          <input name="attachment" type="file" accept="image/png" />
          <Field name="taxId" validationSchema={taxIdSchema} />
        </main>;
      }
    `)]);

    const age = result.fields.find((field) => field.dataPath === 'age')!;
    expect(age.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'min', domain: 'numeric', value: 18 }),
      expect.objectContaining({ kind: 'max', domain: 'numeric', value: 65 }),
      expect.objectContaining({ kind: 'type', domain: 'type', value: 'number' }),
      expect.objectContaining({ kind: 'opaque', message: expect.stringContaining('step') }),
    ]));
    expect(result.fields.find((field) => field.dataPath === 'email')?.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'format', value: 'email' }),
      expect.objectContaining({ kind: 'required', value: true }),
    ]));
    expect(result.fields.find((field) => field.dataPath === 'attachment')?.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'opaque', message: expect.stringContaining('accept') }),
    ]));
    expect(result.fields.find((field) => field.dataPath === 'taxId')?.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'opaque', message: expect.stringContaining('validationSchema') }),
    ]));
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'FRONTEND_VALIDATION_UNRESOLVED').length).toBeGreaterThanOrEqual(3);
  });

  it('infers the value type written by controlled fields', () => {
    const result = extractReact([tsx(`
      import { useState } from 'react';
      export function TypedFieldsPage() {
        const [rawAge, setRawAge] = useState('');
        const [age, setAge] = useState<number>(0);
        const [count, setCount] = useState<number>(0);
        const [accepted, setAccepted] = useState(false);
        return <main>
          <input name="rawAge" type="number" value={rawAge} onChange={(event) => setRawAge(event.target.value)} />
          <input name="age" type="number" value={age} onChange={(event) => setAge(Number(event.target.value))} />
          <NumberPicker name="count" value={count} onChange={setCount} />
          <input name="accepted" type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
        </main>;
      }
    `)]);

    expect(result.fields.find((field) => field.dataPath === 'rawAge')?.valueBinding).toMatchObject({ writable: true, valueType: 'string' });
    expect(result.fields.find((field) => field.dataPath === 'age')?.valueBinding).toMatchObject({ writable: true, valueType: 'number' });
    expect(result.fields.find((field) => field.dataPath === 'count')?.valueBinding).toMatchObject({ writable: true, valueType: 'number' });
    expect(result.fields.find((field) => field.dataPath === 'accepted')?.valueBinding).toMatchObject({ writable: true, valueType: 'boolean' });
    expect(result.fields.find((field) => field.dataPath === 'accepted')?.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type', value: 'boolean' }),
    ]));
    expect(result.fields.find((field) => field.dataPath === 'accepted')?.constraints.some((constraint) => constraint.kind === 'enum')).toBe(false);
  });

  it('distinguishes editable, read-only and conditionally disabled fields', () => {
    const result = extractReact([tsx(`
      export function FieldModePage() { return <main>
        <input name="editable" />
        <input name="derived" value={derivedValue} readOnly />
        <input name="conditional" disabled={locked} />
      </main>; }
    `)]);

    expect(result.fields.find((field) => field.dataPath === 'editable')?.inputMode).toBe('editable');
    expect(result.fields.find((field) => field.dataPath === 'derived')?.inputMode).toBe('read-only');
    expect(result.fields.find((field) => field.dataPath === 'conditional')?.inputMode).toBe('conditional');
  });

  it('does not fabricate controls from an uninvoked nested JSX function', () => {
    const result = extractReact([tsx(`
      async function deleteAll() { return fetch('/api/all', { method: 'DELETE' }); }
      export function SafePage() {
        const Unused = () => <button onClick={deleteAll}>Delete all</button>;
        return <main>No destructive action is rendered</main>;
      }
    `)]);

    expect(result.actions.find((action) => action.accessibleName === 'Delete all')).toBeUndefined();
    expect(result.pages[0]).toMatchObject({ completeness: 'exact' });
  });

  it('retains JSX inside an inline render callback contained by the page return', () => {
    const result = extractReact([tsx(`
      export function ListPage() {
        return <main>{items.map((item) => (
          <button onClick={() => selectItem(item.id)}>Select item</button>
        ))}</main>;
      }
    `)]);

    expect(result.actions.find((action) => action.accessibleName === 'Select item')).toBeDefined();
  });

  it('keeps called nested render helpers conditional instead of silently inlining them', () => {
    const result = extractReact([tsx(`
      export function HelperPage() {
        function renderAction() { return <button onClick={submit}>Submit</button>; }
        return <main>{renderAction()}</main>;
      }
    `)]);

    expect(result.actions.find((action) => action.accessibleName === 'Submit')).toBeUndefined();
    expect(result.pages[0]).toMatchObject({ completeness: 'conditional' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REACT_RENDER_HELPER_UNRESOLVED', severity: 'blocked' }),
    ]));
  });

  it('keeps referenced page-local detached JSX conditional without fabricating its controls', () => {
    const result = extractReact([tsx(`
      export function DetachedValuePage() {
        const hiddenAction = <button onClick={submit}>Submit</button>;
        const renderedValue = hiddenAction;
        return <main>{renderedValue}</main>;
      }
    `)]);

    expect(result.actions.find((action) => action.accessibleName === 'Submit')).toBeUndefined();
    expect(result.pages[0]).toMatchObject({ completeness: 'conditional' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REACT_DETACHED_JSX_BINDING_UNRESOLVED', severity: 'blocked' }),
    ]));
  });
});

function tsx(contents: string): SourceFile {
  return tsxAt('frontend/src/pages/TestPage.tsx', contents);
}

function tsxAt(relativePath: string, contents: string): SourceFile {
  return {
    absolutePath: `/${relativePath}`,
    relativePath,
    language: 'typescript',
    contents,
  };
}
