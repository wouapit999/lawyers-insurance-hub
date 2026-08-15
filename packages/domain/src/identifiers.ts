/**
 * Human-facing reference numbers.
 *
 * These appear on certificates a lawyer may present to a court, so they must
 * be readable aloud, unambiguous, and stable forever. The sequence component
 * is allocated by a Postgres sequence per (product, year); it is passed in
 * rather than generated here so this module stays pure and testable.
 */

export type ProductCode =
  | 'PLI' | 'PRAC' | 'MED' | 'FAM' | 'PERS' | 'ACC' | 'VEH' | 'FIRM' | 'PROP';

/** LIH-PLI-2026-000123 */
export function policyNumber(product: ProductCode, year: number, sequence: number): string {
  return `LIH-${product}-${year}-${String(sequence).padStart(6, '0')}`;
}

/** CLM-2026-000042 */
export function claimNumber(year: number, sequence: number): string {
  return `CLM-${year}-${String(sequence).padStart(6, '0')}`;
}

/** INV-2026-000042 */
export function invoiceNumber(year: number, sequence: number): string {
  return `INV-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * Beneficiary card number: BEN-<lawyer bar number>-<ordinal>.
 * Printed on the physical card a family member presents at a clinic.
 */
export function beneficiaryCardNumber(barNumber: string, ordinal: number): string {
  const clean = barNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return `BEN-${clean}-${String(ordinal).padStart(2, '0')}`;
}

const REFERENCE_PATTERNS = {
  policy: /^LIH-(PLI|PRAC|MED|FAM|PERS|ACC|VEH|FIRM|PROP)-\d{4}-\d{6}$/,
  claim: /^CLM-\d{4}-\d{6}$/,
  invoice: /^INV-\d{4}-\d{6}$/,
} as const;

export function isValidReference(kind: keyof typeof REFERENCE_PATTERNS, value: string): boolean {
  return REFERENCE_PATTERNS[kind].test(value);
}
