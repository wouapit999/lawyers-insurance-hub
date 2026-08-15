import { xaf, applyRate, splitEvenly, formatXaf, add, MoneyError, GROUP_SEPARATOR } from './xaf';

describe('xaf()', () => {
  it('accepts whole francs from every input form', () => {
    expectEqual(xaf(285000), 285000n);
    expectEqual(xaf('285000'), 285000n);
    expectEqual(xaf(285000n), 285000n);
  });

  it('rejects fractional amounts — XAF has no minor unit', () => {
    expectThrows(() => xaf(285000.5), MoneyError);
    expectThrows(() => xaf('285000.50'), MoneyError);
  });

  it('rejects non-finite amounts', () => {
    expectThrows(() => xaf(Number.NaN), MoneyError);
    expectThrows(() => xaf(Number.POSITIVE_INFINITY), MoneyError);
  });
});

describe('applyRate()', () => {
  it('applies a risk loading and rounds half-up to the franc', () => {
    expectEqual(applyRate(200000n, 1.15), 230000n);
    // 100001 * 1.005 = 100501.005 -> 100501
    expectEqual(applyRate(100001n, 1.005), 100501n);
  });

  it('is exact where floating point would not be', () => {
    // 0.1 + 0.2 style drift must not reach the premium.
    const result = applyRate(70000n, 1.1);
    expectEqual(result, 77000n);
  });

  it('rejects negative rates', () => {
    expectThrows(() => applyRate(1000n, -1), MoneyError);
  });
});

describe('splitEvenly()', () => {
  it('splits an exactly divisible premium', () => {
    expectDeepEqual(splitEvenly(285000n, 4), [71250n, 71250n, 71250n, 71250n]);
  });

  it('distributes the remainder across the earliest installments', () => {
    const parts = splitEvenly(285001n, 4);
    expectDeepEqual(parts, [71251n, 71250n, 71250n, 71250n]);
  });

  it('always sums back to the original premium — no franc created or lost', () => {
    for (const amount of [1n, 7n, 285001n, 999999n, 1234567n]) {
      for (const n of [1, 2, 3, 4, 12]) {
        const total = splitEvenly(amount, n).reduce(add, 0n);
        expectEqual(total, amount, `${amount} split ${n} ways must sum back`);
      }
    }
  });

  it('rejects a nonsensical installment count', () => {
    expectThrows(() => splitEvenly(1000n, 0), MoneyError);
    expectThrows(() => splitEvenly(1000n, 1.5), MoneyError);
  });
});

describe('formatXaf()', () => {
  it('groups thousands and puts the currency last, with no decimals', () => {
    expectEqual(formatXaf(285000n, 'fr'), `285${GROUP_SEPARATOR}000 XAF`);
    expectOk(!formatXaf(285000n, 'en').includes('.'), 'never renders a decimal separator');
  });

  it('renders identically in both locales, on every runtime', () => {
    // The certificate PDF, the web app and the mobile app must agree
    // character for character. Intl's separator is not stable enough to rely
    // on, so this pins the contract.
    expectEqual(formatXaf(1234567n, 'fr'), formatXaf(1234567n, 'en'));
    expectEqual(
      formatXaf(1234567n),
      `1${GROUP_SEPARATOR}234${GROUP_SEPARATOR}567 XAF`,
    );
  });

  it('handles values that do not need grouping', () => {
    expectEqual(formatXaf(0n), '0 XAF');
    expectEqual(formatXaf(999n), '999 XAF');
    expectEqual(formatXaf(1000n), `1${GROUP_SEPARATOR}000 XAF`);
  });

  it('keeps the sign in front for reversals and refunds', () => {
    expectEqual(formatXaf(-71250n), `-71${GROUP_SEPARATOR}250 XAF`);
  });
});
