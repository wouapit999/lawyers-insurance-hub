# Lawyers Insurance Hub

Insurance platform for members of the **Cameroon Bar Association**. Bilingual
(French / English), XAF-denominated, with mobile-money-first payment collection.

Designed and built by **Roland Wouapit** — Bouquet Innovation.

---

## What is here

| Path | What it is | State |
|---|---|---|
| `backend` | NestJS API — auth, onboarding, catalogue, policies, claims, payments | Compiles, typechecks, tested |
| `packages/domain` | Pure business logic — money, state machines, rating engine, RBAC | 37 tests passing |
| `frontend-web` | Next.js bilingual web app | API client + message catalogues |
| `mobile-app` | Flutter app (Android / iOS) | Core layer: money, API client, offline design |
| `backend/prisma` | PostgreSQL schema, RLS/partitioning SQL, seed | Schema validates, client generates |

## Getting started

```bash
npm install
```

```bash
cp .env.example .env
```

Generate the two JWT secrets and the PII key, then paste them into `.env`:

```bash
node -e "const c=require('crypto');console.log('JWT_ACCESS_SECRET='+c.randomBytes(48).toString('base64'));console.log('JWT_REFRESH_SECRET='+c.randomBytes(48).toString('base64'));console.log('PII_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'))"
```

Start Postgres and Redis:

```bash
docker compose up -d postgres redis
```

Create the schema. The order matters — the extensions and the `uuid_generate_v7()`
function must exist before the tables that default to them, and the row-level
security policies must be applied after the tables exist:

```bash
cd backend && node scripts/apply-sql.js pre && npx prisma migrate dev --name init && node scripts/apply-sql.js post && npx ts-node prisma/seed.ts
```

Run the API:

```bash
npm run api:dev
```

OpenAPI documentation is then at `http://localhost:3000/v1/docs`.

### Demo accounts (development only)

Seeded with the password `Demo-Passw0rd-2026`:

| Email | Role |
|---|---|
| `avocat@demo.lih.cm` | Lawyer (pre-verified) |
| `barreau@demo.lih.cm` | Bar Association administrator |
| `sinistres@demo.lih.cm` | Claims officer |
| `finance@demo.lih.cm` | Finance officer |
| `manager@demo.lih.cm` | Insurance manager |

## Tests

```bash
npm test
```

## Architecture

### Modular monolith, service-shaped

The approved architecture specifies twelve microservices. This codebase
implements them as **twelve modules in one deployable**, with the boundaries
drawn exactly where the service boundaries are.

The reasoning: at the MVP's target of 1,500 users and 2,000 policies, twelve
separately deployed services buy distributed-systems problems — partial
failure, cross-service transactions, twelve pipelines — and no capacity that a
single autoscaled deployment does not already provide. What actually matters is
that the *boundaries* are real, because those are expensive to add later and
cheap to keep now.

So the discipline is enforced rather than assumed:

- A module never reads another module's tables. It calls the other module's
  exported service, or it consumes a domain event.
- Every state change writes to the **transactional outbox** (`outbox_events`)
  in the same transaction as the change itself. When a module is extracted, the
  relay publishes to RabbitMQ and the consumer moves — no event is lost in the
  migration because none was ever emitted outside a transaction.
- Business rules live in `packages/domain`, which imports nothing from NestJS or
  Prisma. Pricing, lifecycle legality and permission scoping are testable, and
  tested, with no database.

Extraction is then a deployment change: lift a module directory, point it at its
own schema, swap the in-process service call for the event it already emits.

### Where the invariants live

| Invariant | Enforced by |
|---|---|
| No policy is active before money arrives | `policies:activate:system`, held by no human role — only the payment module's settlement transaction |
| Installments sum exactly to the premium | `splitEvenly()`, property-tested |
| A premium can be explained years later | The rating breakdown is persisted on the quote and the policy |
| A tenant cannot read another's rows | PostgreSQL row-level security keyed to the JWT tenant claim |
| A payment is never charged twice | Unique constraint on `idempotency_key` |
| A settled payment really settled | Every webhook is HMAC-verified, then confirmed with the provider before the ledger moves |
| The audit trail cannot be edited | Append-only trigger on `audit_logs`, partitioned monthly |

### Money

XAF has no minor unit. Every amount is a whole number of francs, carried as
`BigInt` in TypeScript, `bigint` in PostgreSQL and `int` in Dart. Amounts cross
the API as **strings** (`"285000"`), because a JavaScript client parsing them as
numbers reintroduces exactly the float imprecision the integer type exists to
prevent.

Formatting is pinned to a narrow no-break space in all three codebases rather
than delegated to `Intl`, whose separator for `fr-CM` varies by ICU build. The
same premium must render identically on a certificate, in the browser and on a
handset.

### Bilingualism

French is the default. The locale travels on `Accept-Language`, and the API
returns already-translated strings — including error messages — so no client
maintains a second copy of the API's vocabulary. Product and plan names are
stored in paired `*_en` / `*_fr` columns, served in one query without a join.

## Documentation

- [`docs/adr/`](docs/adr) — architecture decision records
- [`docs/api.md`](docs/api.md) — API conventions
- `/v1/docs` — live OpenAPI (Swagger UI) once the API is running

## Not yet built

Stated plainly so the next engineer is not surprised:

- **Documents module** — the schema, storage design and OCR columns exist; the
  upload/OCR/e-signature service does not.
- **Notifications** — the table, dedupe key and templates exist; the email/SMS/
  WhatsApp dispatchers are stubs that log.
- **Outbox relay** — events are written correctly; the RabbitMQ publisher that
  drains them is not written.
- **Web and mobile UI** — the API client, money handling and message catalogues
  are real; the screens are not built.
- **Admin portal** — RBAC, audit and product management exist as API endpoints;
  the portal UI does not.
- **Certificates** — the PDF/A renderer is designed (headless Chromium) but not
  implemented.
