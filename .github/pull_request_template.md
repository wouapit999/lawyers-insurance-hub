# What changes

<!-- One sentence, in plain language: what is different for a user or an operator? -->

Closes #

## Type

- [ ] Feature
- [ ] Fix
- [ ] Refactor (no behaviour change)
- [ ] Infrastructure / CI
- [ ] Documentation
- [ ] Security

---

## Blast radius

Tick anything this touches. **Any tick here requires a second reviewer** — these
are the areas where a mistake costs money, cover or a regulatory finding.

- [ ] **Money** — amounts, rating, installments, ledger
- [ ] **Payments** — providers, webhooks, settlement, refunds
- [ ] **Permissions or roles** — RBAC, guards, scopes
- [ ] **State machines** — policy or claim lifecycle
- [ ] **Personal data** — identity numbers, encryption, masking
- [ ] **Database migration**
- [ ] **None of the above**

## Checks

- [ ] `npm test` passes locally
- [ ] `npx tsc --noEmit` clean in every workspace I touched
- [ ] New behaviour has a test; a bug fix has a test that failed before it
- [ ] No secret, key or real member data in the diff

## Bilingual

- [ ] Every new user-facing string exists in **both** `en` and `fr`
- [ ] Checked the French layout (French runs ~20% longer than English)
- [ ] Not applicable — no user-facing strings

## Migration

Skip if no schema change.

- [ ] **Additive only** — no dropped or renamed column. Blue-green runs old and
      new code against one schema, so a destructive migration breaks the
      version still serving traffic
- [ ] Tested against a seeded database
- [ ] Rollback considered: the previous image still works against this schema

## Money changes

Skip unless the money box is ticked.

- [ ] Amounts stay `bigint` / whole XAF francs — no float, no `Decimal`
- [ ] Installments still sum exactly back to the premium
- [ ] Rating changes are a **new rating table version**, never an edit of an
      existing one
- [ ] Idempotency preserved on any payment-mutating path

## Screenshots

<!-- For UI changes, post both locales. French first. -->

## Notes for the reviewer

<!-- What deserves the closest look? Anything you are unsure about? -->
