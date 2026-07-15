import { spawn } from 'node:child_process';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { ArtifactStore } from '../core/artifact-store.js';
import { safeChildPath, safeFileSegment } from '../core/paths.js';
import { recordGrounding, verifyGroundingManifest } from './grounding.js';

const DEFAULT_RUNNER_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OBSERVATION_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 8 * 1024;
const MINIMAL_RUNNER_ENVIRONMENT = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
] as const;

export interface GroundingRunnerPlan {
  configPath: string;
  scaffoldPath: string;
  configTemplate: {
    runtime: {
      runner: {
        command: string;
        args: string[];
        timeoutMs: number;
        envAllowlist: string[];
      };
    };
  };
  protocol: string[];
  next: string;
}

export async function planGroundingRunner(store: ArtifactStore): Promise<GroundingRunnerPlan> {
  const configTemplate = {
    runtime: {
      runner: {
        command: '<approved-corporate-playwright-runner>',
        args: ['--manifest', '{manifest}', '--observation', '{observation}'],
        timeoutMs: DEFAULT_RUNNER_TIMEOUT_MS,
        envAllowlist: [],
      },
    },
  };
  const directory = path.join(store.workDirectory, 'runtime');
  const scaffoldPath = safeChildPath(directory, 'runner-config.example.yaml');
  await store.writeManagedFile(scaffoldPath, stringifyYaml(configTemplate, { lineWidth: 0 }));
  return {
    configPath: store.config.configPath,
    scaffoldPath,
    configTemplate,
    protocol: [
      'Flowctl substitutes absolute paths for {manifest} and {observation} in the configured argv array.',
      'Flowctl launches command + args directly with shell disabled and the project root as cwd.',
      'The runner inherits only minimal OS/runtime variables plus names explicitly approved in runtime.runner.envAllowlist; application-specific values belong in the application-data handoff, not process environment variables.',
      'The runner must re-read the verified manifest, invoke its registered adapters in exact step order and write one complete runtime-observation-v1 JSON file.',
      'The runner resolves actor/field values in memory from manifest handoffs and must never write resolved values, credentials or raw secrets to the observation.',
      'The runner must not print resolved values or secrets; Flowctl may return a bounded stderr tail when the process fails.',
      'A non-zero exit, timeout, missing/symlink/non-regular/oversized observation or schema/digest mismatch fails without recording runtime bindings.',
    ],
    next: 'After configuring runtime.runner, prepare or resume a grounding manifest and run `flowctl ground run --run <run-id>`.',
  };
}

export function renderGroundingRunnerPlan(plan: GroundingRunnerPlan): string {
  return [
    'FLOWCTL EXTERNAL RUNNER PROTOCOL',
    '',
    `Configuration ${plan.configPath}`,
    `Scaffold      ${plan.scaffoldPath}`,
    '',
    stringifyYaml(plan.configTemplate, { lineWidth: 0 }).trim(),
    '',
    'PROTOCOL',
    ...plan.protocol.map((rule) => `- ${rule}`),
    '',
    plan.next,
  ].join('\n');
}

export async function runGrounding(store: ArtifactStore, runId: string): Promise<{
  runId: string;
  variantId: string;
  environment: string;
  observationPath: string;
  recordedBindings: number;
}> {
  const runner = store.config.runtime.runner;
  if (!runner) {
    throw new Error('Runtime grounding requires runtime.runner { command, args } in flowctl.config.yaml. Run flowctl ground runner plan for the no-shell protocol and scaffold.');
  }
  const manifest = await verifyGroundingManifest(store, runId);
  const directory = path.join(store.workDirectory, 'runtime');
  const safeRunId = safeFileSegment(runId, 'Run ID');
  const manifestPath = safeChildPath(directory, `${safeRunId}.manifest.json`);
  const observationPath = safeChildPath(directory, `${safeRunId}.observation.json`);
  await store.removeManagedFile(observationPath);
  const args = runner.args.map((argument) => argument
    .replaceAll('{manifest}', manifestPath)
    .replaceAll('{observation}', observationPath));
  await launchRunner({
    command: runner.command,
    args,
    cwd: store.config.projectRoot,
    timeoutMs: runner.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS,
    env: buildRunnerEnvironment(runner.envAllowlist),
  });
  const stat = await store.inspectManagedEntry(observationPath);
  if (!stat) throw new Error(`Grounding runner exited successfully but did not write ${observationPath}.`);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    await store.removeManagedFile(observationPath);
    throw new Error('Grounding runner observation must be a regular file inside the Flowctl runtime work directory.');
  }
  if (stat.size > MAX_OBSERVATION_BYTES) {
    await store.removeManagedFile(observationPath);
    throw new Error(`Grounding runner observation exceeds ${MAX_OBSERVATION_BYTES} bytes.`);
  }
  try {
    const recorded = await recordGrounding(store, runId, observationPath);
    return {
      runId,
      variantId: manifest.variantId,
      environment: manifest.environment,
      observationPath,
      recordedBindings: recorded.bindings.length,
    };
  } catch (error) {
    await store.removeManagedFile(observationPath);
    throw new Error(`Grounding runner observation was rejected and removed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function launchRunner(options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail += chunk.toString();
      const bytes = Buffer.byteLength(stderrTail);
      if (bytes > MAX_STDERR_TAIL_BYTES) {
        stderrTail = Buffer.from(stderrTail).subarray(bytes - MAX_STDERR_TAIL_BYTES).toString();
      }
    });
    const runnerError = (message: string) => new Error(`${message}${stderrTail.trim() ? `\nRunner stderr tail:\n${stderrTail.trim()}` : ''}`);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
      force.unref();
      finish(runnerError(`Grounding runner exceeded ${options.timeoutMs} ms and was terminated.`));
    }, options.timeoutMs);
    timeout.unref();
    child.once('error', (error) => finish(runnerError(`Cannot launch grounding runner ${options.command}: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0) finish();
      else finish(runnerError(`Grounding runner exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`));
    });
  });
}

/**
 * Builds the complete environment visible to an external grounding runner.
 * Application data is deliberately excluded: it travels through verified
 * manifest handoffs and the ignored application-data file instead.
 */
export function buildRunnerEnvironment(
  allowlist: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const permitted = new Set(
    [...MINIMAL_RUNNER_ENVIRONMENT, ...allowlist].map((name) => name.toLowerCase()),
  );
  return Object.fromEntries(
    Object.entries(source).filter(([name, value]) => (
      value !== undefined && permitted.has(name.toLowerCase())
    )),
  );
}
