import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { FlowctlConfig } from '../core/config.js';
import { safeRealDescendantPath } from '../core/paths.js';
import { stableId } from '../core/stable.js';
import type { Diagnostic, WikiConcept } from '../ir/model.js';

export async function importWiki(config: FlowctlConfig): Promise<{ concepts: WikiConcept[]; diagnostics: Diagnostic[] }> {
  const concepts: WikiConcept[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const configuredPath of config.wiki.paths) {
    const absolute = await safeRealDescendantPath(config.projectRoot, configuredPath, 'Wiki path');
    const files = await fg(['**/*.md', '**/*.txt'], { cwd: absolute, absolute: true, onlyFiles: true }).catch(() => []);
    for (const file of files.sort()) {
      await safeRealDescendantPath(config.projectRoot, path.relative(config.projectRoot, file), 'Wiki file');
      const text = await fs.readFile(file, 'utf8');
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        const heading = line.match(/^#{1,3}\s+(.+)$/);
        if (!heading?.[1]) return;
        const canonicalLabel = heading[1].trim();
        const aliasLine = lines.slice(index + 1, index + 5).find((candidate) => /^aliases?\s*:/i.test(candidate));
        const aliases = aliasLine ? aliasLine.replace(/^aliases?\s*:/i, '').split(',').map((item) => item.trim()).filter(Boolean) : [];
        concepts.push({
          id: stableId('wiki-concept', canonicalLabel),
          canonicalLabel,
          aliases,
          sourceRef: { file: relative(config.projectRoot, file), line: index + 1, excerpt: line },
        });
      });
    }
    if (!files.length) {
      diagnostics.push({
        code: 'WIKI_PATH_EMPTY',
        severity: config.wiki.required ? 'error' : 'info',
        message: `No LLM Wiki Markdown files found at ${configuredPath}.`,
      });
    }
  }
  if (config.wiki.required && (!config.wiki.paths.length || diagnostics.some((diagnostic) => diagnostic.code === 'WIKI_PATH_EMPTY'))) {
    throw new Error('wiki.required is true, but one or more configured Wiki inputs contain no readable Markdown or text evidence.');
  }
  return { concepts, diagnostics };
}

function relative(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, '/');
}
