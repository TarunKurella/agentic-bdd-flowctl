import path from 'node:path';
import fs from 'node:fs/promises';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function safeFileSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} must be a non-empty identifier containing only letters, numbers, dot, underscore or hyphen.`);
  }
  return value;
}

export function safeChildPath(root: string, fileName: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, fileName);
  if (path.dirname(resolved) !== resolvedRoot) throw new Error(`Resolved path escapes its allowed directory: ${fileName}.`);
  return resolved;
}

export function safeDescendantPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Resolved path escapes its allowed directory: ${relativePath}.`);
  }
  return resolved;
}

export async function safeRealDescendantPath(root: string, relativePath: string, label = 'Path'): Promise<string> {
  const resolved = safeDescendantPath(root, relativePath);
  const realRoot = await fs.realpath(path.resolve(root));
  let existing = resolved;
  while (true) {
    try {
      const realExisting = await fs.realpath(existing);
      if (realExisting !== realRoot && !realExisting.startsWith(`${realRoot}${path.sep}`)) {
        throw new Error(`${label} escapes its trusted root through a symbolic link: ${relativePath}.`);
      }
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export function assertSafeRelativePattern(value: string, label: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (path.isAbsolute(value) || normalized.split('/').includes('..') || normalized.includes('\0')) {
    throw new Error(`${label} must stay within its configured source root: ${value}.`);
  }
  return normalized;
}
