import { ZodError } from 'zod';

export const EXIT_CODE = {
  success: 0,
  invalid: 2,
  reviewRequired: 3,
  dataRequired: 4,
  runtimeRequired: 5,
  stale: 6,
  securityDenied: 7,
  notFound: 8,
  internal: 10,
} as const;

export class FlowctlError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'FlowctlError';
  }
}

export function normalizeFlowctlError(error: unknown): FlowctlError {
  if (error instanceof FlowctlError) return error;
  if (error instanceof ZodError) return new FlowctlError('SCHEMA_INVALID', EXIT_CODE.invalid, error.message, error.issues);
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (errorCode.startsWith('commander.')) return new FlowctlError('INVALID_INPUT', EXIT_CODE.invalid, message);
  if (/provide exactly|does not match|not allowed|invalid|required option|unknown option|missing required argument|too many arguments|must be|action sequence/i.test(message)) {
    return new FlowctlError('INVALID_INPUT', EXIT_CODE.invalid, message);
  }
  if (/not found|unknown/i.test(message)) return new FlowctlError('NOT_FOUND', EXIT_CODE.notFound, message);
  if (/stale/i.test(message)) return new FlowctlError('STALE_ARTIFACT', EXIT_CODE.stale, message);
  if (/forbidden|security|raw sensitive|credential|secret/i.test(message)) return new FlowctlError('SECURITY_POLICY_DENIED', EXIT_CODE.securityDenied, message);
  if (/review.required|approval required|must be approved/i.test(message)) return new FlowctlError('REVIEW_REQUIRED', EXIT_CODE.reviewRequired, message);
  if (/data requirement|unverified|unbound|identifier/i.test(message)) return new FlowctlError('DATA_REQUIRED', EXIT_CODE.dataRequired, message);
  if (/runtime|grounding|observation|locator|actionable|screen mismatch/i.test(message)) return new FlowctlError('RUNTIME_REQUIRED', EXIT_CODE.runtimeRequired, message);
  if (/ENOENT|no such file|missing artifact/i.test(message)) return new FlowctlError('NOT_FOUND', EXIT_CODE.notFound, message);
  return new FlowctlError('INTERNAL_ERROR', EXIT_CODE.internal, message);
}
