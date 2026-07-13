import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { FlowctlConfig } from '../core/config.js';
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
  const roots = [...config.sources.frontend, ...config.sources.backend];
  const patterns = roots.flatMap((root) => config.sources.include.map((include) => `${normalize(root)}/${include}`));
  const matches = await fg(patterns, {
    cwd: config.projectRoot,
    absolute: true,
    onlyFiles: true,
    unique: true,
    ignore: config.sources.exclude,
    followSymbolicLinks: false,
  });

  const files: SourceFile[] = [];
  for (const absolutePath of matches.sort()) {
    const contents = await fs.readFile(absolutePath, 'utf8');
    const relativePath = normalize(path.relative(config.projectRoot, absolutePath));
    files.push({
      absolutePath,
      relativePath,
      language: /\.tsx?$/.test(absolutePath) ? 'typescript' : absolutePath.endsWith('.java') ? 'java' : 'other',
      contents,
    });
  }

  const digestInput = files.map((file) => `${file.relativePath}\0${file.contents}`).join('\0');
  return {
    files,
    digest: sha256(digestInput),
    refs: files.map((file) => ({ file: file.relativePath, line: 1 })),
  };
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}
