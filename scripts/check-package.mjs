#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tempRoot = mkdtempSync(path.join(tmpdir(), 'flowctl-package-'));
const archiveDirectory = path.join(tempRoot, 'archive');
const installDirectory = path.join(tempRoot, 'install');

try {
  mkdirSync(archiveDirectory, { recursive: true });
  mkdirSync(installDirectory, { recursive: true });

  const packOutput = execFileSync(
    npm,
    ['pack', '--pack-destination', archiveDirectory, '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const [packResult] = JSON.parse(packOutput);
  if (!packResult?.filename || !Array.isArray(packResult.files)) {
    throw new Error('npm pack did not return a valid package manifest.');
  }

  const packagedPaths = new Set(packResult.files.map((entry) => entry.path));
  const requiredPaths = [
    'dist/src/cli.js',
    '.agents/skills/agentic-bdd/SKILL.md',
    'flowctl.config.example.yaml',
    'package.json',
    'README.md',
  ];
  const missingPaths = requiredPaths.filter((entry) => !packagedPaths.has(entry));
  if (missingPaths.length > 0) {
    throw new Error(`Release archive is missing: ${missingPaths.join(', ')}`);
  }

  const forbiddenPaths = [...packagedPaths].filter(
    (entry) => entry.startsWith('dist/test/') || entry.startsWith('test/') || entry.startsWith('.github/'),
  );
  if (forbiddenPaths.length > 0) {
    throw new Error(`Release archive contains development-only files: ${forbiddenPaths.join(', ')}`);
  }

  writeFileSync(
    path.join(installDirectory, 'package.json'),
    JSON.stringify({ name: 'flowctl-package-smoke', private: true }, null, 2),
  );
  const archivePath = path.join(archiveDirectory, packResult.filename);
  execFileSync(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', archivePath],
    { cwd: installDirectory, stdio: 'inherit' },
  );

  const installedPackage = JSON.parse(
    readFileSync(path.join(installDirectory, 'node_modules', 'agentic-bdd-flowctl', 'package.json'), 'utf8'),
  );
  const cliPath = path.join(
    installDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'flowctl.cmd' : 'flowctl',
  );
  execFileSync(cliPath, ['--help'], { stdio: 'inherit' });
  const cliVersion = execFileSync(cliPath, ['--version'], { encoding: 'utf8' }).trim();
  if (cliVersion !== installedPackage.version) {
    throw new Error(`CLI version ${cliVersion} does not match package version ${installedPackage.version}.`);
  }

  console.log(`Verified ${installedPackage.name}@${installedPackage.version} from ${packResult.filename}.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
