export interface PlaywrightControl {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  selectOption(value: string): Promise<void>;
  check(): Promise<void>;
  isVisible(): Promise<boolean>;
}

export interface PlaywrightActorSession {
  establishApprovedIdentity(valuesByRequirementId: Record<string, ResolvedRuntimeValue>): Promise<void>;
}

export interface RuntimeValueResolutionHandoff {
  requirementId: string;
  logicalAlias: string;
  strategy: string;
  lookupFile: string;
  lookupKey: string;
  secretHandle?: string;
}

export interface ResolvedRuntimeValue {
  handoff: RuntimeValueResolutionHandoff;
  valueResolutionDigest: string;
  /** Ephemeral runner memory only; never write this value to a manifest or observation. */
  value: string;
}

export const flowctlAdapters = {
  'approved-actor-session': async (
    session: PlaywrightActorSession,
    valuesByRequirementId: Record<string, ResolvedRuntimeValue>,
  ): Promise<void> => session.establishApprovedIdentity(valuesByRequirementId),
  'visible-screen-state': async (control: PlaywrightControl): Promise<void> => {
    if (!await control.isVisible()) throw new Error('Expected screen state is not visible.');
  },
  'native-action': async (control: PlaywrightControl): Promise<void> => control.click(),
  'native-form-control': async (
    control: PlaywrightControl,
    resolved: ResolvedRuntimeValue,
    controlKind: 'radio' | 'textbox' | 'CustomerSelect',
  ): Promise<void> => {
    if (controlKind === 'radio') return control.check();
    if (controlKind === 'CustomerSelect') return control.selectOption(resolved.value);
    return control.fill(resolved.value);
  },
};
