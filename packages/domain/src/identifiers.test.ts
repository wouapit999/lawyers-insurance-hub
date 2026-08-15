import {
  beneficiaryCardNumber, claimNumber, invoiceNumber, isValidReference, policyNumber,
} from './identifiers';

/**
 * These numbers are printed on documents an advocate may present to a court
 * and quoted down a phone line to support. They must be unambiguous, stable,
 * and readable aloud.
 */
describe('policyNumber()', () => {
  it('formats as LIH-PRODUCT-YEAR-SEQUENCE', () => {
    expectEqual(policyNumber('PLI', 2026, 123), 'LIH-PLI-2026-000123');
  });

  it('pads the sequence to six digits so references sort and align', () => {
    expectEqual(policyNumber('VEH', 2026, 1), 'LIH-VEH-2026-000001');
    expectEqual(policyNumber('MED', 2026, 999999), 'LIH-MED-2026-999999');
  });

  it('does not truncate a sequence that outgrows six digits', () => {
    // Better a longer reference than two policies sharing a number.
    expectEqual(policyNumber('PLI', 2026, 1234567), 'LIH-PLI-2026-1234567');
  });
});

describe('claimNumber() and invoiceNumber()', () => {
  it('format consistently with each other', () => {
    expectEqual(claimNumber(2026, 42), 'CLM-2026-000042');
    expectEqual(invoiceNumber(2026, 42), 'INV-2026-000042');
  });

  it('use distinct prefixes so a reference is never ambiguous', () => {
    // Support asks "what is your reference"; the prefix alone must identify
    // which record is meant.
    const claim = claimNumber(2026, 1);
    const invoice = invoiceNumber(2026, 1);
    expectOk(claim !== invoice);
    expectOk(claim.startsWith('CLM-'));
    expectOk(invoice.startsWith('INV-'));
  });
});

describe('beneficiaryCardNumber()', () => {
  it('derives from the Bar number and an ordinal', () => {
    expectEqual(beneficiaryCardNumber('CM/BAR/2016/0412', 1), 'BEN-CMBAR20160412-01');
  });

  it('strips punctuation so the number survives being typed at a clinic', () => {
    expectEqual(beneficiaryCardNumber('cm-bar-2016.0412', 2), 'BEN-CMBAR20160412-02');
  });

  it('gives each dependant a distinct card', () => {
    const first = beneficiaryCardNumber('CM/BAR/2016/0412', 1);
    const second = beneficiaryCardNumber('CM/BAR/2016/0412', 2);
    expectOk(first !== second);
  });
});

describe('isValidReference()', () => {
  it('accepts references this module produced', () => {
    expectEqual(isValidReference('policy', policyNumber('PLI', 2026, 123)), true);
    expectEqual(isValidReference('claim', claimNumber(2026, 42)), true);
    expectEqual(isValidReference('invoice', invoiceNumber(2026, 42)), true);
  });

  it('rejects a reference of the wrong kind', () => {
    // Pasting a claim number into a policy lookup should fail fast rather
    // than return an empty result that looks like "no such policy".
    expectEqual(isValidReference('policy', claimNumber(2026, 42)), false);
    expectEqual(isValidReference('claim', invoiceNumber(2026, 42)), false);
  });

  it('rejects malformed and unknown-product references', () => {
    expectEqual(isValidReference('policy', 'LIH-XXX-2026-000123'), false);
    expectEqual(isValidReference('policy', 'LIH-PLI-2026-123'), false);
    expectEqual(isValidReference('claim', 'CLM-26-000042'), false);
    expectEqual(isValidReference('policy', ''), false);
  });
});
