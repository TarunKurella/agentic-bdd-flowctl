import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateBdd } from '../src/bdd/generate.js';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { loadConfig } from '../src/core/config.js';
import { buildGraphSummary, buildVariantTrace, listFlows } from '../src/graph/trace.js';
import { analyze } from '../src/pipeline/analyze.js';
import { successEnvelope } from '../src/ux/cli-envelope.js';
import { buildAgentPrompt, buildProjectGuide } from '../src/ux/guide.js';

let temporaryRoot: string;
let store: ArtifactStore;

beforeAll(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-agentic-ux-'));
  const projectRoot = path.join(temporaryRoot, 'account-opening');
  const fixtureRoot = path.resolve('examples/account-opening');
  await fs.cp(fixtureRoot, projectRoot, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(fixtureRoot, source);
      return relative !== '.flowctl' && !relative.startsWith(`.flowctl${path.sep}`);
    },
  });
  const config = await loadConfig(path.join(projectRoot, 'flowctl.config.yaml'));
  store = new ArtifactStore(config);
  await analyze(config, 'coverage');
});

afterAll(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('agentic CLI experience', () => {
  it('guides flow selection instead of exposing only artifact existence', async () => {
    const guide = await buildProjectGuide(store);

    expect(guide.phase).toBe('FLOW_SELECTION_REQUIRED');
    expect(guide.inventory.variants).toBe(2);
    expect(guide.primaryAction?.command).toContain('flows list');
    expect(guide.primaryAction?.executor).toBe('agent');
    expect(buildAgentPrompt(guide)).toContain('Do not invent predicates, transitions, actors, identifiers');
  });

  it('renders reviewer attestations as human gates that the agent must not execute', async () => {
    const base = await buildProjectGuide(store);
    const humanAction = {
      id: 'confirm-data',
      kind: 'data' as const,
      executor: 'human' as const,
      title: 'Confirm the reviewed application value',
      reason: 'A supplied application value still needs explicit human confirmation.',
      command: 'flowctl data confirm --requirement requirement.example --reviewer <corporate-id>',
      blocking: true,
    };
    const prompt = buildAgentPrompt({
      ...base,
      phase: 'DATA_REQUIRED',
      nextActions: [humanAction],
      primaryAction: humanAction,
    });

    expect(prompt).toContain('HUMAN GATE — stop and ask a named human');
    expect(prompt).toContain('never execute this as the agent');
    expect(prompt).toContain('Never execute an action marked [human]');
    expect(prompt).toContain('never supply `--reviewer`');
  });

  it('summarizes the graph and proves a selected variant through exact witness occurrences', async () => {
    const [summary, flows, trace] = await Promise.all([
      buildGraphSummary(store),
      listFlows(store),
      buildVariantTrace(store, 'application.submit.joint'),
    ]);

    expect(summary.flows).toMatchObject({ families: 1, variants: 2, witnesses: 2 });
    expect(flows.map((flow) => flow.id)).toContain('application.submit.joint');
    expect(trace.witness.id).toBeTruthy();
    expect(trace.actionSteps.length).toBeGreaterThan(0);
    expect(trace.actionSteps.at(-1)?.operationIds.length).toBeGreaterThan(0);
    expect(trace.operations[0]).toMatchObject({ method: 'POST', pathTemplate: '/api/applications' });
    expect(trace.path.some((item) => item.sourceRefs.length > 0)).toBe(true);
  });

  it('emits traceable, explicitly unimplemented BDD and advances guidance to data', async () => {
    const files = await generateBdd(store, 'application.submit');
    const featurePath = files.find((file) => file.endsWith('application.submit.feature'))!;
    const feature = await fs.readFile(featurePath, 'utf8');
    const tracePath = files.find((file) => file.endsWith('bdd-traceability.json'))!;
    const trace = JSON.parse(await fs.readFile(tracePath, 'utf8')) as {
      journeys: Array<{ variants: Array<{ statements: Array<{ referenceIds: string[] }> }> }>;
    };
    const statements = trace.journeys.flatMap((journey) => journey.variants).flatMap((variant) => variant.statements);

    expect(feature).toContain('@implementation-required');
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((statement) => statement.referenceIds.length > 0)).toBe(true);

    const guide = await buildProjectGuide(store, { variantId: 'application.submit.joint', environment: 'local' });
    expect(guide.phase).toBe('DATA_REQUIRED');
    expect(guide.primaryAction?.command).toContain('data plan');

    const originalTrace = await fs.readFile(tracePath, 'utf8');
    try {
      const staleTrace = JSON.parse(originalTrace) as { sourceDigest: string };
      staleTrace.sourceDigest = 'sha256:stale-bdd';
      await fs.writeFile(tracePath, JSON.stringify(staleTrace), 'utf8');
      const staleGuide = await buildProjectGuide(store, { variantId: 'application.submit.joint', environment: 'local' });
      expect(staleGuide.phase).toBe('BDD_GENERATION_REQUIRED');
    } finally {
      await fs.writeFile(tracePath, originalTrace, 'utf8');
    }
  });

  it('wraps machine output in the stable CLI envelope', () => {
    expect(successEnvelope({ command: 'flows list', result: { variants: 2 } })).toMatchObject({
      schemaVersion: 'flowctl.cli.v1',
      command: 'flows list',
      ok: true,
      code: 'OK',
      nextActions: [],
      diagnostics: [],
    });
  });

  it('marks the model stale when Graphify or source evidence changes', async () => {
    const graphPath = path.join(store.config.projectRoot, store.config.graphify.graph);
    const original = await fs.readFile(graphPath, 'utf8');
    try {
      await fs.writeFile(graphPath, `${original}\n`, 'utf8');
      const guide = await buildProjectGuide(store);
      expect(guide.phase).toBe('ANALYSIS_REQUIRED');
      expect(guide.progress.staleArtifacts).toBeGreaterThan(0);
      expect(guide.primaryAction?.command).toContain('analyze --through coverage');
    } finally {
      await fs.writeFile(graphPath, original, 'utf8');
    }
  });
});
