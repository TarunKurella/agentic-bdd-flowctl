import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { loadConfig } from '../src/core/config.js';
import { inspectProjectHealth } from '../src/ux/doctor.js';
import { buildProjectGuide } from '../src/ux/guide.js';
import { listRuns, showRun } from '../src/ux/runs.js';

const execute = promisify(execFile);
let temporaryRoot: string;
let projectRoot: string;
let configPath: string;

beforeAll(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-cli-ux-'));
  projectRoot = path.join(temporaryRoot, 'account-opening');
  const fixtureRoot = path.resolve('examples/account-opening');
  await fs.cp(fixtureRoot, projectRoot, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(fixtureRoot, source);
      return relative !== '.flowctl' && !relative.startsWith(`.flowctl${path.sep}`);
    },
  });
  configPath = path.join(projectRoot, 'flowctl.config.yaml');
});

afterAll(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('improved CLI operator experience', () => {
  it('returns actionable doctor checks with exact configuration keys and output paths', async () => {
    const config = await loadConfig(configPath);
    const result = await inspectProjectHealth(config);

    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.check === 'runtime:base-url')?.configKeys).toEqual([
      'runtime.baseUrl',
      'runtime.environment',
    ]);
    expect(result.checks.find((check) => check.check === 'runtime:runner')?.configKeys).toContain('runtime.runner.command');
    expect(result.paths.coverageReport).toBe(path.join(config.outputRoot, 'artifacts', 'coverage.json'));
    expect(result.paths.unresolvedDataRequirements).toBe(path.join(config.outputRoot, 'artifacts', 'data-requirements'));
  });

  it('keeps JSON output clean while streaming versioned JSONL progress to stderr', async () => {
    const result = await execute(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'discover',
      '--config',
      configPath,
      '--json',
      '--progress',
      'jsonl',
    ], { cwd: path.resolve('.') });
    const envelope = JSON.parse(result.stdout) as {
      schemaVersion: string;
      result: { analysis: { runId: string } };
      agent: {
        schemaVersion: string;
        disposition: string;
        primaryAction: { id: string; command: string };
        afterAction: { resumeCommand: string };
      };
    };
    const events = result.stderr.trim().split('\n').map((line) => JSON.parse(line) as {
      schemaVersion: string;
      event: string;
      command: string;
      sequence: number;
    });

    expect(envelope.schemaVersion).toBe('flowctl.cli.v1');
    expect(envelope.agent).toMatchObject({
      schemaVersion: 'flowctl.agent.v1',
      disposition: 'execute',
      primaryAction: { id: 'select-flow' },
    });
    expect(envelope.agent.afterAction.resumeCommand).toContain(`--config '${configPath}'`);
    expect(envelope.agent.afterAction.resumeCommand).toContain('--variant SELECTED_VARIANT_ID');
    expect(envelope.agent.primaryAction.command).toContain('--json');
    expect(envelope.result.analysis.runId).toMatch(/^analysis\./);
    expect(events[0]).toMatchObject({ schemaVersion: 'flowctl.progress.v1', event: 'analysis.started', command: 'discover', sequence: 1 });
    expect(events.at(-1)?.event).toBe('analysis.completed');
    expect(events.filter((event) => event.event === 'stage.completed')).toHaveLength(9);
  });

  it('lists and shows the latest run with report and resume paths', async () => {
    const config = await loadConfig(configPath);
    const store = new ArtifactStore(config);
    const runs = await listRuns(store);
    const latest = await showRun(store, 'latest');

    expect(runs.length).toBeGreaterThan(0);
    expect(latest.kind).toBe('analysis');
    expect(latest.status).toBe('completed');
    expect(latest.paths.coverageReport).toBe(store.artifactPath('coverage'));
    expect(latest.paths.dataRequirements).toBe(store.dataRequirementsDirectory);
    expect(latest.resume?.command).toContain('agent guide');
  });

  it('steers the agent from flow catalog output into proof inspection and a variant-scoped guide', async () => {
    const result = await execute(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'flows',
      'list',
      '--config',
      configPath,
      '--json',
    ], { cwd: path.resolve('.') });
    const envelope = JSON.parse(result.stdout) as {
      agent: {
        disposition: string;
        primaryAction: { id: string; command: string };
        afterAction: { resumeCommand: string };
      };
    };

    expect(envelope.agent).toMatchObject({
      disposition: 'execute',
      primaryAction: { id: 'select-flow-from-catalog' },
    });
    expect(envelope.agent.primaryAction.command).toContain('flows show SELECTED_VARIANT_ID');
    expect(envelope.agent.primaryAction.command).toContain('--json');
    expect(envelope.agent.afterAction.resumeCommand).toContain('--variant SELECTED_VARIANT_ID');
  });

  it('stops the agent with exact application-data questions instead of looping back to data plan', async () => {
    const result = await execute(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'data',
      'plan',
      '--flow',
      'application.submit.joint',
      '--config',
      configPath,
      '--json',
    ], { cwd: path.resolve('.') });
    const envelope = JSON.parse(result.stdout) as {
      result: { bindingRequests: unknown[] };
      agent: { disposition: string; instruction: string; retryPolicy: { allowed: boolean } };
    };

    expect(envelope.result.bindingRequests.length).toBeGreaterThan(0);
    expect(envelope.agent).toMatchObject({
      disposition: 'stop-for-human',
      retryPolicy: { allowed: false },
    });
    expect(envelope.agent.instruction).toContain('Never fill <...> placeholders');
  });

  it('includes exact unresolved-data and report paths in lifecycle guidance', async () => {
    const config = await loadConfig(configPath);
    const store = new ArtifactStore(config);
    const guide = await buildProjectGuide(store, { variantId: 'application.submit.joint', environment: 'local' });

    expect(guide.paths.coverageReport).toBe(store.artifactPath('coverage'));
    expect(guide.selectedVariant?.data.requirementsPath).toBe(path.join(store.dataRequirementsDirectory, 'application.submit.joint.yaml'));
    expect(guide.blockers.find((blocker) => blocker.code.startsWith('DATA_REQUIRED:'))?.paths).toContain(config.applicationDataPath);
  });
});
