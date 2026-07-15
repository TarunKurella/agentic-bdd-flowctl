import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { FlowctlConfig } from '../core/config.js';
import { safeRealDescendantPath } from '../core/paths.js';
import { ArtifactStore } from '../core/artifact-store.js';
import { loadAdapterManifest } from '../runtime/adapters.js';

export type DoctorStatus = 'ok' | 'warning' | 'error';

export interface DoctorCheck {
  check: string;
  status: DoctorStatus;
  detail: string;
  configKeys: string[];
  paths: string[];
  fix?: string;
}

export interface DoctorResult {
  ready: boolean;
  summary: { ok: number; warnings: number; errors: number };
  checks: DoctorCheck[];
  paths: {
    config: string;
    projectRoot: string;
    outputRoot: string;
    applicationData: string;
    coverageReport: string;
    unresolvedDataRequirements: string;
    runs: string;
  };
}

export async function inspectProjectHealth(config: FlowctlConfig): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  checks.push({
    check: 'node',
    status: Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'error',
    detail: process.versions.node,
    configKeys: [],
    paths: [],
    ...(Number(process.versions.node.split('.')[0]) >= 20 ? {} : { fix: 'Install Node.js 20 or newer.' }),
  });
  for (const [kind, roots, configKey] of [
    ['frontend', config.sources.frontend, 'sources.frontend'],
    ['backend', config.sources.backend, 'sources.backend'],
  ] as const) {
    for (const root of roots) {
      const configuredPath = path.resolve(config.projectRoot, root);
      try {
        const resolved = await safeRealDescendantPath(config.projectRoot, root, `${kind} source root`);
        await fs.access(resolved);
        checks.push({ check: `${kind}:${root}`, status: 'ok', detail: 'source root exists', configKeys: [configKey], paths: [resolved] });
      } catch {
        checks.push({
          check: `${kind}:${root}`,
          status: 'error',
          detail: 'source root is missing, invalid or outside the project root',
          configKeys: [configKey],
          paths: [configuredPath],
          fix: `Correct ${configKey} in ${config.configPath}.`,
        });
      }
    }
  }
  const graphifyPath = path.resolve(config.projectRoot, config.graphify.graph);
  try {
    const resolved = await safeRealDescendantPath(config.projectRoot, config.graphify.graph, 'Graphify graph');
    await fs.access(resolved);
    checks.push({ check: 'graphify', status: 'ok', detail: config.graphify.graph, configKeys: ['graphify.graph'], paths: [resolved] });
  } catch {
    checks.push({
      check: 'graphify',
      status: config.graphify.required ? 'error' : 'warning',
      detail: 'graph is missing, invalid or outside the project root',
      configKeys: ['graphify.graph', 'graphify.required'],
      paths: [graphifyPath],
      fix: config.graphify.required
        ? `Generate the Graphify file or correct graphify.graph in ${config.configPath}.`
        : 'Static discovery can continue; configure graphify.graph only when auxiliary graph evidence is available.',
    });
  }
  for (const wikiPath of config.wiki.paths) {
    const configuredPath = path.resolve(config.projectRoot, wikiPath);
    try {
      const resolved = await safeRealDescendantPath(config.projectRoot, wikiPath, 'Wiki evidence root');
      await fs.access(resolved);
      checks.push({ check: `wiki:${wikiPath}`, status: 'ok', detail: 'Wiki evidence root exists', configKeys: ['wiki.paths'], paths: [resolved] });
    } catch {
      checks.push({
        check: `wiki:${wikiPath}`,
        status: config.wiki.required ? 'error' : 'warning',
        detail: 'Wiki evidence root is missing, invalid or outside the project root',
        configKeys: ['wiki.paths', 'wiki.required'],
        paths: [configuredPath],
        fix: config.wiki.required
          ? `Generate the Wiki evidence or correct wiki.paths in ${config.configPath}.`
          : 'Static discovery can continue; remove or correct the optional wiki.paths entry.',
      });
    }
  }
  checks.push({
    check: 'runtime:base-url',
    status: config.runtime.baseUrl ? 'ok' : 'warning',
    detail: config.runtime.baseUrl ?? 'not configured; static discovery works, runtime grounding is blocked',
    configKeys: ['runtime.baseUrl', 'runtime.environment'],
    paths: [config.configPath],
    ...(!config.runtime.baseUrl ? { fix: `Set runtime.baseUrl for ${config.runtime.environment} in ${config.configPath}.` } : {}),
  });
  if (config.runtime.runner) {
    const available = await executableAvailable(config.runtime.runner.command, config.projectRoot);
    checks.push({
      check: 'runtime:runner',
      status: available ? 'ok' : 'warning',
      detail: `${config.runtime.runner.command} · argv/shell-disabled · manifest=${config.runtime.runner.args.some((argument) => argument.includes('{manifest}')) ? 'yes' : 'no'} · observation=${config.runtime.runner.args.some((argument) => argument.includes('{observation}')) ? 'yes' : 'no'} · timeout=${config.runtime.runner.timeoutMs}ms${available ? '' : ' · command not found or not executable'}`,
      configKeys: ['runtime.runner.command', 'runtime.runner.args', 'runtime.runner.timeoutMs', 'runtime.runner.envAllowlist'],
      paths: [config.configPath],
      ...(!available ? { fix: 'An authorized human must configure an executable approved runner; run flowctl ground runner plan.' } : {}),
    });
  } else {
    checks.push({
      check: 'runtime:runner',
      status: 'warning',
      detail: 'not configured; runtime grounding requires a human-approved runner',
      configKeys: ['runtime.runner.command', 'runtime.runner.args', 'runtime.runner.timeoutMs', 'runtime.runner.envAllowlist'],
      paths: [config.configPath],
      fix: 'An authorized human must review flowctl ground runner plan and configure runtime.runner.',
    });
  }
  try {
    const adapters = await loadAdapterManifest(new ArtifactStore(config));
    checks.push({
      check: 'runtime:adapter-manifest',
      status: 'ok',
      detail: `${config.runtime.adapterManifest} · ${adapters.manifest.adapters.length} statically implemented adapter(s)`,
      configKeys: ['runtime.adapterManifest'],
      paths: config.runtime.adapterManifest ? [path.resolve(config.projectRoot, config.runtime.adapterManifest)] : [],
    });
  } catch (error) {
    checks.push({
      check: 'runtime:adapter-manifest',
      status: 'warning',
      detail: error instanceof Error ? error.message : String(error),
      configKeys: ['runtime.adapterManifest'],
      paths: config.runtime.adapterManifest ? [path.resolve(config.projectRoot, config.runtime.adapterManifest)] : [],
      fix: 'After selecting a variant, run flowctl ground adapters plan --variant <variant-id>, implement the scaffold, and configure runtime.adapterManifest.',
    });
  }
  const summary = {
    ok: checks.filter((check) => check.status === 'ok').length,
    warnings: checks.filter((check) => check.status === 'warning').length,
    errors: checks.filter((check) => check.status === 'error').length,
  };
  return {
    ready: summary.errors === 0,
    summary,
    checks,
    paths: {
      config: config.configPath,
      projectRoot: config.projectRoot,
      outputRoot: config.outputRoot,
      applicationData: config.applicationDataPath,
      coverageReport: path.join(config.outputRoot, 'artifacts', 'coverage.json'),
      unresolvedDataRequirements: path.join(config.outputRoot, 'artifacts', 'data-requirements'),
      runs: path.join(config.outputRoot, 'runs'),
    },
  };
}

export function renderDoctor(result: DoctorResult): string {
  const lines = [
    `FLOWCTL DOCTOR · ${result.ready ? 'STATIC DISCOVERY READY' : 'CONFIGURATION BLOCKED'}`,
    '',
    `${result.summary.ok} ok · ${result.summary.warnings} warnings · ${result.summary.errors} errors`,
  ];
  for (const check of result.checks) {
    lines.push('', `${check.status === 'ok' ? '✓' : check.status === 'warning' ? '!' : '✗'} ${check.check}: ${check.detail}`);
    if (check.configKeys.length) lines.push(`  Config: ${check.configKeys.join(', ')}`);
    if (check.paths.length) lines.push(`  Path: ${check.paths.join(', ')}`);
    if (check.fix && check.status !== 'ok') lines.push(`  Fix: ${check.fix}`);
  }
  lines.push('', 'OUTPUTS', `Coverage: ${result.paths.coverageReport}`, `Data requirements: ${result.paths.unresolvedDataRequirements}`, `Runs: ${result.paths.runs}`);
  return lines.join('\n');
}

async function executableAvailable(command: string, cwd: string): Promise<boolean> {
  const hasSeparator = command.includes('/') || command.includes('\\');
  const candidates = hasSeparator
    ? [path.isAbsolute(command) ? command : path.resolve(cwd, command)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap((directory) => {
      if (process.platform !== 'win32') return [path.join(directory, command)];
      const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
      return [path.join(directory, command), ...extensions.map((extension) => path.join(directory, `${command}${extension.toLowerCase()}`))];
    });
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}
