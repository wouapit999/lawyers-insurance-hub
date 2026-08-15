# ADR 0001 — Modular monolith with service-shaped boundaries

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** Chief Software Architect, Roland Wouapit (Bouquet Innovation)

## Context

The approved architecture specifies twelve microservices on AKS: identity,
member, policy, claims, payment, document, notification, support, reporting,
admin, ai, and an API gateway.

The MVP targets 1,500 verified lawyers, 2,000 active policies and bursts of
roughly 50 payments per minute at renewal peaks. The team is twelve people,
one of whom is the DevOps engineer.

## Decision

Implement the twelve services as twelve **modules inside one deployable**,
with module boundaries drawn exactly where the service boundaries would be,
and enforce those boundaries from day one.

## Rationale

At this load, twelve separately deployed services provide no capacity a single
autoscaled deployment does not, and they cost:

- Twelve pipelines, twelve images, twelve sets of dashboards and alerts, owned
  by one DevOps engineer.
- Distributed transactions across the one flow that must not be partially
  applied — settle payment, mark installment paid, write the ledger, activate
  cover. In one process that is a database transaction. Across services it is a
  saga with compensations, and each compensation is a chance to leave a lawyer
  paid but uncovered.
- Debugging a payment failure across four network hops during the first weeks
  of live money movement.

What genuinely is expensive to retrofit is not the deployment topology — it is
the *boundaries*. Code that reaches across domains, shares tables and passes
entities around cannot be pulled apart later at any price. So the boundaries are
what we buy now.

## Enforcement

1. **No cross-module table access.** A module talks to another through its
   exported service or through a domain event. Reviews reject a Prisma query
   against another module's tables.
2. **Transactional outbox.** Every state change writes an `outbox_events` row in
   the same transaction. The event exists whether or not a broker does; today an
   in-process relay could consume it, tomorrow RabbitMQ does. Nothing changes on
   the producing side at extraction.
3. **Domain logic is framework-free.** `packages/domain` imports neither NestJS
   nor Prisma. Pricing, state-machine legality and permission scoping are pure
   functions, unit-tested without a database, and move with whichever service
   ends up owning them.
4. **Per-module schema ownership.** Each module owns its tables. Foreign keys
   across module boundaries are permitted now and are the documented cut points
   later.

## Extraction path

When a module needs independent scaling — `payment` under renewal-day load and
`ai` under model inference are the likely first two:

1. Copy the module directory into its own NestJS app.
2. Point it at its own schema; replace cross-boundary foreign keys with ids.
3. Replace the in-process service call with a subscription to the event the
   module already emits.
4. Route its paths at API Management.

Steps 1, 2 and 4 are mechanical. Step 3 is already prepared.

## Consequences

**Accepted:**

- One deployment is a single blast radius. Mitigated by health probes, an
  autoscaled replica count above one, and blue-green deploys with automatic
  rollback on SLO breach.
- Module discipline depends on review, not on the network refusing the call.
  Mitigated by the enforcement rules above being explicit review criteria.

**Gained:**

- The payment-settlement flow is one ACID transaction rather than a saga, during
  the period when the system is newest and the money is realest.
- One pipeline and one set of dashboards for a team with one DevOps engineer.
- The Phase 3 multi-tenant work operates on one schema with row-level security
  rather than twelve.

## Revisit when

Any of: a single module needs materially different scaling from the rest;
deployment coupling starts delaying releases; the team passes roughly 25
engineers; or sustained load approaches ten times the Year 2 forecast.
