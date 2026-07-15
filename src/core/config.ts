import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EXIT_CODE, FlowctlError } from './errors.js';
import { sha256, stableJson } from './stable.js';
import { safeDescendantPath, safeRealDescendantPath } from './paths.js';

const RuntimeRunnerSchema = z.object({
  command: z.string().trim().min(1)
    .refine((value) => !/[\0\r\n]/.test(value), 'Runner command cannot contain control characters.')
    .refine((value) => !/[{}]/.test(value), 'Runner placeholders are allowed only in args.'),
  args: z.array(z.string().refine((value) => !/[\0\r\n]/.test(value), 'Runner arguments cannot contain control characters.')).min(2),
  timeoutMs: z.number().int().min(1_000).max(60 * 60 * 1_000).default(15 * 60 * 1_000),
  envAllowlist: z.array(z.string().regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Runner environment names must be portable variable identifiers.',
  )).default([]).refine(
    (names) => new Set(names.map((name) => name.toLowerCase())).size === names.length,
    'Runner environment names must be unique (case-insensitive).',
  ),
}).strict().superRefine((runner, context) => {
  const joined = runner.args.join('\n');
  for (const placeholder of ['{manifest}', '{observation}']) {
    if (!joined.includes(placeholder)) {
      context.addIssue({ code: 'custom', path: ['args'], message: `Runner args must include ${placeholder}.` });
    }
  }
  const unknown = [...joined.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => `{${match[1]}}`)
    .filter((placeholder) => placeholder !== '{manifest}' && placeholder !== '{observation}');
  if (unknown.length) {
    context.addIssue({ code: 'custom', path: ['args'], message: `Unknown runner placeholder(s): ${[...new Set(unknown)].join(', ')}.` });
  }
});

const ConfigSchema = z.object({
  version: z.number().int().default(1),
  project: z.object({
    name: z.string().min(1),
    root: z.string().default('.'),
  }),
  sources: z.object({
    frontend: z.array(z.string()).default([]),
    backend: z.array(z.string()).default([]),
    include: z.array(z.string()).default(['**/*.ts', '**/*.tsx', '**/*.java']),
    exclude: z.array(z.string()).default([
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/target/**',
    ]),
  }),
  graphify: z.object({
    graph: z.string().default('graphify-out/graph.json'),
    required: z.boolean().default(false),
  }).default({ graph: 'graphify-out/graph.json', required: false }),
  wiki: z.object({
    paths: z.array(z.string()).default([]),
    required: z.boolean().default(false),
  }).default({ paths: [], required: false }),
  analysis: z.object({
    entryRoutes: z.array(z.string()).default(['/']),
    includeHttpMethods: z.array(z.string()).default(['POST', 'PUT', 'PATCH', 'DELETE']),
    transparentComponents: z.array(z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$.]*$/)).default([]),
    maxPathDepth: z.number().int().positive().default(40),
    maxStateVisits: z.number().int().positive().default(2),
  }).default({
    entryRoutes: ['/'],
    includeHttpMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    transparentComponents: [],
    maxPathDepth: 40,
    maxStateVisits: 2,
  }),
  output: z.object({
    directory: z.string().default('.flowctl'),
  }).default({ directory: '.flowctl' }),
  data: z.object({
    applicationDataFile: z.literal('.flowctl/application-data.local.yaml').default('.flowctl/application-data.local.yaml'),
    secretReferenceSchemes: z.array(z.string().regex(/^[a-z][a-z0-9+.-]*$/)).min(1).default([
      'secret',
      'vault',
      'aws-secretsmanager',
      'azure-keyvault',
      'gcp-secretmanager',
    ]),
    allowAwsSecretsManagerArns: z.boolean().default(true),
  }).default({
    applicationDataFile: '.flowctl/application-data.local.yaml',
    secretReferenceSchemes: ['secret', 'vault', 'aws-secretsmanager', 'azure-keyvault', 'gcp-secretmanager'],
    allowAwsSecretsManagerArns: true,
  }),
  runtime: z.object({
    baseUrl: z.string().url().optional(),
    environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).default('local'),
    adapterManifest: z.string().optional(),
    runner: RuntimeRunnerSchema.optional(),
  }).default({ environment: 'local' }),
});

export type FlowctlConfig = z.infer<typeof ConfigSchema> & {
  configPath: string;
  configDirectory: string;
  projectRoot: string;
  outputRoot: string;
  applicationDataPath: string;
  analysisConfigDigest: string;
  dataConfigDigest: string;
  runtimeConfigDigest: string;
  /** Backward-compatible alias used by canonical source artifacts. */
  configDigest: string;
};

export async function loadConfig(configFile = 'flowctl.config.yaml'): Promise<FlowctlConfig> {
  const configPath = path.resolve(configFile);
  const configDirectory = path.dirname(configPath);
  let parsed: z.infer<typeof ConfigSchema>;
  try {
    const contents = await fs.readFile(configPath, 'utf8');
    parsed = ConfigSchema.parse(parseYaml(contents));
  } catch (error) {
    throw new FlowctlError(
      'CONFIG_INVALID',
      EXIT_CODE.invalid,
      `Cannot load Flowctl configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let trustedConfigDirectory: string;
  let projectRoot: string;
  let outputRoot: string;
  let applicationDataPath: string;
  try {
    trustedConfigDirectory = await fs.realpath(configDirectory);
    projectRoot = await safeRealDescendantPath(trustedConfigDirectory, parsed.project.root, 'project.root');
    outputRoot = await safeRealDescendantPath(projectRoot, parsed.output.directory, 'output.directory');
    if (path.resolve(outputRoot) === path.resolve(projectRoot)) {
      throw new Error('output.directory must be a dedicated subdirectory so generated artifacts cannot overlap application source.');
    }
    applicationDataPath = await safeRealDescendantPath(projectRoot, parsed.data.applicationDataFile, 'data.applicationDataFile');
  } catch (error) {
    throw new FlowctlError(
      'CONFIG_PATH_OUTSIDE_TRUSTED_ROOT',
      EXIT_CODE.invalid,
      `Configuration paths must stay inside the directory containing flowctl.config.yaml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const analysisConfigDigest = sha256(stableJson({
    version: parsed.version,
    project: parsed.project,
    sources: parsed.sources,
    graphify: parsed.graphify,
    wiki: parsed.wiki,
    analysis: parsed.analysis,
  }));
  const dataConfigDigest = sha256(stableJson({ analysisConfigDigest, data: parsed.data }));
  const runtimeConfigDigest = sha256(stableJson({ analysisConfigDigest, dataConfigDigest, runtime: parsed.runtime }));
  return {
    ...parsed,
    configPath,
    configDirectory: trustedConfigDirectory,
    projectRoot,
    outputRoot,
    applicationDataPath,
    analysisConfigDigest,
    dataConfigDigest,
    runtimeConfigDigest,
    configDigest: analysisConfigDigest,
  };
}

export function resolveProjectPath(config: FlowctlConfig, value: string): string {
  return safeDescendantPath(config.projectRoot, value);
}
