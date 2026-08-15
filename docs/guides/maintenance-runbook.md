# Maintenance runbook

On-call reference. Everything here assumes `kubectl` is pointed at production:

```bash
az aks get-credentials -g lih-rg-production -n lih-aks-production
```

---

## Daily

| Check | How |
|---|---|
| Overnight reconciliation clean | Finance dashboard → orphans and mismatches both zero |
| Failed payments | `payments` where `status='failed'` in the last 24 h |
| Claims breaching SLA | Claims dashboard → `breached` count |
| Bar verifications over 24 h | Bar portal queue — these escalate |
| Error rate | App Insights → failures, last 24 h |

```bash
kubectl -n lih-production get pods -l app=lih-api
```

## Weekly

- Dependabot pull requests — merge patch and minor after CI passes
- Postgres slow queries: `SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 20;`
- Certificate expiry: `kubectl -n lih-production get certificate`
- Backup verification — confirm the latest restore point is recent
- Review the week's `audit_logs` for administrative overrides

## Monthly

- Rehearse a rollback on staging
- Review autoscaler behaviour against actual traffic
- Cost review in Azure Cost Management
- Rotate any secret that has reached its interval (see the security checklist)
- Confirm audit partitions exist for the coming months:

```bash
psql "$DATABASE_URL" -c "SELECT tablename FROM pg_tables WHERE tablename LIKE 'audit_logs_%' ORDER BY tablename DESC LIMIT 5;"
```

The provisioning SQL creates twelve months ahead. If the newest partition is
less than three months out, re-run `apply-sql.js post`.

## Quarterly

- Point-in-time restore test → record in `docs/dr-tests/`
- Access review: every back-office account, every role grant
- Dependency audit including transitive: `npm audit --omit=dev`
- Review rate limits against real traffic

---

# Incident procedures

## API returning 5xx

```bash
kubectl -n lih-production logs -l app=lih-api --tail=200 --since=15m | grep -i error
```

```bash
kubectl -n lih-production get pods -l app=lih-api -o wide
```

| Symptom | Likely cause | Action |
|---|---|---|
| `CrashLoopBackOff` | Bad config or missing secret | `kubectl describe pod` — env validation fails loudly at boot |
| `OOMKilled` | Memory limit | Raise `limits.memory`, then find the leak |
| Readiness failing, liveness passing | Database unreachable | Check Postgres; the pod is correctly out of rotation |
| 5xx with no restarts | Application error | App Insights → exceptions, group by correlation id |

## Database at connection limit

```bash
psql "$DATABASE_URL" -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"
```

Kill queries running over five minutes — but read them first, because a long
report and a runaway loop look identical in the count:

```bash
psql "$DATABASE_URL" -c "SELECT pid, now()-query_start AS duration, left(query,120) FROM pg_stat_activity WHERE state='active' AND now()-query_start > interval '5 minutes' ORDER BY duration DESC;"
```

```bash
psql "$DATABASE_URL" -c "SELECT pg_terminate_backend(PID_HERE);"
```

If pods are scaling faster than the connection pool allows, cap replicas
before raising the database tier — twenty pods each holding a pool will
exhaust any tier.

## Payments stuck pending

The most common real incident: a webhook was never delivered.

```bash
psql "$DATABASE_URL" -c "SELECT id, provider, provider_ref, amount_xaf, created_at FROM payments WHERE status='pending' AND created_at < now() - interval '30 minutes' ORDER BY created_at;"
```

Do **not** mark them succeeded by hand. Re-verify against the provider, which
is the only source of truth:

```bash
kubectl -n lih-production exec deploy/lih-api -- node dist/scripts/verify-payment.js <payment-id>
```

If the provider says succeeded, the reconciliation job applies it correctly —
including activating the policy — because settlement goes through the same
transactional path as a webhook.

## A member reports paying but having no cover

1. Find the payment: `SELECT * FROM payments WHERE msisdn = '+237…' ORDER BY created_at DESC;`
2. If `succeeded` but the policy is not `active`, check `policy_events` — the
   activation should be there.
3. If it is missing, the settlement transaction failed after the payment
   update. Re-run verification (above); it is idempotent.
4. Record the outcome on the support ticket, and if it was a bug, open an
   issue — this class of failure must never be closed as "fixed manually".

## Suspected compromise

Follow [`disaster-recovery.md` § 5](disaster-recovery.md). First three
actions, in order:

```bash
kubectl -n lih-production scale deployment/lih-api --replicas=0
```

Rotate every Key Vault secret, then determine what was accessed:

```bash
psql "$DATABASE_URL" -c "SELECT actor_id, action, entity_type, count(*) FROM audit_logs WHERE created_at > now() - interval '48 hours' GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 50;"
```

---

# Routine operations

## Scale for an expected surge

Renewal reminders drive a predictable spike. Pre-scale rather than waiting for
the autoscaler:

```bash
kubectl -n lih-production scale deployment/lih-api --replicas=8
```

Return to `minReplicas` afterwards:

```bash
kubectl -n lih-production scale deployment/lih-api --replicas=3
```

## Deploy a hotfix

```bash
git checkout -b hotfix/LIH-xxx production
```

After the fix, push and open a PR into `production` — then a second PR into
`main`, or the fix is lost at the next release.

## Add a rating table version

Pricing is versioned and never mutated. Insert a new version with a future
effective date; in-force policies keep pointing at the version that priced
them:

```sql
INSERT INTO rating_tables (id, tenant_id, plan_id, version, factors, effective_from)
SELECT uuid_generate_v7(), tenant_id, plan_id, version + 1, '{...}'::jsonb, '2027-01-01'
FROM rating_tables WHERE plan_id = '<plan>' ORDER BY version DESC LIMIT 1;
```

Never `UPDATE` an existing rating table. That would retroactively change what
a member was quoted, which is both a dispute and an audit finding.

## Reset a member's MFA

Support request, identity verified out of band:

```bash
psql "$DATABASE_URL" -c "UPDATE users SET mfa_enabled=false, mfa_secret=NULL WHERE email='...';"
```

```bash
psql "$DATABASE_URL" -c "INSERT INTO audit_logs (id, tenant_id, actor_id, action, entity_type, entity_id, reason) VALUES (uuid_generate_v7(), '00000000-0000-0000-0000-000000000001', '<your-user-id>', 'auth.mfa_reset', 'User', '<user-id>', 'Support ticket #123, identity verified by phone');"
```

The audit row is not optional. An MFA reset with no recorded reason is
indistinguishable from an account takeover.

---

# Monitoring

## Dashboards

| Dashboard | Answers |
|---|---|
| Executive | GWP, active policies, verified members, renewal rate |
| Finance | Collections by rail, failed payments, reconciliation status, refunds |
| Claims | Queue by state, SLA breaches, fraud-score distribution, cycle time |
| Operations | Latency p50/p95/p99, error rate, pod health, DB connections |
| Mobile | Installs, crash-free rate, offline sync failures, OS mix |

## Alerts

| Alert | Threshold | Severity |
|---|---|---|
| API 5xx rate | > 1% over 5 min | Page |
| p95 latency | > 1 s over 10 min | Page |
| Any pod not Ready | > 5 min | Page |
| Postgres CPU | > 80% for 15 min | Page |
| Postgres connections | > 80% of max | Page |
| Payment failure rate | > 10% over 15 min | Page |
| Reconciliation orphans | > 0 | Ticket |
| Claims SLA breached | > 5 | Ticket |
| Certificate expiry | < 14 days | Ticket |
| Disk usage | > 75% | Ticket |

## Useful KQL

Error rate by endpoint:

```
requests
| where timestamp > ago(1h)
| summarize total=count(), failed=countif(success == false) by name
| extend errorRate = round(100.0 * failed / total, 2)
| order by errorRate desc
```

Payment funnel:

```
customEvents
| where timestamp > ago(24h) and name startswith "payment."
| summarize count() by name, tostring(customDimensions.provider)
| order by count_ desc
```

Slowest endpoints at p95:

```
requests
| where timestamp > ago(6h)
| summarize p95=percentile(duration, 95), count() by name
| where count_ > 10
| order by p95 desc
| take 20
```

---

## Escalation

| Level | Who | When |
|---|---|---|
| 1 | On-call engineer | All alerts |
| 2 | Tech lead | Unresolved after 30 min, or any data-integrity doubt |
| 3 | Roland Wouapit — rwouapit@bouquet-innovation.net | Member data exposure, money loss, > 1 h outage |
| External | Insurer operations lead | Any incident affecting claims or payments |
| Regulatory | Bar Association, then ANTIC assessment | Confirmed personal-data breach |
