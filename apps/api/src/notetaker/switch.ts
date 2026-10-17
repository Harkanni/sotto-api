/**
 * The notetaker's admin switch as an injection token: the workspace settings route turns the
 * notetaker off without importing it (the notetaker reaches back to the workspace controller's
 * `IdParam` through the live routes, which made an import cycle).
 */
export const NOTETAKER_SWITCH = Symbol('NOTETAKER_SWITCH');

export interface NotetakerSwitch {
  /** Skips calls not started yet; bots on their way or in a call leave (what they heard is saved). */
  turnedOff(workspaceId: string): Promise<number>;
}
