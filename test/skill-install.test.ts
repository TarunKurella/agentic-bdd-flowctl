import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);

describe('bundled agent skill installation', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  }, 15_000);

  it('installs the exact bundled skill and is idempotent', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-skill-'));
    const args = ['--import', 'tsx', 'src/cli.ts', 'agent', 'install-skill', '--directory', root, '--json'];
    const first = await execute(process.execPath, args, { cwd: path.resolve('.') });
    const envelope = JSON.parse(first.stdout);
    const destination = path.join(await fs.realpath(root), '.agents', 'skills', 'agentic-bdd', 'SKILL.md');
    expect(envelope).toMatchObject({ ok: true, result: { skill: 'agentic-bdd', destination } });
    expect(await fs.readFile(destination, 'utf8')).toContain('name: agentic-bdd');

    const second = await execute(process.execPath, args, { cwd: path.resolve('.') });
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: true });
  }, 15_000);

  it('refuses to overwrite different skill content', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-skill-'));
    const destination = path.join(root, '.agents', 'skills', 'agentic-bdd', 'SKILL.md');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'company-owned skill\n');

    await expect(execute(process.execPath, [
      '--import', 'tsx', 'src/cli.ts', 'agent', 'install-skill', '--directory', root,
    ], { cwd: path.resolve('.') })).rejects.toMatchObject({
      stderr: expect.stringMatching(/review or remove it explicitly/i),
    });
    expect(await fs.readFile(destination, 'utf8')).toBe('company-owned skill\n');
  }, 15_000);

  it('refuses a symlinked skill directory', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowctl-skill-'));
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.mkdir(path.join(root, '.agents'));
    await fs.symlink(outside, path.join(root, '.agents', 'skills'));

    await expect(execute(process.execPath, [
      '--import', 'tsx', 'src/cli.ts', 'agent', 'install-skill', '--directory', root,
    ], { cwd: path.resolve('.') })).rejects.toMatchObject({
      stderr: expect.stringMatching(/non-directory path/i),
    });
    await expect(fs.access(path.join(outside, 'agentic-bdd', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);
});
