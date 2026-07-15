import fs from 'node:fs/promises';
import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { FlowctlConfig } from './config.js';
import { EXIT_CODE, FlowctlError } from './errors.js';
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

interface ManagedPath {
  requested: string;
  anchor: string;
  realAnchor: string;
  relative: string;
  canonical: string;
}

/**
 * Computes a deterministic consistency digest for the complete artifact
 * envelope. The digest field itself is omitted to avoid a circular hash.
 *
 * This detects accidental edits and incomplete rewrites. It is not an
 * authenticity signature because a writer with filesystem access can
 * recompute it.
 */
export function artifactEnvelopeDigest<T>(envelope: ArtifactEnvelope<T>): string {
  const { envelopeDigest: _envelopeDigest, ...meta } = envelope.meta;
  return sha256(stableJson({ meta, data: envelope.data }));
}

const ARTIFACT_CONTRACTS: Record<ArtifactName, { artifactType: string; producers: string[] }> = {
  evidence: { artifactType: 'evidence-graph', producers: ['evidence:link'] },
  operations: { artifactType: 'operation-catalog', producers: ['operations:discover', 'review:invalidate-operation-model'] },
  pages: { artifactType: 'page-contracts', producers: ['pages:build'] },
  actors: { artifactType: 'actor-requirements', producers: ['actors:build'] },
  behavior: { artifactType: 'behavior-graph', producers: ['behavior:build'] },
  families: { artifactType: 'flow-families', producers: ['families:discover'] },
  witnesses: { artifactType: 'path-witnesses', producers: ['paths:search'] },
  variants: { artifactType: 'flow-variants', producers: ['variants:reduce'] },
  runtime: {
    artifactType: 'runtime-bindings',
    producers: ['runtime:initialize', 'runtime:invalidate', 'runtime:upgrade-invalidate', 'runtime:record'],
  },
  coverage: { artifactType: 'coverage', producers: ['coverage:build'] },
};

export class ArtifactStore {
  readonly artifactDirectory: string;
  readonly workDirectory: string;
  readonly generatedDirectory: string;
  readonly decisionsDirectory: string;
  readonly dataRequirementsDirectory: string;
  readonly applicationDataFile: string;

  constructor(
    readonly config: FlowctlConfig,
    options: { applicationDataFile?: string } = {},
  ) {
    this.artifactDirectory = path.join(config.outputRoot, 'artifacts');
    this.workDirectory = path.join(config.outputRoot, 'work');
    this.generatedDirectory = path.join(config.outputRoot, 'generated');
    this.decisionsDirectory = path.join(config.outputRoot, 'decisions');
    this.dataRequirementsDirectory = path.join(this.artifactDirectory, 'data-requirements');
    this.applicationDataFile = options.applicationDataFile
      ?? config.applicationDataPath;
  }

  async initialize(): Promise<void> {
    const directories = [
      this.artifactDirectory,
      this.workDirectory,
      this.generatedDirectory,
      this.decisionsDirectory,
      this.dataRequirementsDirectory,
      path.dirname(this.applicationDataFile),
      path.join(this.workDirectory, 'packets'),
      path.join(this.workDirectory, 'proposals'),
      path.join(this.workDirectory, 'runtime'),
    ];
    for (const directory of [...new Set(directories.map((value) => path.resolve(value)))]) {
      await this.ensureManagedDirectory(directory);
    }
  }

  /**
   * Creates a compiler-owned directory one component at a time and rejects any
   * existing symbolic-link component. This protects against checked-in or
   * pre-created link redirection. Node does not expose an openat/openat2-style
   * directory handle for the complete operation, so callers still assume a
   * trusted local writer (no hostile same-user path swapping during a write).
   */
  async ensureManagedDirectory(directory: string): Promise<string> {
    await this.checkManagedDirectory(directory, true);
    return directory;
  }

  /** Atomically writes a compiler-owned file without following a final symlink. */
  async writeManagedFile(destination: string, data: string | Uint8Array): Promise<string> {
    const requestedDestination = path.resolve(destination);
    await this.ensureManagedDirectory(path.dirname(requestedDestination));
    const target = await this.resolveManagedPath(requestedDestination, 'file');
    await assertWritableDestination(target.canonical, destination);

    const temporary = path.join(
      path.dirname(target.canonical),
      `.${path.basename(target.canonical)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const flags = fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let closed = false;
    try {
      handle = await fs.open(temporary, flags, 0o600);
      if (typeof data === 'string') await handle.writeFile(data, { encoding: 'utf8' });
      else await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      closed = true;

      // Revalidate immediately before rename so a changed parent or final link
      // fails closed. rename replaces a regular destination atomically.
      await this.checkManagedDirectory(path.dirname(requestedDestination), false);
      const current = await this.resolveManagedPath(requestedDestination, 'file');
      if (current.canonical !== target.canonical) {
        throw new Error(`Compiler-managed destination changed during write: ${destination}.`);
      }
      await assertWritableDestination(current.canonical, destination);
      await fs.rename(temporary, current.canonical);
      return destination;
    } finally {
      if (handle && !closed) await handle.close().catch(() => undefined);
      // Only clean up through a still-validated parent. If it changed, leave the
      // unpredictable 0600 temporary file rather than risk unlinking elsewhere.
      try {
        await this.checkManagedDirectory(path.dirname(requestedDestination), false);
        await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      } catch {
        // Preserve the original failure and fail closed on cleanup races.
      }
    }
  }

  /** Removes a compiler-owned file entry without following a final symlink. */
  async removeManagedFile(destination: string): Promise<boolean> {
    const requestedDestination = path.resolve(destination);
    const parentExists = await this.checkManagedDirectory(path.dirname(requestedDestination), false);
    if (!parentExists) return false;
    const target = await this.resolveManagedPath(requestedDestination, 'file');
    let stat;
    try {
      stat = await fs.lstat(target.canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isDirectory() || (!stat.isFile() && !stat.isSymbolicLink())) {
      throw new Error(`Refusing to remove non-file compiler-managed entry ${destination}.`);
    }
    await this.checkManagedDirectory(path.dirname(requestedDestination), false);
    const current = await this.resolveManagedPath(requestedDestination, 'file');
    if (current.canonical !== target.canonical) {
      throw new Error(`Compiler-managed destination changed before removal: ${destination}.`);
    }
    await fs.unlink(current.canonical);
    return true;
  }

  /** Reads a regular compiler-owned file and rejects linked/non-file entries. */
  async readManagedFile(destination: string): Promise<string> {
    const target = await this.requireManagedRegularFile(destination);
    return fs.readFile(target.canonical, 'utf8');
  }

  isManagedFilePath(destination: string): boolean {
    const requested = path.resolve(destination);
    return isDescendantOrEqual(path.resolve(this.config.outputRoot), requested)
      || requested === path.resolve(this.applicationDataFile);
  }

  /** Checks a compiler-owned file without converting unsafe entries to "missing". */
  async managedFileExists(destination: string): Promise<boolean> {
    const requestedDestination = path.resolve(destination);
    const parentExists = await this.checkManagedDirectory(path.dirname(requestedDestination), false);
    if (!parentExists) return false;
    const target = await this.resolveManagedPath(requestedDestination, 'file');
    try {
      const stat = await fs.lstat(target.canonical);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to inspect compiler-managed file through symbolic link: ${destination}.`);
      if (!stat.isFile()) throw new Error(`Compiler-managed entry is not a regular file: ${destination}.`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** Lists a compiler-owned directory only after every component is validated. */
  async listManagedDirectory(directory: string): Promise<Dirent[]> {
    if (!(await this.checkManagedDirectory(directory, false))) return [];
    const target = await this.resolveManagedPath(directory, 'directory');
    return fs.readdir(target.canonical, { withFileTypes: true });
  }

  /** lstat for runner-produced entries; parents are validated and links are not followed. */
  async inspectManagedEntry(destination: string): Promise<Stats | undefined> {
    const requestedDestination = path.resolve(destination);
    if (!(await this.checkManagedDirectory(path.dirname(requestedDestination), false))) return undefined;
    const target = await this.resolveManagedPath(requestedDestination, 'file');
    try {
      return await fs.lstat(target.canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  artifactPath(name: ArtifactName): string {
    return path.join(this.artifactDirectory, ARTIFACT_FILES[name]);
  }

  async exists(name: ArtifactName): Promise<boolean> {
    return this.managedFileExists(this.artifactPath(name));
  }

  async read<T>(name: ArtifactName): Promise<ArtifactEnvelope<T>> {
    const file = this.artifactPath(name);
    const text = await this.readManagedFile(file);
    const envelope = (file.endsWith('.yaml')
      ? parseYaml(text)
      : JSON.parse(text)) as ArtifactEnvelope<T>;
    if (!envelope || typeof envelope !== 'object' || !envelope.meta || !Object.hasOwn(envelope, 'data')) {
      throw new FlowctlError('STALE_ARTIFACT', EXIT_CODE.stale, `${ARTIFACT_FILES[name]} is not a valid artifact envelope. Run flowctl discover.`);
    }
    if (envelope.meta.schemaVersion !== '1.0' || envelope.meta.producerVersion !== '0.2.0') {
      throw new FlowctlError('STALE_ARTIFACT', EXIT_CODE.stale, `${ARTIFACT_FILES[name]} was produced by an unsupported schema or producer version and is stale. Run flowctl discover.`);
    }
    const contract = ARTIFACT_CONTRACTS[name];
    if (envelope.meta.artifactType !== contract.artifactType || !contract.producers.includes(envelope.meta.producer)) {
      throw new FlowctlError(
        'STALE_ARTIFACT',
        EXIT_CODE.stale,
        `${ARTIFACT_FILES[name]} has artifact type ${envelope.meta.artifactType} from producer ${envelope.meta.producer}; expected ${contract.artifactType} from an allowed canonical producer. Run flowctl discover.`,
      );
    }
    const actualDigest = sha256(stableJson(envelope.data));
    if (envelope.meta.contentDigest !== actualDigest) {
      throw new FlowctlError('STALE_ARTIFACT', EXIT_CODE.stale, `${ARTIFACT_FILES[name]} content digest does not match its data; run flowctl discover.`);
    }
    if (!envelope.meta.envelopeDigest) {
      throw new FlowctlError(
        'STALE_ARTIFACT',
        EXIT_CODE.stale,
        `${ARTIFACT_FILES[name]} is missing its required envelope digest; run flowctl discover.`,
      );
    }
    if (envelope.meta.envelopeDigest !== artifactEnvelopeDigest(envelope)) {
      throw new FlowctlError(
        'STALE_ARTIFACT',
        EXIT_CODE.stale,
        `${ARTIFACT_FILES[name]} envelope digest does not match its metadata and data; run flowctl discover.`,
      );
    }
    return envelope;
  }

  async write<T>(name: ArtifactName, envelope: ArtifactEnvelope<T>): Promise<string> {
    await this.initialize();
    const contract = ARTIFACT_CONTRACTS[name];
    if (envelope.meta.artifactType !== contract.artifactType || !contract.producers.includes(envelope.meta.producer)) {
      throw new Error(`Cannot write ${name}: artifact type or producer is outside its canonical contract.`);
    }
    const contentDigest = sha256(stableJson(envelope.data));
    if (envelope.meta.contentDigest !== contentDigest) {
      throw new Error(`Cannot write ${name}: content digest does not match its data.`);
    }
    const envelopeDigest = artifactEnvelopeDigest(envelope);
    if (envelope.meta.envelopeDigest && envelope.meta.envelopeDigest !== envelopeDigest) {
      throw new Error(`Cannot write ${name}: envelope digest does not match its metadata and data.`);
    }
    // Normalize every current-format write with its complete envelope digest.
    const normalizedEnvelope: ArtifactEnvelope<T> = {
      meta: { ...envelope.meta, envelopeDigest },
      data: envelope.data,
    };
    const destination = this.artifactPath(name);
    const serialized = destination.endsWith('.yaml')
      ? stringifyYaml(canonicalize(normalizedEnvelope), { lineWidth: 0, sortMapEntries: true })
      : stableJson(normalizedEnvelope);
    return this.writeManagedFile(destination, serialized);
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
      producerVersion: '0.2.0',
      sourceDigest: options.sourceDigest,
      configDigest: this.config.configDigest,
      inputDigests: options.inputDigests ?? {},
      contentDigest: sha256(stableJson(options.data)),
      status: options.status ?? 'generated',
      unresolved: options.unresolved ?? [],
    };
    const envelope: ArtifactEnvelope<T> = { meta, data: options.data };
    envelope.meta.envelopeDigest = artifactEnvelopeDigest(envelope);
    return envelope;
  }

  private async checkManagedDirectory(directory: string, create: boolean): Promise<boolean> {
    const target = await this.resolveManagedPath(directory, 'directory');
    const anchorStat = await fs.lstat(target.realAnchor);
    if (!anchorStat.isDirectory()) throw new Error(`Trusted compiler path anchor is not a directory: ${target.anchor}.`);
    let current = target.realAnchor;
    for (const segment of target.relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return false;
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        stat = await fs.lstat(current);
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing compiler-managed path with symbolic-link component: ${directory}.`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Compiler-managed directory component is not a directory: ${current}.`);
      }
    }
    return true;
  }

  private async requireManagedRegularFile(destination: string): Promise<ManagedPath> {
    const requestedDestination = path.resolve(destination);
    if (!(await this.checkManagedDirectory(path.dirname(requestedDestination), false))) {
      const error = new Error(`Compiler-managed file does not exist: ${destination}.`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    const target = await this.resolveManagedPath(requestedDestination, 'file');
    const stat = await fs.lstat(target.canonical);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to read compiler-managed file through symbolic link: ${destination}.`);
    if (!stat.isFile()) throw new Error(`Compiler-managed entry is not a regular file: ${destination}.`);
    return target;
  }

  private async resolveManagedPath(destination: string, kind: 'file' | 'directory'): Promise<ManagedPath> {
    const requested = path.resolve(destination);
    const outputRoot = path.resolve(this.config.outputRoot);
    const applicationDataFile = path.resolve(this.applicationDataFile);
    const outputManaged = isDescendantOrEqual(outputRoot, requested);
    const applicationDataManaged = kind === 'file'
      ? requested === applicationDataFile
      : requested === path.dirname(applicationDataFile);
    if (!outputManaged && !applicationDataManaged) {
      throw new Error(`Path is outside compiler-managed output and application data: ${destination}.`);
    }

    const projectRoot = path.resolve(this.config.projectRoot);
    const managedRoot = outputManaged ? outputRoot : applicationDataFile;
    const preferredAnchor = isDescendantOrEqual(projectRoot, managedRoot)
      ? projectRoot
      : outputManaged ? path.dirname(outputRoot) : path.dirname(applicationDataFile);
    const realAnchor = await fs.realpath(preferredAnchor);
    const relative = path.relative(preferredAnchor, requested);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Compiler-managed path escapes its trusted anchor: ${destination}.`);
    }
    const canonical = path.resolve(realAnchor, relative);
    if (!isDescendantOrEqual(realAnchor, canonical)) {
      throw new Error(`Compiler-managed path escapes its real trusted anchor: ${destination}.`);
    }
    return { requested, anchor: preferredAnchor, realAnchor, relative, canonical };
  }
}

function isDescendantOrEqual(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function assertWritableDestination(destination: string, requested: string): Promise<void> {
  try {
    const stat = await fs.lstat(destination);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write compiler-managed file through symbolic link: ${requested}.`);
    }
    if (!stat.isFile()) {
      throw new Error(`Compiler-managed destination is not a regular file: ${requested}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
