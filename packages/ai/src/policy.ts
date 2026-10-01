import type { DataLocation, Sensitivity } from './types.js';

export interface RoutePolicy {
  /** Workspace setting: may Confidential content reach third-party models? */
  confidentialAllowsThirdParty: boolean;
}

/**
 * The one rule that protects customer data: Restricted content never leaves the cluster, and
 * Confidential content only does when the workspace allows it. Retrieval applies the same rule
 * inside SQL; this function is the second line of defence before any provider call.
 */
export function canSend(
  sensitivity: Sensitivity,
  location: DataLocation,
  policy: RoutePolicy,
): boolean {
  if (location === 'IN_CLUSTER') return true;
  if (sensitivity === 'RESTRICTED') return false;
  if (sensitivity === 'CONFIDENTIAL') return policy.confidentialAllowsThirdParty;
  return true;
}

/** Split sources into those a provider may see and a count of hidden ones for the UI notice. */
export function partitionSources<T extends { sensitivity: Sensitivity }>(
  sources: readonly T[],
  location: DataLocation,
  policy: RoutePolicy,
): { allowed: T[]; hidden: number } {
  const allowed = sources.filter((s) => canSend(s.sensitivity, location, policy));
  return { allowed, hidden: sources.length - allowed.length };
}
