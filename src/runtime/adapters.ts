import fs from 'node:fs/promises';
import { z } from 'zod';
import { Node, Project, ScriptKind, ScriptTarget } from 'ts-morph';
import type { ArtifactStore } from '../core/artifact-store.js';
import { safeDescendantPath } from '../core/paths.js';
import { sha256, stableJson } from '../core/stable.js';

const AdapterManifestSchema = z.object({
  version: z.literal(1),
  implementation: z.string().trim().min(1),
  adapters: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    targets: z.array(z.enum(['actor-session', 'screen-state', 'field', 'action'])).min(1),
    controlKinds: z.array(z.string().trim().min(1)).optional(),
  }).strict().superRefine((adapter, context) => {
    if (adapter.controlKinds?.length && !adapter.targets.includes('field')) {
      context.addIssue({ code: 'custom', path: ['controlKinds'], message: 'controlKinds are valid only for field adapters.' });
    }
  })).min(1),
}).strict();

export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

export interface LoadedAdapterManifest {
  manifest: AdapterManifest;
  digest: string;
  path: string;
  implementationPath: string;
}

export type RuntimeTargetKind = 'actor-session' | 'screen-state' | 'field' | 'action';

export async function loadAdapterManifest(store: ArtifactStore): Promise<LoadedAdapterManifest> {
  const configured = store.config.runtime.adapterManifest;
  if (!configured) {
    throw new Error('Runtime grounding requires runtime.adapterManifest in flowctl.config.yaml; Playwright CLI alone does not prove application-specific actor-session, screen-state, field and action adapters.');
  }
  const manifestPath = await safeExistingProjectPath(store.config.projectRoot, configured);
  const manifest = AdapterManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  if (new Set(manifest.adapters.map((adapter) => adapter.id)).size !== manifest.adapters.length) {
    throw new Error(`Runtime adapter manifest ${configured} contains duplicate adapter IDs.`);
  }
  const implementationPath = await safeExistingProjectPath(store.config.projectRoot, manifest.implementation);
  const implementation = await fs.readFile(implementationPath, 'utf8');
  assertImplementedAdapters(manifest, implementation, manifest.implementation);
  return {
    manifest,
    digest: sha256(stableJson({ manifest, implementationDigest: sha256(implementation) })),
    path: manifestPath,
    implementationPath,
  };
}

async function safeExistingProjectPath(projectRoot: string, relativePath: string): Promise<string> {
  const candidate = safeDescendantPath(projectRoot, relativePath);
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(projectRoot), fs.realpath(candidate)]);
  const prefix = `${realRoot}${process.platform === 'win32' ? '\\' : '/'}`;
  if (realCandidate !== realRoot && !realCandidate.startsWith(prefix)) {
    throw new Error(`Runtime adapter path resolves outside the project root: ${relativePath}.`);
  }
  return candidate;
}

function assertImplementedAdapters(manifest: AdapterManifest, implementation: string, file: string): void {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { target: ScriptTarget.ES2022 },
  });
  const source = project.createSourceFile('/flowctl-adapters.ts', implementation, { scriptKind: ScriptKind.TS });
  const declaration = source.getVariableDeclaration('flowctlAdapters');
  const statement = declaration?.getVariableStatement();
  const initializer = declaration?.getInitializer();
  if (!statement?.isExported() || !initializer || !Node.isObjectLiteralExpression(initializer)) {
    throw new Error(`Runtime adapter implementation ${file} must export const flowctlAdapters as an object literal.`);
  }
  const implemented = new Set(initializer.getProperties().flatMap((property) => {
    if (Node.isPropertyAssignment(property)) {
      const value = property.getInitializer();
      if (!value || (!Node.isArrowFunction(value) && !Node.isFunctionExpression(value))) return [];
      return [staticAdapterPropertyName(property.getName())].filter((name): name is string => Boolean(name));
    }
    if (Node.isMethodDeclaration(property)) return [property.getName()];
    return [];
  }));
  const missing = manifest.adapters.map((adapter) => adapter.id).filter((id) => !implemented.has(id));
  if (missing.length) throw new Error(`Runtime adapter implementation ${file} is missing callable adapter(s): ${missing.join(', ')}.`);
}

function staticAdapterPropertyName(value: string): string | undefined {
  if (/^['"].*['"]$/.test(value)) return value.slice(1, -1);
  return /^[A-Za-z_$][\w$]*$/.test(value) ? value : undefined;
}

export function permittedAdapterIds(
  loaded: LoadedAdapterManifest,
  targetKind: RuntimeTargetKind,
  controlKind?: string,
): string[] {
  return loaded.manifest.adapters.filter((adapter) => (
    adapter.targets.includes(targetKind)
    && (!adapter.controlKinds?.length || !controlKind || adapter.controlKinds.includes(controlKind))
  )).map((adapter) => adapter.id).sort();
}
