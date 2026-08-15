# Contributing — Guide de contribution

Thank you for working on Lawyers Insurance Hub. This is a regulated financial
product, so a few rules here are stricter than on a typical project. Where that
is true, the reason is stated — follow the reasoning, not just the rule.

---

## Branching model

```
production  ← tagged releases only, protected, deploys to prod
   ↑
staging     ← release candidates, deploys to staging, UAT happens here
   ↑
develop     ← integration branch, deploys to dev
   ↑
main        ← default branch; the trunk feature branches cut from
   ↑
feature/*   fix/*   hotfix/*   chore/*
```

| Branch | Deploys to | Protected | Who merges |
|---|---|---|---|
| `main` | — | ✅ 1 review + CI green | Any maintainer |
| `develop` | dev.lih.cm | ✅ CI green | Any maintainer |
| `staging` | staging.lih.cm | ✅ 1 review + CI green | Tech lead |
| `production` | api.lih.cm / app.lih.cm | ✅ 2 reviews + CI + manual approval | Tech lead only |

Branch names: `feature/LIH-123-mtn-momo-retry`, `fix/LIH-140-quote-expiry`.
A `hotfix/*` may target `production` directly; it must be back-merged into
`main` in the same PR series or the fix is lost at the next release.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(payments): retry MoMo collection three times over 72 hours
fix(claims): reject incidents dated before cover began
docs(adr): record the modular-monolith decision
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`. Scopes match the module: `auth`, `onboarding`,
`catalogue`, `policies`, `claims`, `payments`, `domain`, `infra`, `mobile`,
`web`.

---

## Before you open a pull request

```bash
npm test
```

```bash
cd backend && npx tsc -p tsconfig.json --noEmit && npx nest build
```

Both must pass. CI runs the same commands, so a failure here is a failure
there.

---

## Rules that are not negotiable

These exist because breaking them causes financial or regulatory harm, not
because of style preference.

### 1. Money is integer XAF

Never introduce a `number`, `float` or `Decimal` for a monetary value. XAF has
no minor unit; amounts are whole francs as `bigint` / `int`, and cross the wire
as **strings**. See [ADR 0002](docs/adr/0002-money-as-integer-xaf.md).

### 2. Module boundaries hold

A module does not read another module's tables. Use the other module's exported
service, or consume its domain event. A PR containing a Prisma query against
another module's tables will be rejected — this is what keeps service
extraction cheap. See [ADR 0001](docs/adr/0001-modular-monolith-with-service-boundaries.md).

### 3. State changes go through the state machine

Never assign `policy.status` or `claim.status` directly. Call
`applyTransition()` / `applyClaimTransition()`. They decide legality and
permission together, so a caller cannot check one and forget the other.

### 4. Every state change writes an outbox event and an audit row

In the *same transaction* as the change. An audit row for something that rolled
back is a false record; a missing one is a gap in evidence a regulator will ask
about.

### 5. Authorisation is deny-by-default

New routes are authenticated automatically. Add `@RequirePermissions(...)` for
the specific permission. Only add `@Public()` when the route genuinely must be
open (health, webhooks, catalogue) and say why in the PR.

### 6. Nothing user-facing is monolingual

Every string a member can see exists in `en` and `fr`. The API returns
translated messages; clients do not keep a second copy of them. French runs
~20% longer than English — check layouts in French first.

### 7. Secrets never enter the repository

Not in code, not in tests, not in CI variables, not in a commented-out line.
They come from Azure Key Vault. If you commit one by accident, treat it as
compromised: rotate it, then rewrite history.

---

## Tests

| Change | Required |
|---|---|
| Rating, money, state machines | Unit tests. These are near-100% covered and must stay so |
| A new endpoint | At least one spec covering the authorisation path |
| A bug fix | A test that fails before the fix |
| Payment flows | A test for the duplicate/replayed case, not just the happy path |

Write assertions about behaviour, not implementation. `expect(premium).toBe(230000n)`
is a contract; `expect(spy).toHaveBeenCalled()` usually is not.

---

## Pull requests

Fill in the template. In particular:

- **What changes for a user** — in one sentence, in plain language.
- **Money, permissions or state machines touched?** If yes, a second reviewer
  is required.
- **Migration included?** Additive only. The blue-green deploy runs old and new
  code against one schema, so a dropped or renamed column breaks the running
  version. Expand → migrate → contract, across three releases.

Review turnaround: 2 business days. Security-labelled PRs: same day.

---

## En français

Ce projet accepte les contributions en français. Les messages de commit, les
descriptions de PR et les commentaires de revue peuvent être rédigés dans l'une
ou l'autre langue.

Les règles ci-dessus restent valables : montants en francs entiers, frontières
de modules respectées, transitions d'état via la machine à états, journal
d'audit systématique, autorisation refusée par défaut, bilinguisme intégral, et
aucun secret dans le dépôt.

Toute chaîne visible par un membre doit exister en anglais **et** en français.
Le texte français étant environ 20 % plus long, vérifiez les mises en page en
français d'abord.
