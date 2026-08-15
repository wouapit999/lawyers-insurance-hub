# ADR 0002 — Money as whole-franc integers

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

Every amount in the system is in XAF (Central African CFA franc). XAF has **no
minor unit** — there is no centime in circulation, and CEMAC prices are quoted
in whole francs.

## Decision

Represent money as integers of whole francs everywhere:

| Layer | Type |
|---|---|
| PostgreSQL | `bigint` |
| TypeScript | `bigint` |
| Dart (Flutter) | `int` |
| JSON over the wire | **string**, e.g. `"285000"` |

Floating-point types are prohibited for monetary values. `Decimal` is not used
either: there are no fractional francs to represent, so it adds cost with no
benefit.

## Why a string on the wire

JSON numbers are IEEE-754 doubles in every JavaScript client. Sending `285000`
as a number invites a client to parse, arithmetic and re-serialise it as a
float, which reintroduces precisely the imprecision the integer exists to
prevent. A string cannot be accidentally arithmetic'd — the client must
consciously convert, and the conversion function returns `bigint`.

`BigInt.prototype.toJSON` is installed once at the API's bootstrap so this is
automatic rather than remembered per endpoint.

## Consequences for arithmetic

Two operations need care and both live in `packages/domain/src/money/xaf.ts`:

**Applying a rate** (a 1.15 risk loading). Rates are decimals; amounts are not.
`applyRate` scales the rate to a fixed 6-decimal integer, multiplies, and rounds
half-up to the franc. The result is deterministic and reproducible years later,
which matters because a rating breakdown is stored and may be re-examined in a
dispute.

**Splitting into installments.** `splitEvenly` guarantees the parts sum exactly
back to the premium, distributing the remainder one franc at a time across the
earliest installments. A 285,001 XAF premium in 4 parts is 71,251 / 71,250 /
71,250 / 71,250 — the customer is never billed a franc more than the premium,
and reconciliation never comes up short. This is property-tested across many
amount/part combinations.

## Formatting

`formatXaf` groups thousands with U+202F (narrow no-break space) and appends
`XAF`. Grouping is done by hand rather than through `Intl.NumberFormat`, because
that API's separator for `fr-CM` varies between ICU versions and Node builds.
The identical algorithm is implemented in `apps/mobile/lib/core/money.dart`.

The reason is concrete: the same premium appears on the API-generated PDF
certificate, in the web app and on the handset. A lawyer presenting cover to a
court should not see three different-looking numbers.

## Database constraints

Positivity is enforced in the schema, not only in code, because a negative or
zero premium is a financial incident rather than a validation error:

```sql
ALTER TABLE policies ADD CONSTRAINT policies_premium_positive CHECK (premium_xaf > 0);
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive  CHECK (amount_xaf > 0);
ALTER TABLE claims   ADD CONSTRAINT claims_approved_within_claimed
  CHECK (approved_xaf IS NULL OR claimed_xaf IS NULL OR approved_xaf <= claimed_xaf);
```

## If a currency with a minor unit is ever added

Phase 3 multi-tenancy could bring a tenant outside CEMAC. At that point add a
`currency` column and a per-currency `minor_unit` scale, and store amounts in
minor units. Do not retrofit floats. The `Xaf` type would become `Money
{ amount: bigint, currency: string }` and the arithmetic helpers already isolate
every place that would need to change.
