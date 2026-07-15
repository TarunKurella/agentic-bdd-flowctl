import { ARTIFACT_FILES, type ArtifactName, type ArtifactStore } from './artifact-store.js';
import { EXIT_CODE, FlowctlError } from './errors.js';
import type { ArtifactEnvelope } from '../ir/model.js';

export interface NamedArtifact {
  name: ArtifactName;
  envelope: ArtifactEnvelope<unknown>;
}

export interface LineageIssue {
  name: ArtifactName;
  input: ArtifactName;
  message: string;
}

const artifactNames = new Set<ArtifactName>(Object.keys(ARTIFACT_FILES) as ArtifactName[]);

export function findLineageIssues(artifacts: Partial<Record<ArtifactName, ArtifactEnvelope<unknown>>>): LineageIssue[] {
  const issues: LineageIssue[] = [];
  for (const [name, envelope] of Object.entries(artifacts) as Array<[ArtifactName, ArtifactEnvelope<unknown>]>) {
    for (const [inputName, expectedDigest] of Object.entries(envelope.meta.inputDigests ?? {})) {
      if (!artifactNames.has(inputName as ArtifactName)) continue;
      const input = inputName as ArtifactName;
      const upstream = artifacts[input];
      if (!upstream || upstream.meta.contentDigest !== expectedDigest) {
        issues.push({
          name,
          input,
          message: `${ARTIFACT_FILES[name]} is stale because its ${input} input digest no longer matches.`,
        });
      }
    }
  }
  return issues;
}

export async function assertArtifactLineage(store: ArtifactStore, roots: NamedArtifact[]): Promise<void> {
  const loaded = new Map<ArtifactName, ArtifactEnvelope<unknown>>(
    roots.map((item) => [item.name, item.envelope]),
  );
  const visited = new Set<ArtifactName>();

  const visit = async (name: ArtifactName): Promise<void> => {
    if (visited.has(name)) return;
    visited.add(name);
    const envelope = loaded.get(name) ?? await store.read<unknown>(name);
    loaded.set(name, envelope);
    for (const [inputName, expectedDigest] of Object.entries(envelope.meta.inputDigests ?? {})) {
      if (!artifactNames.has(inputName as ArtifactName)) {
        throw new FlowctlError('STALE_ARTIFACT', EXIT_CODE.stale, `${ARTIFACT_FILES[name]} declares unknown input ${inputName}. Run flowctl discover.`);
      }
      const input = inputName as ArtifactName;
      const upstream = loaded.get(input) ?? await store.read<unknown>(input);
      loaded.set(input, upstream);
      if (upstream.meta.contentDigest !== expectedDigest) {
        throw new FlowctlError('STALE_ARTIFACT', EXIT_CODE.stale, `${ARTIFACT_FILES[name]} is stale because its ${input} input digest no longer matches. Run flowctl discover.`);
      }
      await visit(input);
    }
  };

  for (const root of roots) await visit(root.name);
}
