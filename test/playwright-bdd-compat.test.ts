import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fg from 'fast-glob';
import { generateBdd } from '../src/bdd/generate.js';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { loadConfig } from '../src/core/config.js';
import { analyze } from '../src/pipeline/analyze.js';

const execFileAsync = promisify(execFile);
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), '.flowctl-bddgen-'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('Playwright-BDD compatibility', () => {
  it('compiles generated runnable journeys against the generated reusable step registry', async () => {
    const fixtureRoot = path.resolve('examples/account-opening');
    const applicationRoot = path.join(root, 'application');
    await fs.cp(fixtureRoot, applicationRoot, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(fixtureRoot, source);
        return relative !== '.flowctl' && !relative.startsWith(`.flowctl${path.sep}`);
      },
    });
    const config = await loadConfig(path.join(applicationRoot, 'flowctl.config.yaml'));
    const store = new ArtifactStore(config);
    await analyze(config, 'coverage');
    const generated = await generateBdd(store, 'application.submit');
    expect(generated.some((file) => file.endsWith('.feature'))).toBe(true);

    await fs.writeFile(path.join(root, 'steps.ts'), `
      import { bindFlowRuntime, type FlowRuntime } from './application/.flowctl/generated/steps/flowctl.steps.generated.js';

      const runtime = new Proxy({}, { get: () => async () => undefined }) as FlowRuntime;
      bindFlowRuntime(runtime);
    `, 'utf8');
    await fs.writeFile(path.join(root, 'playwright.config.ts'), `
      import { defineConfig } from '@playwright/test';
      import { defineBddConfig } from 'playwright-bdd';

      const testDir = defineBddConfig({
        features: './application/.flowctl/generated/features/journeys/*.feature',
        steps: [
          './application/.flowctl/generated/steps/flowctl.steps.generated.ts',
          './steps.ts',
        ],
        outputDir: './.features-gen',
      });
      export default defineConfig({ testDir });
    `, 'utf8');

    const { stdout } = await execFileAsync(path.resolve('node_modules/.bin/bddgen'), ['--config', path.join(root, 'playwright.config.ts'), 'test', '--verbose'], {
      cwd: root,
      timeout: 30_000,
    });
    expect(stdout).toMatch(/Found step files[\s\S]*\([1-9]\d* steps\)/);
    const compiled = await fg('**/*.spec.*', { cwd: path.join(root, '.features-gen'), dot: true });
    expect(compiled.length).toBeGreaterThan(0);
  }, 45_000);
});
