/**
 * Plans, prices and limits: the one config the app, the api and (Phase 8) the pricing page read
 * (BRIEF §4 Billing). Every number here is a PLACEHOLDER for the owner to set; the UI labels
 * prices as placeholders until `PRICES_ARE_PLACEHOLDERS` is turned off.
 *
 * Prices are in kobo (NGN minor units) because Paystack charges in them (ADR 0004). `null`
 * limits mean unlimited (Enterprise is sold by contract).
 */

export type PlanId = 'FREE' | 'PRO' | 'BUSINESS' | 'ENTERPRISE';
export type AiMode = 'PRIVATE' | 'BYOK' | 'MANAGED';

export interface PlanLimits {
  /** Tokens answered by Sotto's in-cluster models per calendar month. */
  privateTokens: number | null;
  /** Tokens answered on Sotto's own provider account per month (0 = Managed not included). */
  managedTokens: number | null;
  /** Minutes of audio transcribed per month. */
  transcriptionMinutes: number | null;
  /** Files stored, in bytes (the trash counts until it's emptied). */
  storageBytes: number | null;
}

export interface PlanConfig {
  id: PlanId;
  name: string;
  /** One line for the plan card. */
  summary: string;
  /** Monthly and yearly prices in kobo; null = talk to sales. */
  price: { monthly: number; yearly: number } | null;
  modes: AiMode[];
  limits: PlanLimits;
  /** What's included, in plain words, for the plan card. */
  features: string[];
  /** Can be bought with checkout (Free needs no checkout; Enterprise is sold by contract). */
  selfServe: boolean;
}

export const CURRENCY = 'NGN';
export const PRICES_ARE_PLACEHOLDERS = true;

const GB = 1024 ** 3;

export const PLANS: readonly PlanConfig[] = [
  {
    id: 'FREE',
    name: 'Free',
    summary: 'Bring your own AI key, with a small private allowance.',
    price: { monthly: 0, yearly: 0 },
    modes: ['PRIVATE', 'BYOK'],
    limits: {
      privateTokens: 200_000,
      managedTokens: 0,
      transcriptionMinutes: 60,
      storageBytes: 1 * GB,
    },
    features: ['Your own API key', 'Private AI allowance', '1 hour of transcription', '1 GB'],
    selfServe: false,
  },
  {
    id: 'PRO',
    name: 'Pro',
    summary: 'Managed AI included, no keys to look after.',
    price: { monthly: 15_000_00, yearly: 150_000_00 },
    modes: ['PRIVATE', 'BYOK', 'MANAGED'],
    limits: {
      privateTokens: 2_000_000,
      managedTokens: 2_000_000,
      transcriptionMinutes: 600,
      storageBytes: 20 * GB,
    },
    features: ['Managed AI', 'More private AI', '10 hours of transcription', '20 GB'],
    selfServe: true,
  },
  {
    id: 'BUSINESS',
    name: 'Business',
    summary: 'For teams with admin policies and long meetings.',
    price: { monthly: 45_000_00, yearly: 450_000_00 },
    modes: ['PRIVATE', 'BYOK', 'MANAGED'],
    limits: {
      privateTokens: 10_000_000,
      managedTokens: 10_000_000,
      transcriptionMinutes: 3_000,
      storageBytes: 200 * GB,
    },
    features: ['Admin AI policies', 'Audit log export', '50 hours of transcription', '200 GB'],
    selfServe: true,
  },
  {
    id: 'ENTERPRISE',
    name: 'Enterprise',
    summary: 'Run Sotto in your own cloud, with single sign-on.',
    price: null,
    modes: ['PRIVATE', 'BYOK', 'MANAGED'],
    limits: {
      privateTokens: null,
      managedTokens: null,
      transcriptionMinutes: null,
      storageBytes: null,
    },
    features: ['Self-hosted', 'Single sign-on', 'Custom limits'],
    selfServe: false,
  },
];

export function planById(id: PlanId): PlanConfig {
  return PLANS.find((p) => p.id === id)!;
}

/** The cheapest plan that allows a mode, for "upgrade to …" prompts. */
export function cheapestPlanWith(mode: AiMode): PlanConfig | undefined {
  return PLANS.find((p) => p.selfServe && p.modes.includes(mode));
}

/** The next self-serve plan above this one, if any. */
export function nextPlan(id: PlanId): PlanConfig | undefined {
  const order = PLANS.map((p) => p.id);
  return PLANS.slice(order.indexOf(id) + 1).find((p) => p.selfServe);
}
