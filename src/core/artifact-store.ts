import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { FlowctlConfig } from './config.js';
import { canonicalize, sha256, stableJson } from './stable.js';
import type { ArtifactEnvelope, ArtifactMeta, Diagnostic } from '../ir/model.js';

export const ARTIFACT_FILES = {
  evidence: 'evidence-graph.json',
  operations: 'operation-catalog.yaml',
  pages: 'page-contracts.json',
  actors: 'actor-requirements.json',
  behavior: 'behavior-graph.json',
  families: 'flow-families.json',
  witnesses: 'path-witnesses.json',
  variants: 'flow-variants.json',
  runtime: 'runtime-bindings.json',
  coverage: 'coverage.json',
} as const;

export type ArtifactName = keyof typeof ARTIFACT_FILES;

export class ArtifactStore {
  readonly artifactDirectory: string;
  readonly workDirectory: string;
  readonly generatedDirectory: string;
  readonly decisionsDirectory: string;
  readonly dataRequirementsDirectory: string;
  readonly dataBindingsDirectory: string;

  constructor(readonly config: FlowctlConfig) {
    this.artifactDirectory = path.join(config.outputRoot, 'artifacts');
    this.workDirectory = path.join(config.outputRoot, 'work');
    this.generatedDirectory = path.join(config.outputRoot, 'generated');
    this.decisionsDirectory = path.join(config.outputRoot, 'decisions');
    this.dataRequirementsDirectory = path.join(this.artifactDirectory, 'data-requirements');
    this.dataBindingsDirectory = path.join(config.outputRoot, 'data-bindings');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.artifactDirectory,
      this.workDirectory,
      this.generatedDirectory,
      this.decisionsDirectory,
      this.dataRequirementsDirectory,
      this.dataBindingsDirectory,
      path.join(this.workDirectory, 'packets'),
      path.join(this.workDirectory, 'proposals'),
      path.join(this.workDirectory, 'runtime'),
    ].map((directory) => fs.mkdir(directory, { recursive: true })));
  }

  artifactPath(name: ArtifactName): string {
    return path.join(this.artifactDirectory, ARTIFACT_FILES[name]);
  }

  async exists(name: ArtifactName): Promise<boolean> {
    try {
      await fs.access(this.artifactPath(name));
      return true;
    } catch {
      return false;
    }
  }

  async read<T>(name: ArtifactName): Promise<ArtifactEnvelope<T>> {
    const file = this.artifactPath(name);
    const text = await fs.readFile(file, 'utf8');
    if (file.endsWith('.yaml')) {
      return parseYaml(text) as ArtifactEnvelope<T>;
    }
    return JSON.parse(text) as ArtifactEnvelope<T>;
  }

  async write<T>(name: ArtifactName, envelope: ArtifactEnvelope<T>): Promise<string> {
    await this.initialize();
    const destination = this.artifactPath(name);
    const staging = path.join(this.workDirectory, `${ARTIFACT_FILES[name]}.staging`);
    const serialized = destination.endsWith('.yaml')
      ? stringifyYaml(canonicalize(envelope), { lineWidth: 0, sortMapEntries: true })
      : stableJson(envelope);
    await fs.writeFile(staging, serialized, 'utf8');
    await fs.rename(staging, destination);
    return destination;
  }

  createEnvelope<T>(options: {
    artifactType: string;
    producer: string;
    sourceDigest: string;
    inputDigests?: Record<string, string>;
    data: T;
    status?: ArtifactMeta['status'];
    unresolved?: Diagnostic[];
  }): ArtifactEnvelope<T> {
    const meta: ArtifactMeta = {
      artifactType: options.artifactType,
      schemaVersion: '1.0',
      producer: options.producer,
      producerVersion: '0.1.0',
      sourceDigest: options.sourceDigest,
      configDigest: this.config.configDigest,
      inputDigests: options.inputDigests ?? {},
      contentDigest: sha256(stableJson(options.data)),
      status: options.status ?? 'generated',
      unresolved: options.unresolved ?? [],
    };
    return { meta, data: options.data };
  }
}
