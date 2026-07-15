import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';

describe('configuration freshness scopes', () => {
  let root: string;
  let configPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-config-digests-'));
    configPath = path.join(root, 'flowctl.config.yaml');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('changes only the runtime scope when runtime configuration changes', async () => {
    const original = await writeAndLoad(baseConfig());
    const changed = await writeAndLoad({
      ...baseConfig(),
      runtime: { environment: 'uat', baseUrl: 'https://uat.example.test' },
    });

    expect(changed.analysisConfigDigest).toBe(original.analysisConfigDigest);
    expect(changed.dataConfigDigest).toBe(original.dataConfigDigest);
    expect(changed.runtimeConfigDigest).not.toBe(original.runtimeConfigDigest);
    expect(changed.configDigest).toBe(changed.analysisConfigDigest);
  });

  it('changes data and downstream runtime scopes without staling analysis', async () => {
    const original = await writeAndLoad(baseConfig());
    const changed = await writeAndLoad({
      ...baseConfig(),
      data: {
        applicationDataFile: '.flowctl/application-data.local.yaml',
        secretReferenceSchemes: ['vault'],
        allowAwsSecretsManagerArns: false,
      },
    });

    expect(changed.analysisConfigDigest).toBe(original.analysisConfigDigest);
    expect(changed.dataConfigDigest).not.toBe(original.dataConfigDigest);
    expect(changed.runtimeConfigDigest).not.toBe(original.runtimeConfigDigest);
  });

  it('changes analysis and every downstream scope when analysis configuration changes', async () => {
    const original = await writeAndLoad(baseConfig());
    const changed = await writeAndLoad({
      ...baseConfig(),
      analysis: { entryRoutes: ['/applications'] },
    });

    expect(changed.analysisConfigDigest).not.toBe(original.analysisConfigDigest);
    expect(changed.dataConfigDigest).not.toBe(original.dataConfigDigest);
    expect(changed.runtimeConfigDigest).not.toBe(original.runtimeConfigDigest);
  });

  it('defaults runner environment approval to empty and scopes allowlist changes to runtime', async () => {
    const runner = {
      command: 'approved-grounding-runner',
      args: ['--manifest', '{manifest}', '--observation', '{observation}'],
    };
    const original = await writeAndLoad({
      ...baseConfig(),
      runtime: { environment: 'local', runner },
    });
    const changed = await writeAndLoad({
      ...baseConfig(),
      runtime: { environment: 'local', runner: { ...runner, envAllowlist: ['HTTPS_PROXY'] } },
    });

    expect(original.runtime.runner?.envAllowlist).toEqual([]);
    expect(changed.runtime.runner?.envAllowlist).toEqual(['HTTPS_PROXY']);
    expect(changed.analysisConfigDigest).toBe(original.analysisConfigDigest);
    expect(changed.dataConfigDigest).toBe(original.dataConfigDigest);
    expect(changed.runtimeConfigDigest).not.toBe(original.runtimeConfigDigest);
  });

  it('rejects malformed or case-duplicate runner environment names', async () => {
    const runner = {
      command: 'approved-grounding-runner',
      args: ['--manifest', '{manifest}', '--observation', '{observation}'],
    };
    await expect(writeAndLoad({
      ...baseConfig(),
      runtime: { environment: 'local', runner: { ...runner, envAllowlist: ['BAD-NAME'] } },
    })).rejects.toThrow(/portable variable identifiers/i);
    await expect(writeAndLoad({
      ...baseConfig(),
      runtime: { environment: 'local', runner: { ...runner, envAllowlist: ['HTTPS_PROXY', 'https_proxy'] } },
    })).rejects.toThrow(/unique \(case-insensitive\)/i);
  });

  async function writeAndLoad(config: Record<string, unknown>) {
    await fs.writeFile(configPath, stringifyYaml(config), 'utf8');
    return loadConfig(configPath);
  }
});

function baseConfig(): Record<string, unknown> {
  return {
    version: 1,
    project: { name: 'digest-test', root: '.' },
    sources: { frontend: [], backend: [] },
    runtime: { environment: 'local' },
  };
}
