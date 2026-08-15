# Disaster recovery procedure

**RPO ≤ 5 minutes · RTO ≤ 1 hour**

Primary: **South Africa North** (3 availability zones)
DR pair: **West Europe**

The API is stateless and replaceable in minutes. Everything below is really
about the database and the document store — those are the parts that cannot be
rebuilt from source.

---

## What each failure actually costs

| Scenario | Impact | RTO | Procedure |
|---|---|---|---|
| One API pod dies | None — 2 of 3 keep serving | 0 | Automatic |
| One availability zone lost | Brief connection reset; Postgres fails over | < 2 min | Automatic |
| Bad release | Wrong behaviour, possibly data errors | < 10 min | § 1 |
| Database corruption or bad migration | Writes wrong or refused | < 45 min | § 2 |
| Accidental data deletion | Records missing | < 30 min | § 3 |
| Whole region lost | Total outage | < 60 min | § 4 |
| Ransomware / key compromise | Total, plus a breach | Varies | § 5 |

---

## 1. Bad release rollback

The deploy workflow rolls back automatically when the smoke test fails.
Manually:

```bash
kubectl -n lih-production rollout undo deployment/lih-api
```

```bash
kubectl -n lih-production rollout status deployment/lih-api --timeout=300s
```

**Migrations are not reverted, and that is deliberate.** Migrations are
additive (expand-migrate-contract), so the previous image runs correctly
against the newer schema. Attempting to reverse a migration under pressure is
how a recoverable incident becomes a data-loss incident.

Verify:

```bash
curl -fsS https://api.lih.cm/health/ready
```

## 2. Database restore — point in time

Azure PostgreSQL Flexible Server keeps 35 days of geo-redundant backups with
continuous WAL archiving, which is where the 5-minute RPO comes from.

**Restore to a new server. Never restore over the live one** — if the restore
target is wrong you have then destroyed the only remaining copy.

```bash
az postgres flexible-server restore --resource-group lih-rg-production --name lih-pg-restored --source-server lih-pg-production --restore-time "2026-08-14T09:15:00Z"
```

Verify before cutting over — check that the data actually predates the damage:

```bash
psql "$RESTORED_URL" -c "SELECT max(created_at) FROM audit_logs;"
```

```bash
psql "$RESTORED_URL" -c "SELECT count(*), max(created_at) FROM payments WHERE status='succeeded';"
```

Then repoint the application:

```bash
az keyvault secret set --vault-name lih-kv-production --name database-url --value "postgresql://lihadmin:PASSWORD@lih-pg-restored.postgres.database.azure.com:5432/lih?sslmode=require"
```

```bash
kubectl -n lih-production rollout restart deployment/lih-api
```

**Then reconcile payments.** Any payment settled between the restore point and
now exists at the provider but not in the restored database. This is the step
that most often gets forgotten and it is the one that costs money:

```bash
kubectl -n lih-production exec deploy/lih-api -- node dist/scripts/reconcile.js --provider mtn_momo --date "$(date -u +%F)"
```

```bash
kubectl -n lih-production exec deploy/lih-api -- node dist/scripts/reconcile.js --provider orange_money --date "$(date -u +%F)"
```

Orphans found there are real payments needing manual application.

## 3. Accidental data deletion

Before restoring anything, find out what happened. The audit log is
append-only and survives application-level deletion:

```bash
psql "$DATABASE_URL" -c "SELECT actor_id, action, entity_type, entity_id, created_at FROM audit_logs WHERE action LIKE '%delete%' AND created_at > now() - interval '24 hours' ORDER BY created_at DESC;"
```

For documents, Blob Storage has versioning and 10-year soft delete:

```bash
az storage blob undelete --account-name lihstorageproduction --container-name lih-documents --name "<blob>" --auth-mode login
```

For a small number of rows, restore to a temporary server (§ 2) and copy the
specific records across rather than rolling the whole database back — a full
restore discards every legitimate write since the restore point.

## 4. Full region failure

### 4.1 Confirm it is regional

```bash
az account list-locations --query "[?name=='southafricanorth']" -o table
```

Check https://status.azure.com. Do not begin a regional failover for a
single-service outage; failing over and back costs more than waiting out a
30-minute service incident.

### 4.2 Restore the database into West Europe

```bash
az postgres flexible-server geo-restore --resource-group lih-rg-dr --name lih-pg-dr --source-server lih-pg-production --location westeurope
```

Typically 20–40 minutes depending on size. Start this first — everything else
runs in parallel with it.

### 4.3 Stand up the cluster

```bash
cd infrastructure/azure && ./provision.sh dr
```

```bash
az aks get-credentials -g lih-rg-dr -n lih-aks-dr && kubectl create namespace lih-production && kubectl apply -f ../kubernetes/
```

The container image is already replicated — ACR is Premium with geo-replication.

### 4.4 Point DNS at DR

Reduce the TTL to 60 seconds **now**, in advance, not during an incident:

```bash
az network dns record-set a update --resource-group lih-dns --zone-name lih.cm --name api --set ttl=60
```

Then repoint:

```bash
az network dns record-set a update --resource-group lih-dns --zone-name lih.cm --name api --set aRecords[0].ipv4Address="<DR ingress IP>"
```

The web app on Vercel needs no action — it is multi-region already. Change
`NEXT_PUBLIC_API_URL` only if the DR API is on a different hostname.

### 4.5 Notify

- Bar Association contact
- The insurer's operations lead
- Members: SMS via the notification service, in French and English

### 4.6 Failing back

Do not rush this. Once the primary region is healthy, schedule the failback
for a low-traffic window, replicate DR data back to the primary, and repeat
§ 4.4 in reverse. Running on DR for an extra day is cheaper than a second
outage.

## 5. Ransomware or key compromise

**Do not restore first.** Restoring into a compromised environment
reintroduces the attacker.

1. **Isolate** — scale the deployment to zero and cut the ingress:

```bash
kubectl -n lih-production scale deployment/lih-api --replicas=0
```

2. **Revoke** — rotate every secret in Key Vault. Rotating
   `JWT_REFRESH_SECRET` signs out every session, which is the point.

3. **Assess** — Key Vault access logs and `audit_logs` tell you what was read
   and by whom. Determine whether personal data left the system.

4. **Rebuild** — new cluster, new credentials, restore data from a backup
   predating the compromise.

5. **Notify** — the Bar Association, affected members, and assess ANTIC
   notification duties under Law No. 2010/012.

6. **Post-mortem** — written up in `docs/incidents/`.

If `PII_ENCRYPTION_KEY` is compromised, every encrypted identity number must
be treated as exposed, and re-encryption under a new key is required. Key
Vault purge protection exists so that key cannot be destroyed — losing it
would make every encrypted value permanently unreadable.

---

## Backup inventory

| Asset | Mechanism | Retention | Restore time |
|---|---|---|---|
| PostgreSQL | Continuous WAL, geo-redundant | 35 days | 15–40 min |
| Blob documents | Versioning + soft delete, RA-GRS | 10 years | Minutes |
| Container images | ACR, geo-replicated | 30 days untagged | Immediate |
| Key Vault | Soft delete + purge protection | 90 days | Immediate |
| Source | GitHub | Indefinite | Immediate |
| Terraform state | Azure Storage, versioned | Indefinite | Immediate |

## What is NOT backed up

Deliberately, and worth knowing:

- **Redis** — sessions, OTP codes and rate-limit counters. Losing it signs
  everyone out and voids in-flight OTPs. Not worth replicating.
- **Elasticsearch** — rebuildable from Postgres, which is the source of truth.
- **Application logs older than 90 days** — audit data lives in `audit_logs`
  and is retained 7 years; operational logs are not the same thing.

## Testing schedule

An untested restore is a hypothesis, not a backup.

| Test | Frequency | Owner |
|---|---|---|
| Rollback a release on staging | Monthly | DevOps |
| Point-in-time restore to a scratch server | Quarterly | DevOps + DBA |
| Full regional failover rehearsal | Annually | Whole team |
| Ransomware tabletop | Annually | Security + leadership |

Record each test result in `docs/dr-tests/`. A quarterly restore that nobody
wrote down did not happen as far as an auditor is concerned.
