import type { DataRequirement, InputConstraint } from '../ir/model.js';

const SENSITIVE_WORDS = new Set([
  'password',
  'passwd',
  'passcode',
  'pwd',
  'token',
  'secret',
  'otp',
  'credential',
  'credentials',
  'cvv',
  'cvc',
]);

const SENSITIVE_COMPOUNDS = new Set([
  'apikey',
  'accesskey',
  'privatekey',
  'clientsecret',
  'sessioncookie',
  'authcode',
  'accesscode',
  'verificationcode',
  'securitycode',
  'authpin',
  'loginpin',
  'securitypin',
]);

export function isSensitiveFieldPath(value: string): boolean {
  return identifierSegments(value).some(isSensitiveIdentifier);
}

export function isSensitiveControlKind(value: string): boolean {
  return identifierSegments(value).some(isSensitiveIdentifier);
}

export function isSecretBearingRequirement(requirement: Pick<DataRequirement, 'classification'>): boolean {
  return requirement.classification === 'secret-reference'
    || requirement.classification === 'authenticated-identity';
}

/**
 * Secret constraints keep source-grounded shape and evidence, but never copy a
 * source literal, validation message, or excerpt into application-data plans.
 * The approved runner resolves and enters the secret through an external
 * reference; Flowctl never needs the raw value to verify that handoff.
 */
export function redactSecretConstraints(constraints: readonly InputConstraint[]): InputConstraint[] {
  return constraints.map((constraint) => {
    const {
      value: _value,
      message: _message,
      sourceRef,
      ...contract
    } = constraint;
    const { excerpt: _excerpt, ...safeSourceRef } = sourceRef;
    return { ...contract, sourceRef: safeSourceRef };
  });
}

function identifierSegments(value: string): string[] {
  return value
    .split(/[.[\]]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isSensitiveIdentifier(value: string): boolean {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
  const compact = words.join('');
  return words.some((word) => SENSITIVE_WORDS.has(word))
    || SENSITIVE_COMPOUNDS.has(compact)
    || compact === 'pin';
}
