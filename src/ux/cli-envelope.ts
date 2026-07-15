import type { Diagnostic } from '../ir/model.js';
import type { GuideAction } from './guide.js';

export interface CliEnvelope<T> {
  schemaVersion: 'flowctl.cli.v1';
  command: string;
  ok: boolean;
  code: string;
  project?: {
    name: string;
    configPath: string;
    sourceDigest?: string;
  };
  target?: {
    familyId?: string;
    variantId?: string;
    environment?: string;
  };
  result?: T;
  nextActions: GuideAction[];
  diagnostics: Diagnostic[];
}

export function successEnvelope<T>(options: {
  command: string;
  result: T;
  project?: CliEnvelope<T>['project'];
  target?: CliEnvelope<T>['target'];
  nextActions?: GuideAction[];
  diagnostics?: Diagnostic[];
  code?: string;
}): CliEnvelope<T> {
  return {
    schemaVersion: 'flowctl.cli.v1',
    command: options.command,
    ok: true,
    code: options.code ?? 'OK',
    ...(options.project ? { project: options.project } : {}),
    ...(options.target ? { target: options.target } : {}),
    result: options.result,
    nextActions: options.nextActions ?? [],
    diagnostics: options.diagnostics ?? [],
  };
}

export function failureEnvelope(options: {
  command: string;
  code: string;
  message: string;
  details?: unknown;
}): CliEnvelope<never> {
  return {
    schemaVersion: 'flowctl.cli.v1',
    command: options.command,
    ok: false,
    code: options.code,
    nextActions: [],
    diagnostics: [{
      code: options.code,
      severity: 'error',
      message: options.message,
      ...(options.details ? { scope: JSON.stringify(options.details) } : {}),
    }],
  };
}
