import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotSources } from '../src/adapters/source.js';
import { loadConfig } from '../src/core/config.js';

describe('source snapshot boundaries', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('keeps a dot source root relative to the configured project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-source-root-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'inside.ts'), 'export const inside = true;', 'utf8');
    await fs.writeFile(path.join(root, 'flowctl.config.yaml'), `
version: 1
project: { name: dot-root, root: . }
sources:
  frontend: [.]
  backend: []
  include: ["**/*.ts"]
  exclude: []
graphify: { graph: graphify.json, required: false }
wiki: { paths: [], required: false }
analysis: { entryRoutes: [], includeHttpMethods: [POST], transparentComponents: [], maxPathDepth: 10, maxStateVisits: 1 }
output: { directory: .flowctl }
runtime: { environment: local }
`, 'utf8');

    const config = await loadConfig(path.join(root, 'flowctl.config.yaml'));
    const snapshot = await snapshotSources(config);
    const realRoot = await fs.realpath(root);
    const realSourcePaths = await Promise.all(
      snapshot.files.map((file) => fs.realpath(file.absolutePath)),
    );

    expect(snapshot.files.map((file) => file.relativePath)).toEqual(['inside.ts']);
    expect(realSourcePaths.every((sourcePath) => sourcePath.startsWith(`${realRoot}${path.sep}`))).toBe(true);
  });

  it('never ingests generated output even when the project root is a source root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-source-output-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'inside.ts'), 'export const inside = true;', 'utf8');
    await fs.writeFile(path.join(root, 'flowctl.config.yaml'), `
version: 1
project: { name: output-boundary, root: . }
sources:
  frontend: [.]
  backend: []
  include: ["**/*.ts"]
  exclude: []
graphify: { graph: graphify.json, required: false }
wiki: { paths: [], required: false }
analysis: { entryRoutes: [], includeHttpMethods: [POST], transparentComponents: [], maxPathDepth: 10, maxStateVisits: 1 }
output: { directory: generated-artifacts }
runtime: { environment: local }
`, 'utf8');

    const config = await loadConfig(path.join(root, 'flowctl.config.yaml'));
    const before = await snapshotSources(config);
    await fs.mkdir(path.join(config.outputRoot, 'generated', 'steps'), { recursive: true });
    await fs.writeFile(
      path.join(config.outputRoot, 'generated', 'steps', 'flowctl.steps.generated.ts'),
      'export const generatedStep = true;',
      'utf8',
    );
    const after = await snapshotSources(config);

    expect(after.digest).toBe(before.digest);
    expect(after.files.map((file) => file.relativePath)).toEqual(['inside.ts']);
  });

  it('treats glob metacharacters in literal output and source directory names as path text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-source-literal-paths-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'front[end]*?'), { recursive: true });
    await fs.writeFile(path.join(root, 'front[end]*?', 'inside.ts'), 'export const inside = true;', 'utf8');
    await fs.writeFile(path.join(root, 'flowctl.config.yaml'), `
version: 1
project: { name: literal-paths, root: . }
sources:
  frontend: ["front[end]*?"]
  backend: []
  include: ["**/*.ts"]
  exclude: []
graphify: { graph: graphify.json, required: false }
wiki: { paths: [], required: false }
analysis: { entryRoutes: [], includeHttpMethods: [POST], transparentComponents: [], maxPathDepth: 10, maxStateVisits: 1 }
output: { directory: "generated[artifacts]*?" }
runtime: { environment: local }
`, 'utf8');

    const config = await loadConfig(path.join(root, 'flowctl.config.yaml'));
    const before = await snapshotSources(config);
    await fs.mkdir(path.join(config.outputRoot, 'generated'), { recursive: true });
    await fs.writeFile(
      path.join(config.outputRoot, 'generated', 'must-not-be-source.ts'),
      'export const generated = true;',
      'utf8',
    );
    const after = await snapshotSources(config);

    expect(before.files.map((file) => file.relativePath)).toEqual(['front[end]*?/inside.ts']);
    expect(after.files.map((file) => file.relativePath)).toEqual(['front[end]*?/inside.ts']);
    expect(after.digest).toBe(before.digest);
  });

  it('rejects Graphify and Wiki auxiliary evidence roots inside compiler output', async () => {
    for (const candidate of [{
      name: 'graphify-inside-output',
      graphify: '.flowctl/graph.json',
      wiki: '[]',
      error: /Graphify graph cannot resolve inside output\.directory/i,
    }, {
      name: 'wiki-inside-output',
      graphify: 'graphify.json',
      wiki: '[.flowctl]',
      error: /Wiki evidence root cannot resolve inside output\.directory/i,
    }]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `flowctl-${candidate.name}-`));
      roots.push(root);
      const configPath = path.join(root, 'flowctl.config.yaml');
      await fs.writeFile(configPath, `
version: 1
project: { name: ${candidate.name}, root: . }
sources: { frontend: [], backend: [], include: ["**/*.ts"], exclude: [] }
graphify: { graph: ${candidate.graphify}, required: false }
wiki: { paths: ${candidate.wiki}, required: false }
analysis: { entryRoutes: [], includeHttpMethods: [POST], transparentComponents: [], maxPathDepth: 10, maxStateVisits: 1 }
output: { directory: .flowctl }
runtime: { environment: local }
`, 'utf8');

      const config = await loadConfig(configPath);
      await expect(snapshotSources(config)).rejects.toThrow(candidate.error);
    }
  });

  it('excludes compiler output when a Wiki evidence root is its ancestor', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-wiki-output-boundary-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'knowledge.md'), '# Application knowledge', 'utf8');
    const configPath = path.join(root, 'flowctl.config.yaml');
    await fs.writeFile(configPath, `
version: 1
project: { name: wiki-output-boundary, root: . }
sources: { frontend: [], backend: [], include: ["**/*.ts"], exclude: [] }
graphify: { graph: graphify.json, required: false }
wiki: { paths: [.], required: false }
analysis: { entryRoutes: [], includeHttpMethods: [POST], transparentComponents: [], maxPathDepth: 10, maxStateVisits: 1 }
output: { directory: .flowctl }
runtime: { environment: local }
`, 'utf8');

    const config = await loadConfig(configPath);
    const before = await snapshotSources(config);
    await fs.mkdir(path.join(config.outputRoot, 'generated', 'review'), { recursive: true });
    await fs.writeFile(path.join(config.outputRoot, 'generated', 'review', 'journey.feature.txt'), 'generated review', 'utf8');
    const after = await snapshotSources(config);

    expect(after.digest).toBe(before.digest);
  });

  it('rejects an output directory that overlaps the application root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-output-overlap-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'flowctl.config.yaml'), `
version: 1
project: { name: unsafe-output, root: . }
sources: { frontend: [], backend: [], include: ["**/*.ts"], exclude: [] }
graphify: { graph: graphify.json, required: false }
wiki: { paths: [], required: false }
analysis: { entryRoutes: [], includeHttpMethods: [POST], transparentComponents: [], maxPathDepth: 10, maxStateVisits: 1 }
output: { directory: . }
runtime: { environment: local }
`, 'utf8');

    await expect(loadConfig(path.join(root, 'flowctl.config.yaml'))).rejects.toThrow(/dedicated subdirectory/i);
  });

  it('keeps doctor existence checks inside the configured project root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-doctor-boundary-'));
    roots.push(root);
    const projectRoot = path.join(root, 'project');
    await fs.mkdir(projectRoot);
    await fs.mkdir(path.join(root, 'outside'));
    const configPath = path.join(projectRoot, 'flowctl.config.yaml');
    await fs.writeFile(configPath, `
version: 1
project: { name: doctor-boundary, root: . }
sources: { frontend: [../outside], backend: [], include: ["**/*.ts"], exclude: [] }
graphify: { graph: graphify.json, required: false }
wiki: { paths: [], required: false }
analysis: { entryRoutes: [], includeHttpMethods: [POST], transparentComponents: [], maxPathDepth: 10, maxStateVisits: 1 }
output: { directory: .flowctl }
runtime: { environment: local }
`, 'utf8');

    const result = spawnSync(process.execPath, [
      '--import', 'tsx', path.resolve('src/cli.ts'),
      'doctor', '--config', configPath, '--json',
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    const envelope = JSON.parse(result.stdout) as {
      result: { ready: boolean; checks: Array<{ check: string; status: string; configKeys: string[]; paths: string[] }> };
    };

    expect(result.status).toBe(2);
    expect(envelope.result.ready).toBe(false);
    expect(envelope.result.checks).toContainEqual(expect.objectContaining({
      check: 'frontend:../outside',
      status: 'error',
      detail: 'source root is missing, invalid or outside the project root',
      configKeys: ['sources.frontend'],
    }));
  });
});
