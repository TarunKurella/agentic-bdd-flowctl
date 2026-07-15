import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);

describe('flowctl init path safety', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a dangling configuration symlink without creating its target', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-init-security-'));
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside-config.yaml');
    await fs.mkdir(project);
    await fs.symlink(outside, path.join(project, 'flowctl.config.yaml'));

    await expect(execute(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'init',
      '--directory',
      project,
    ], { cwd: path.resolve('.') })).rejects.toMatchObject({
      stderr: expect.stringMatching(/refusing to initialize through symbolic link/i),
    });
    await expect(fs.access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.lstat(path.join(project, 'flowctl.config.yaml'))).isSymbolicLink()).toBe(true);
  });
});
