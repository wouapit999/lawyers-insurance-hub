/**
 * Premium rating engine.
 *
 * A rating table is data, not code: underwriting edits it in the admin portal
 * and publishes a new *version* with an effective date. Nothing here is
 * product-specific, so adding the six post-MVP product lines is a matter of
 * inserting rating tables — no new code path, which is exactly the guarantee
 * the roadmap depends on.
 *
 * Evaluation order is fixed and total:
 *
 *   1. base premium (from the plan)
 *   2. multiplicative factors, applied in declaration order
 *   3. additive loadings (fixed franc amounts)
 *   4. discounts (multiplicative, applied last)
 *   5. clamp to [minPremiumXaf, maxPremiumXaf]
 *
 * Order matters and is deliberate: a 10% multi-policy discount should apply
 * to the risk-loaded premium, not to the base, or the discount silently
 * changes value with the risk profile.
 *
 * Every step is recorded in the returned breakdown. That breakdown is stored
 * on the quote and the policy, so years later "why was this premium 285,000"
 * has a precise answer rather than a re-run against today's tables.
 */

import { applyRate, xaf, type Xaf } from '../money/xaf';

/** A rating input supplied by the applicant or derived from their profile. */
export type FactorValue = string | number | boolean;
export type RatingFactors = Record<string, FactorValue>;

export interface BandRule {
  /** Inclusive lower bound. */
  min?: number;
  /** Exclusive upper bound. */
  max?: number;
  multiplier: number;
}

export type FactorRule =
  /** Look the value up in a map: { criminal: 1.3, corporate: 1.0 } */
  | { kind: 'lookup'; field: string; values: Record<string, number>; default?: number }
  /** Bracket a numeric value: years admitted, vehicle value, firm size. */
  | { kind: 'band'; field: string; bands: BandRule[]; default?: number }
  /** Flat multiplier when a boolean is true. */
  | { kind: 'flag'; field: string; whenTrue: number }
  /** Fixed franc amount added after multipliers. */
  | { kind: 'loading'; field?: string; amountXaf: number; when?: FactorValue }
  /** Multiplicative discount applied after loadings. */
  | { kind: 'discount'; field: string; values: Record<string, number> };

export interface RatingTableDefinition {
  rules: FactorRule[];
  minPremiumXaf?: number;
  maxPremiumXaf?: number;
}

export interface BreakdownLine {
  label: string;
  kind: FactorRule['kind'] | 'base' | 'clamp';
  /** Multiplier applied, if multiplicative. */
  multiplier?: number;
  /** Franc delta applied, if additive. */
  deltaXaf?: string;
  /** Running premium after this line, in whole francs. */
  runningXaf: string;
}

export interface RatingResult {
  premiumXaf: Xaf;
  breakdown: BreakdownLine[];
}

export class RatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RatingError';
  }
}

function numeric(value: FactorValue | undefined, field: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new RatingError(`Rating factor "${field}" must be numeric, got ${JSON.stringify(value)}`);
}

export function rate(
  basePremiumXaf: Xaf,
  table: RatingTableDefinition,
  factors: RatingFactors,
): RatingResult {
  if (basePremiumXaf <= 0n) {
    throw new RatingError('Base premium must be positive');
  }

  let running = basePremiumXaf;
  const breakdown: BreakdownLine[] = [
    { label: 'base_premium', kind: 'base', runningXaf: running.toString() },
  ];

  // --- pass 1: multiplicative risk factors -------------------------------
  for (const rule of table.rules) {
    if (rule.kind === 'loading' || rule.kind === 'discount') continue;

    let multiplier: number | undefined;

    if (rule.kind === 'lookup') {
      const raw = factors[rule.field];
      // Array-valued fields (e.g. several practice areas) take the riskiest.
      if (Array.isArray(raw)) {
        const found = (raw as unknown as string[])
          .map((v) => rule.values[v])
          .filter((m): m is number => typeof m === 'number');
        multiplier = found.length ? Math.max(...found) : rule.default;
      } else {
        multiplier = rule.values[String(raw)] ?? rule.default;
      }
      if (multiplier === undefined) {
        throw new RatingError(
          `No rating entry for ${rule.field}="${String(raw)}" and no default defined`,
        );
      }
    } else if (rule.kind === 'band') {
      const v = numeric(factors[rule.field], rule.field);
      const band = rule.bands.find(
        (b) => (b.min === undefined || v >= b.min) && (b.max === undefined || v < b.max),
      );
      multiplier = band?.multiplier ?? rule.default;
      if (multiplier === undefined) {
        throw new RatingError(`Value ${v} for "${rule.field}" falls outside every band`);
      }
    } else if (rule.kind === 'flag') {
      multiplier = factors[rule.field] === true ? rule.whenTrue : 1;
    }

    if (multiplier === undefined || multiplier === 1) continue;

    running = applyRate(running, multiplier);
    breakdown.push({
      label: rule.kind === 'flag' ? `flag:${rule.field}` : `${rule.kind}:${rule.field}`,
      kind: rule.kind,
      multiplier,
      runningXaf: running.toString(),
    });
  }

  // --- pass 2: additive loadings -----------------------------------------
  for (const rule of table.rules) {
    if (rule.kind !== 'loading') continue;
    if (rule.when !== undefined && rule.field && factors[rule.field] !== rule.when) continue;

    const delta = xaf(rule.amountXaf);
    running += delta;
    breakdown.push({
      label: `loading:${rule.field ?? 'fixed'}`,
      kind: 'loading',
      deltaXaf: delta.toString(),
      runningXaf: running.toString(),
    });
  }

  // --- pass 3: discounts --------------------------------------------------
  for (const rule of table.rules) {
    if (rule.kind !== 'discount') continue;
    const multiplier = rule.values[String(factors[rule.field])];
    if (multiplier === undefined || multiplier === 1) continue;

    running = applyRate(running, multiplier);
    breakdown.push({
      label: `discount:${rule.field}`,
      kind: 'discount',
      multiplier,
      runningXaf: running.toString(),
    });
  }

  // --- pass 4: clamp ------------------------------------------------------
  const min = table.minPremiumXaf !== undefined ? xaf(table.minPremiumXaf) : null;
  const max = table.maxPremiumXaf !== undefined ? xaf(table.maxPremiumXaf) : null;

  if (min !== null && running < min) {
    running = min;
    breakdown.push({ label: 'clamp:minimum', kind: 'clamp', runningXaf: running.toString() });
  }
  if (max !== null && running > max) {
    running = max;
    breakdown.push({ label: 'clamp:maximum', kind: 'clamp', runningXaf: running.toString() });
  }

  return { premiumXaf: running, breakdown };
}
