import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { sha256, stableJson } from './stable.js';

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
    maxPathDepth: z.number().int().positive().default(40),
    maxStateVisits: z.number().int().positive().default(2),
  }).default({
    entryRoutes: ['/'],
    includeHttpMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    maxPathDepth: 40,
    maxStateVisits: 2,
  }),
  output: z.object({
    directory: z.string().default('.flowctl'),
  }).default({ directory: '.flowctl' }),
  runtime: z.object({
    baseUrl: z.string().optional(),
    environment: z.string().default('local'),
  }).default({ environment: 'local' }),
});

export type FlowctlConfig = z.infer<typeof ConfigSchema> & {
  configPath: string;
  configDirectory: string;
  projectRoot: string;
  outputRoot: string;
  configDigest: string;
};

export async function loadConfig(configFile = 'flowctl.config.yaml'): Promise<FlowctlConfig> {
  const configPath = path.resolve(configFile);
  const configDirectory = path.dirname(configPath);
  const contents = await fs.readFile(configPath, 'utf8');
  const parsed = ConfigSchema.parse(parseYaml(contents));
  const projectRoot = path.resolve(configDirectory, parsed.project.root);
  return {
    ...parsed,
    configPath,
    configDirectory,
    projectRoot,
    outputRoot: path.resolve(projectRoot, parsed.output.directory),
    configDigest: sha256(stableJson(parsed)),
  };
}

export function resolveProjectPath(config: FlowctlConfig, value: string): string {
  return path.resolve(config.projectRoot, value);
}
