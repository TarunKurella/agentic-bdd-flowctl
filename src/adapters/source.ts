import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { FlowctlConfig } from '../core/config.js';
import { assertSafeRelativePattern, safeRealDescendantPath } from '../core/paths.js';
import { sha256 } from '../core/stable.js';
import type { SourceRef } from '../ir/model.js';

export interface SourceFile {
  absolutePath: string;
  relativePath: string;
  language: 'typescript' | 'java' | 'other';
  contents: string;
}

export interface SourceSnapshot {
  files: SourceFile[];
  digest: string;
  refs: SourceRef[];
}

export async function snapshotSources(config: FlowctlConfig): Promise<SourceSnapshot> {
  const configuredRoots = [...config.sources.frontend, ...config.sources.backend];
  const roots = await Promise.all(configuredRoots.map(async (root) => {
    const absolute = await safeRealDescendantPath(config.projectRoot, root, 'Source root');
    return normalize(path.relative(config.projectRoot, absolute));
  }));
  const includes = config.sources.include.map((include) => assertSafeRelativePattern(include, 'Source include pattern'));
  const outputRoot = normalize(path.relative(config.projectRoot, config.outputRoot));
  if (!outputRoot) {
    throw new Error('output.directory cannot be the project root because generated artifacts must be excluded from source discovery.');
  }
  const outputRootPattern = fg.escapePath(outputRoot);
  const excludes = [
    ...config.sources.exclude.map((exclude) => assertSafeRelativePattern(exclude, 'Source exclude pattern')),
    outputRootPattern,
    `${outputRootPattern}/**`,
  ];
  const patterns = roots.flatMap((root) => includes.map((include) => (
    root ? `${fg.escapePath(root)}/${include}` : include
  )));
  const matches = await fg(patterns, {
    cwd: config.projectRoot,
    absolute: true,
    onlyFiles: true,
    unique: true,
    ignore: excludes,
    followSymbolicLinks: false,
  });

  const files: SourceFile[] = [];
  for (const absolutePath of matches.sort()) {
    await safeRealDescendantPath(config.projectRoot, path.relative(config.projectRoot, absolutePath), 'Source file');
    const contents = await fs.readFile(absolutePath, 'utf8');
    const relativePath = normalize(path.relative(config.projectRoot, absolutePath));
    files.push({
      absolutePath,
      relativePath,
      language: /\.tsx?$/.test(absolutePath) ? 'typescript' : absolutePath.endsWith('.java') ? 'java' : 'other',
      contents,
    });
  }

  const auxiliaryInputs: Array<{ relativePath: string; contents: string }> = [];
  const graphPath = await safeRealDescendantPath(config.projectRoot, config.graphify.graph, 'Graphify graph');
  assertAuxiliaryOutsideOutput(config.outputRoot, graphPath, 'Graphify graph');
  try {
    auxiliaryInputs.push({
      relativePath: normalize(path.relative(config.projectRoot, graphPath)),
      contents: await fs.readFile(graphPath, 'utf8'),
    });
  } catch {
    auxiliaryInputs.push({ relativePath: normalize(config.graphify.graph), contents: '<missing>' });
  }
  for (const configuredPath of config.wiki.paths) {
    const wikiRoot = await safeRealDescendantPath(config.projectRoot, configuredPath, 'Wiki path');
    assertAuxiliaryOutsideOutput(config.outputRoot, wikiRoot, 'Wiki evidence root');
    const wikiOutputRelative = normalize(path.relative(wikiRoot, config.outputRoot));
    const wikiIgnore = wikiOutputRelative && !wikiOutputRelative.startsWith('../')
      ? [fg.escapePath(wikiOutputRelative), `${fg.escapePath(wikiOutputRelative)}/**`]
      : [];
    const wikiFiles = await fg(['**/*.md', '**/*.txt'], {
      cwd: wikiRoot,
      absolute: true,
      onlyFiles: true,
      unique: true,
      ignore: wikiIgnore,
      followSymbolicLinks: false,
    }).catch(() => []);
    if (!wikiFiles.length) auxiliaryInputs.push({ relativePath: `${normalize(configuredPath)}/<empty>`, contents: '<missing>' });
    for (const absolutePath of wikiFiles.sort()) {
      await safeRealDescendantPath(config.projectRoot, path.relative(config.projectRoot, absolutePath), 'Wiki file');
      auxiliaryInputs.push({
        relativePath: normalize(path.relative(config.projectRoot, absolutePath)),
        contents: await fs.readFile(absolutePath, 'utf8'),
      });
    }
  }

  const digestInput = [...files, ...auxiliaryInputs]
    .map((file) => `${file.relativePath}\0${file.contents}`)
    .join('\0');
  return {
    files,
    digest: sha256(digestInput),
    refs: files.map((file) => ({ file: file.relativePath, line: 1 })),
  };
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function assertAuxiliaryOutsideOutput(outputRoot: string, candidate: string, label: string): void {
  const output = path.resolve(outputRoot);
  const resolved = path.resolve(candidate);
  if (resolved === output || resolved.startsWith(`${output}${path.sep}`)) {
    throw new Error(`${label} cannot resolve inside output.directory because compiler output must never become source evidence.`);
  }
}
