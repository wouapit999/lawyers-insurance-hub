/**
 * XAF money handling.
 *
 * The Central African CFA franc has no minor unit — there is no such thing as
 * a centime in circulation. So every amount in this system is an integer
 * number of whole francs, carried as `bigint`.
 *
 * This is not a stylistic choice. Using a float for money means 71250 / 3
 * silently becomes 23749.999999999996, and an installment plan that doesn't
 * sum back to the premium is a customer dispute and an audit finding. The
 * type system is doing real work here: `bigint` cannot be accidentally
 * multiplied by a float without a compile error.
 */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Whole francs. Always non-negative for premiums and payments. */
export type Xaf = bigint;

export function xaf(value: number | string | bigint): Xaf {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value.trim())) {
      throw new MoneyError(`Not a whole-franc amount: "${value}"`);
    }
    return BigInt(value.trim());
  }
  if (!Number.isFinite(value)) {
    throw new MoneyError(`Not a finite amount: ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `XAF has no minor unit; ${value} is not a whole number of francs`,
    );
  }
  return BigInt(value);
}

export function isPositive(a: Xaf): boolean {
  return a > 0n;
}

export function add(a: Xaf, b: Xaf): Xaf {
  return a + b;
}

export function subtract(a: Xaf, b: Xaf): Xaf {
  return a - b;
}

/**
 * Multiply by a rate (e.g. a 1.15 risk loading), rounding half-up to the franc.
 *
 * Rates arrive from rating tables as decimals. We convert through a fixed
 * 6-decimal scale rather than touching floating point on the money value
 * itself, so the result is deterministic and reproducible years later when
 * someone asks why a premium was what it was.
 */
export function applyRate(amount: Xaf, rate: number): Xaf {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new MoneyError(`Invalid rate: ${rate}`);
  }
  const SCALE = 1_000_000n;
  const scaledRate = BigInt(Math.round(rate * 1_000_000));
  const product = amount * scaledRate;
  // round half-up
  return (product + SCALE / 2n) / SCALE;
}

/**
 * Split an amount into `parts` installments that sum EXACTLY back to it.
 *
 * The remainder is distributed one franc at a time across the earliest
 * installments rather than being dropped or dumped on the last one. Paying
 * 4 installments of a 285,001 XAF premium gives 71,251 / 71,250 / 71,250 /
 * 71,250 — the customer is never asked for a franc more than the premium,
 * and the schedule never comes up a franc short at reconciliation.
 */
export function splitEvenly(amount: Xaf, parts: number): Xaf[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(`Installment count must be a positive integer, got ${parts}`);
  }
  if (amount < 0n) {
    throw new MoneyError('Cannot split a negative amount');
  }
  const n = BigInt(parts);
  const base = amount / n;
  const remainder = amount - base * n; // 0 <= remainder < parts

  const out: Xaf[] = [];
  for (let i = 0; i < parts; i++) {
    out.push(BigInt(i) < remainder ? base + 1n : base);
  }
  return out;
}

/** Narrow no-break space (U+202F) — the thousands separator in both locales. */
export const GROUP_SEPARATOR = ' ';

/**
 * Format for display: "285 000 XAF".
 *
 * Grouping is done by hand rather than through Intl. Intl's separator for
 * fr-CM varies between ICU versions and Node builds — sometimes U+00A0,
 * sometimes U+202F, sometimes a plain space. A premium that renders one way
 * in the API's PDF certificate and another way in the mobile app looks like
 * two different numbers to a lawyer presenting cover to a court, so the
 * separator is pinned here and is identical on every runtime.
 *
 * Both Cameroonian locales group in threes and put the currency last, so the
 * locale argument changes nothing today; it is kept so callers already pass
 * it if a future locale needs different treatment.
 */
export function formatXaf(amount: Xaf, _locale: 'en' | 'fr' = 'fr'): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();

  let grouped = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += GROUP_SEPARATOR;
    grouped += digits[i];
  }

  return `${negative ? '-' : ''}${grouped} XAF`;
}

/** JSON-safe serialisation — bigint has no JSON representation. */
export function toJson(amount: Xaf): string {
  return amount.toString();
}
