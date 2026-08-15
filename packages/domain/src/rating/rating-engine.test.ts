import { rate, RatingError, type RatingTableDefinition } from './rating-engine';

/** A realistic professional-liability table, close to what underwriting seeds. */
const PLI_TABLE: RatingTableDefinition = {
  rules: [
    {
      kind: 'lookup',
      field: 'practice_areas',
      values: { criminal: 1.35, litigation: 1.25, corporate: 1.0, notarial: 0.95 },
      default: 1.1,
    },
    {
      kind: 'band',
      field: 'years_admitted',
      bands: [
        { max: 3, multiplier: 1.2 },
        { min: 3, max: 10, multiplier: 1.0 },
        { min: 10, multiplier: 0.9 },
      ],
    },
    {
      kind: 'band',
      field: 'firm_size',
      bands: [
        { max: 2, multiplier: 1.0 },
        { min: 2, max: 10, multiplier: 1.15 },
        { min: 10, multiplier: 1.3 },
      ],
    },
    { kind: 'flag', field: 'prior_claims', whenTrue: 1.25 },
    { kind: 'loading', field: 'extended_cover', amountXaf: 25000, when: true },
    { kind: 'discount', field: 'multi_policy', values: { true: 0.9 } },
  ],
  minPremiumXaf: 50000,
  maxPremiumXaf: 5000000,
};

describe('rating engine', () => {
  it('prices a mid-career corporate lawyer at a small firm', () => {
    const { premiumXaf, breakdown } = rate(200000n, PLI_TABLE, {
      practice_areas: 'corporate',
      years_admitted: 8,
      firm_size: 4,
      prior_claims: false,
      multi_policy: false,
    });

    // 200000 * 1.0 (corporate) * 1.0 (8 yrs) * 1.15 (firm of 4) = 230000
    expectEqual(premiumXaf, 230000n);
    expectEqual(breakdown[0]?.kind, 'base');
    expectOk(breakdown.some((l) => l.label === 'band:firm_size'));
  });

  it('applies loadings after multipliers and discounts last', () => {
    const { premiumXaf } = rate(200000n, PLI_TABLE, {
      practice_areas: 'criminal',
      years_admitted: 2,
      firm_size: 1,
      prior_claims: false,
      extended_cover: true,
      multi_policy: 'true',
    });

    // 200000 * 1.35 = 270000
    //        * 1.2  = 324000   (under 3 years admitted)
    //        * 1.0  = 324000   (solo)
    //        + 25000 = 349000  (loading, additive, after multipliers)
    //        * 0.9  = 314100   (discount, last)
    expectEqual(premiumXaf, 314100n);
  });

  it('takes the riskiest area when a lawyer practises several', () => {
    const { premiumXaf } = rate(100000n, PLI_TABLE, {
      practice_areas: ['corporate', 'criminal'] as unknown as string,
      years_admitted: 15,
      firm_size: 1,
      prior_claims: false,
      multi_policy: false,
    });
    // criminal (1.35) wins over corporate (1.0); 15 years -> 0.9
    // 100000 * 1.35 * 0.9 = 121500
    expectEqual(premiumXaf, 121500n);
  });

  it('clamps to the floor so no policy is written below cost', () => {
    const { premiumXaf, breakdown } = rate(40000n, PLI_TABLE, {
      practice_areas: 'notarial',
      years_admitted: 20,
      firm_size: 1,
      prior_claims: false,
      multi_policy: true,
    });
    expectEqual(premiumXaf, 50000n);
    expectOk(breakdown.some((l) => l.label === 'clamp:minimum'));
  });

  it('records every step so a premium can be explained years later', () => {
    const { breakdown } = rate(200000n, PLI_TABLE, {
      practice_areas: 'litigation',
      years_admitted: 1,
      firm_size: 12,
      prior_claims: true,
      multi_policy: false,
    });
    const labels = breakdown.map((l) => l.label);
    expectDeepEqual(labels, [
      'base_premium',
      'lookup:practice_areas',
      'band:years_admitted',
      'band:firm_size',
      'flag:prior_claims',
    ]);
    // 200000 * 1.25 (litigation) * 1.2 (1 yr) * 1.3 (firm of 12) * 1.25
    // (prior claims) = 487500. The running total on the last breakdown line
    // is always the returned premium.
    expectEqual(breakdown.at(-1)?.runningXaf, '487500');
  });

  it('refuses to guess when a factor is unknown and no default exists', () => {
    const strict: RatingTableDefinition = {
      rules: [{ kind: 'lookup', field: 'region', values: { littoral: 1.0 } }],
    };
    expectThrows(
      () => rate(100000n, strict, { region: 'adamaoua' }),
      RatingError,
      'an unpriced risk must fail loudly, never default silently',
    );
  });

  it('rejects a non-numeric value where a band is expected', () => {
    expectThrows(
      () => rate(100000n, PLI_TABLE, {
        practice_areas: 'corporate',
        years_admitted: 'eight',
        firm_size: 1,
        prior_claims: false,
        multi_policy: false,
      }),
      RatingError,
    );
  });

  it('rejects a non-positive base premium', () => {
    expectThrows(() => rate(0n, PLI_TABLE, {}), RatingError);
  });
});
