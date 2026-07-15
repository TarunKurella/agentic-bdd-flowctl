import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { loadConfig } from '../src/core/config.js';
import { sha256, stableJson } from '../src/core/stable.js';
import type { FlowVariants } from '../src/ir/model.js';

describe('canonical artifact integrity', () => {
  let root: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-artifact-integrity-'));
    const config = await loadConfig(path.resolve('examples/account-opening/flowctl.config.yaml'));
    store = new ArtifactStore({ ...config, outputRoot: path.join(root, '.flowctl') });
    await store.initialize();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects canonical data changed without a matching content digest', async () => {
    const envelope = store.createEnvelope<FlowVariants>({
      artifactType: 'flow-variants',
      producer: 'variants:reduce',
      sourceDigest: 'sha256:test',
      data: { variants: [] },
    });
    await store.write('variants', envelope);
    const file = store.artifactPath('variants');
    const tampered = JSON.parse(await fs.readFile(file, 'utf8')) as typeof envelope;
    tampered.data.variants.push({ id: 'tampered' } as FlowVariants['variants'][number]);
    await fs.writeFile(file, JSON.stringify(tampered), 'utf8');

    await expect(store.read<FlowVariants>('variants')).rejects.toThrow(/content digest does not match/i);
  });

  it('rejects metadata changed after the envelope consistency digest was written', async () => {
    const envelope = store.createEnvelope<FlowVariants>({
      artifactType: 'flow-variants',
      producer: 'variants:reduce',
      sourceDigest: 'sha256:original-source',
      data: { variants: [] },
    });
    await store.write('variants', envelope);
    const file = store.artifactPath('variants');
    const tampered = JSON.parse(await fs.readFile(file, 'utf8')) as typeof envelope;
    tampered.meta.sourceDigest = 'sha256:different-source';
    await fs.writeFile(file, JSON.stringify(tampered), 'utf8');

    await expect(store.read<FlowVariants>('variants')).rejects.toThrow(/envelope digest does not match/i);
  });

  it('rejects data changed with only the inner content digest recomputed', async () => {
    const envelope = store.createEnvelope<FlowVariants>({
      artifactType: 'flow-variants',
      producer: 'variants:reduce',
      sourceDigest: 'sha256:original-source',
      data: { variants: [] },
    });
    await store.write('variants', envelope);
    const file = store.artifactPath('variants');
    const tampered = JSON.parse(await fs.readFile(file, 'utf8')) as typeof envelope;
    tampered.data.variants.push({ id: 'rewritten' } as FlowVariants['variants'][number]);
    tampered.meta.contentDigest = sha256(stableJson(tampered.data));
    await fs.writeFile(file, JSON.stringify(tampered), 'utf8');

    await expect(store.read<FlowVariants>('variants')).rejects.toThrow(/envelope digest does not match/i);
  });

  it('rejects a current-producer envelope when its required envelope digest is removed', async () => {
    const envelope = store.createEnvelope<FlowVariants>({
      artifactType: 'flow-variants',
      producer: 'variants:reduce',
      sourceDigest: 'sha256:current-source',
      data: { variants: [] },
    });
    delete envelope.meta.envelopeDigest;
    await fs.writeFile(store.artifactPath('variants'), stableJson(envelope), 'utf8');

    await expect(store.read<FlowVariants>('variants')).rejects.toThrow(/missing its required envelope digest/i);
  });

  it('rejects a symlinked artifact directory without writing outside the output root', async () => {
    const outside = path.join(root, 'outside-artifacts');
    await fs.mkdir(outside);
    await fs.rm(store.artifactDirectory, { recursive: true });
    await fs.symlink(outside, store.artifactDirectory, 'dir');
    const envelope = store.createEnvelope<FlowVariants>({
      artifactType: 'flow-variants',
      producer: 'variants:reduce',
      sourceDigest: 'sha256:symlink-test',
      data: { variants: [] },
    });

    await expect(store.write('variants', envelope)).rejects.toThrow(/symbolic-link component/i);
    await expect(fs.access(path.join(outside, 'flow-variants.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a final artifact symlink instead of reading its target', async () => {
    const outside = path.join(root, 'outside-artifact.json');
    await fs.writeFile(outside, '{}', 'utf8');
    await fs.symlink(outside, store.artifactPath('variants'));

    await expect(store.exists('variants')).rejects.toThrow(/through symbolic link/i);
    await expect(store.read<FlowVariants>('variants')).rejects.toThrow(/through symbolic link/i);
  });

  it('rejects symlinked generated and runtime parents before writes or removals escape', async () => {
    const generatedOutside = path.join(root, 'outside-generated');
    const runtimeOutside = path.join(root, 'outside-runtime');
    await fs.mkdir(generatedOutside);
    await fs.mkdir(runtimeOutside);
    await fs.rm(store.generatedDirectory, { recursive: true });
    await fs.symlink(generatedOutside, store.generatedDirectory, 'dir');
    const runtimeDirectory = path.join(store.workDirectory, 'runtime');
    await fs.rm(runtimeDirectory, { recursive: true });
    await fs.symlink(runtimeOutside, runtimeDirectory, 'dir');
    const outsideObservation = path.join(runtimeOutside, 'run.observation.json');
    await fs.writeFile(outsideObservation, 'outside-sentinel', 'utf8');

    await expect(store.writeManagedFile(path.join(store.generatedDirectory, 'step-plan.json'), '{}'))
      .rejects.toThrow(/symbolic-link component/i);
    await expect(store.listManagedDirectory(runtimeDirectory))
      .rejects.toThrow(/symbolic-link component/i);
    await expect(store.removeManagedFile(path.join(runtimeDirectory, 'run.observation.json')))
      .rejects.toThrow(/symbolic-link component/i);
    await expect(fs.readFile(outsideObservation, 'utf8')).resolves.toBe('outside-sentinel');
    await expect(fs.access(path.join(generatedOutside, 'step-plan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a final application-data symlink and writes regular application data as owner-only', async () => {
    const outputRoot = path.join(root, 'data-output');
    const applicationDataFile = path.join(outputRoot, 'application-data.local.yaml');
    const dataStore = new ArtifactStore(
      { ...store.config, outputRoot },
      { applicationDataFile },
    );
    await dataStore.initialize();
    const outside = path.join(root, 'outside-application-data.yaml');
    await fs.writeFile(outside, 'outside-sentinel', 'utf8');
    await fs.symlink(outside, applicationDataFile);

    await expect(dataStore.writeManagedFile(applicationDataFile, 'version: 1\n'))
      .rejects.toThrow(/through symbolic link/i);
    await expect(dataStore.readManagedFile(applicationDataFile))
      .rejects.toThrow(/through symbolic link/i);
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('outside-sentinel');

    await fs.unlink(applicationDataFile);
    await dataStore.writeManagedFile(applicationDataFile, 'version: 1\n');
    await fs.chmod(applicationDataFile, 0o644);
    await dataStore.writeManagedFile(applicationDataFile, 'version: 1\napplication: rewritten\n');
    const mode = (await fs.stat(applicationDataFile)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does not use the old predictable artifact staging name', async () => {
    const outside = path.join(root, 'outside-staging-target');
    await fs.writeFile(outside, 'outside-sentinel', 'utf8');
    const legacyStaging = path.join(store.workDirectory, 'flow-variants.json.staging');
    await fs.symlink(outside, legacyStaging);
    const envelope = store.createEnvelope<FlowVariants>({
      artifactType: 'flow-variants',
      producer: 'variants:reduce',
      sourceDigest: 'sha256:exclusive-temp-test',
      data: { variants: [] },
    });

    await store.write('variants', envelope);

    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('outside-sentinel');
    expect((await fs.lstat(legacyStaging)).isSymbolicLink()).toBe(true);
    await expect(store.read<FlowVariants>('variants')).resolves.toMatchObject({ data: { variants: [] } });
  });
});
