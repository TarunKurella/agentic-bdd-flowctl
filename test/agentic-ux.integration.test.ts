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
import type { CoverageReport, FlowVariants } from '../src/ir/model.js';
import { buildSourceRepairPlan } from '../src/ux/source-repair.js';

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
    expect(buildAgentPrompt(guide)).toContain('A predicate may be proposed only for a current rule-packet gap');
  });

  it('keeps complete variants selectable while unrelated operation coverage remains incomplete', async () => {
    const original = await store.read<CoverageReport>('coverage');
    const first = original.data.operationCoverage[0]!;
    const data: CoverageReport = {
      ...original.data,
      operationCoverage: [{
        ...first,
        status: 'uncovered',
        missingStage: 'action-operation-join',
        witnessIds: [],
        variantIds: [],
      }],
    };
    try {
      await store.write('coverage', store.createEnvelope({
        artifactType: original.meta.artifactType,
        producer: original.meta.producer,
        sourceDigest: original.meta.sourceDigest,
        inputDigests: original.meta.inputDigests,
        data,
        status: original.meta.status,
        unresolved: original.meta.unresolved,
      }));
      const guide = await buildProjectGuide(store);
      expect(guide.phase).toBe('FLOW_SELECTION_REQUIRED');
      expect(guide.primaryAction?.command).toContain('flows list');
      expect(guide.attention).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'OPERATION_COVERAGE_BACKLOG', blocking: false }),
      ]));
    } finally {
      await store.write('coverage', original);
    }
  });

  it('turns a current zero-variant model into a bounded source-repair task instead of a coverage loop', async () => {
    const originalCoverage = await store.read<CoverageReport>('coverage');
    const originalVariants = await store.read<FlowVariants>('variants');
    const first = originalCoverage.data.operationCoverage[0]!;
    try {
      await store.write('variants', store.createEnvelope({
        artifactType: originalVariants.meta.artifactType,
        producer: originalVariants.meta.producer,
        sourceDigest: originalVariants.meta.sourceDigest,
        inputDigests: originalVariants.meta.inputDigests,
        data: { variants: [] },
        status: originalVariants.meta.status,
        unresolved: originalVariants.meta.unresolved,
      }));
      await store.write('coverage', store.createEnvelope({
        artifactType: originalCoverage.meta.artifactType,
        producer: originalCoverage.meta.producer,
        sourceDigest: originalCoverage.meta.sourceDigest,
        inputDigests: {
          ...originalCoverage.meta.inputDigests,
          variants: (await store.read<FlowVariants>('variants')).meta.contentDigest,
        },
        data: {
          ...originalCoverage.data,
          operationCoverage: [{
            ...first,
            status: 'uncovered',
            missingStage: 'entry-success-witness',
            witnessIds: [],
            variantIds: [],
          }],
        },
        status: originalCoverage.meta.status,
        unresolved: originalCoverage.meta.unresolved,
      }));

      const guide = await buildProjectGuide(store);
      expect(guide.phase).toBe('SOURCE_REPAIR_REQUIRED');
      expect(guide.primaryAction?.command).toContain('repair plan');
      expect(buildAgentPrompt(guide)).toContain('Rerun discovery only after evidence');
      const repair = await buildSourceRepairPlan(store);
      expect(repair.status).toBe('source-repair-required');
      expect(repair.gaps[0]).toMatchObject({
        operationId: first.operationId,
        missingStage: 'entry-success-witness',
      });
      expect(repair.gaps[0]?.evidence.length).toBeGreaterThan(0);
      expect(repair.gaps[0]?.agentHints).toEqual(expect.arrayContaining([
        expect.objectContaining({ origin: 'ast-grep-hint' }),
      ]));
    } finally {
      await store.write('variants', originalVariants);
      await store.write('coverage', originalCoverage);
    }
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
