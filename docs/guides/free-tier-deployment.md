# Free-tier deployment — no credit card

Getting Lawyers Insurance Hub running on the public internet without a
payment method, and keeping the path to Azure open.

Budget **90 minutes**. Nothing here asks for a card.

---

## What replaces what

| Azure | Free replacement | Free limit | Card? |
|---|---|---|---|
| PostgreSQL Flexible Server | **Neon** | 0.5 GB, 100 compute-hrs/project/mo | No |
| AKS | **Render** web service | 750 instance-hrs/mo, sleeps after 15 min | No |
| Blob Storage | **Supabase Storage** | 1 GB | No |
| Container Registry | **ghcr.io** | included with GitHub | No |
| Application Insights | **Sentry** | 5k errors/mo | No |
| Key Vault | Render environment variables | — | No |
| Front Door / CDN | **Vercel** (web app) + Cloudflare | generous | No |

Redis is **not** in this list because the application does not use it yet:
sessions and OTP codes live in Postgres and rate limiting is in-process. One
fewer account to manage.

---

## Read this before you start

The free tier is right for **building, demonstrating and piloting**. It is not
right for collecting real premiums, and the reason is specific rather than
general snobbery about free hosting:

**Render's free instance sleeps after 15 minutes of no traffic, and the next
request pays a 30–60 second cold start.** A lawyer waiting for a page is
merely annoyed. A *payment webhook* is a different matter — MTN and Orange
time out well before 60 seconds, so a settlement callback arriving at a
sleeping instance can be lost. The member's money leaves their wallet and
their policy does not activate.

Three things blunt this, and you should have all three:

1. `.github/workflows/keep-alive.yml` pings the API every 10 minutes during
   Cameroonian waking hours, which prevents the sleep in practice.
2. The reconciliation job already finds payments that settled at the provider
   but never landed here, so nothing is permanently lost.
3. Webhook handling verifies against the provider rather than trusting the
   callback, so a *late* webhook still settles correctly.

**Before the first real franc is collected, move the API to Render's Starter
plan at $7/month.** It never sleeps. That single upgrade removes the whole
class of problem, and it is a far smaller decision than moving to Azure.

---

## 1. Database — Neon

1. Sign up at **https://neon.tech** with your GitHub account.
2. Create a project: name `lih`, Postgres **16**, region **Europe (Frankfurt)**
   — the closest to Cameroon on the free plan.
3. From the dashboard, copy the **pooled** connection string. It looks like:

```
postgresql://USER:PASSWORD@ep-xxx-pooler.eu-central-1.aws.neon.tech/lih?sslmode=require
```

Use the **pooled** one, not the direct one. Render's free instance opens more
connections than Neon's free compute allows directly, and the pooler is what
absorbs that.

### Verify the schema applies

The schema needs `pgcrypto`, `citext` and `pg_trgm`, uses row-level security,
and partitions the audit log. Neon supports all of it. Confirm before going
further:

```bash
cd backend && DATABASE_URL="<your neon pooled url>" node scripts/apply-sql.js pre
```

```bash
cd backend && DATABASE_URL="<your neon pooled url>" npx prisma migrate deploy
```

```bash
cd backend && DATABASE_URL="<your neon pooled url>" node scripts/apply-sql.js post
```

```bash
cd backend && DATABASE_URL="<your neon pooled url>" npx ts-node prisma/seed.ts
```

All four must succeed. If `apply-sql.js pre` fails on an extension, Neon has
changed its allow-list and the guide needs revisiting.

## 2. Storage — Supabase

1. Sign up at **https://supabase.com**, create a project (free plan, Frankfurt).
2. **Storage → New bucket** → name `lih-documents` → **Private**.
   Private is not optional: this bucket holds claim photographs and identity
   documents.
3. **Project Settings → API**, copy:
   - Project URL → `SUPABASE_URL`
   - `service_role` secret → `SUPABASE_SERVICE_KEY`

> The `service_role` key bypasses Supabase's own row-level security. That is
> correct here — this application decides authorisation before any call
> reaches storage — but it makes the key as sensitive as your database
> password. It goes in Render's environment, never in a client bundle, never
> in git.

## 3. Generate the secrets

```bash
node -e "const c=require('crypto');console.log('JWT_ACCESS_SECRET='+c.randomBytes(48).toString('base64'));console.log('JWT_REFRESH_SECRET='+c.randomBytes(48).toString('base64'));console.log('PII_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'))"
```

Keep `PII_ENCRYPTION_KEY` somewhere you will not lose it. Every national ID
and passport number is encrypted with it, and losing it makes them
permanently unreadable. Azure Key Vault's purge protection is what guards this
in production; on the free tier, that guard is you.

## 4. API — Render

1. Sign up at **https://render.com** with GitHub.
2. **New → Blueprint**, select `wouapit999/lawyers-insurance-hub`. Render reads
   `render.yaml` and proposes the service.
3. Set the values marked `sync: false` when prompted:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** string |
| `PII_ENCRYPTION_KEY` | from step 3 |
| `SUPABASE_URL` | from step 2 |
| `SUPABASE_SERVICE_KEY` | from step 2 |
| `SENTRY_DSN` | step 6, or leave blank for now |
| `PAYMENT_RETURN_URL` | your Vercel URL + `/fr/payments/return` |

`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are generated by Render itself —
leave them alone.

4. Deploy. The first build takes 5–10 minutes; the `preDeployCommand` runs the
   three SQL phases and the seed before the instance takes traffic.

Verify:

```bash
curl -fsS https://lih-api.onrender.com/health/ready
```

```bash
curl -fsS https://lih-api.onrender.com/v1/products -H 'Accept-Language: fr' | head -c 200
```

Allow up to 60 seconds on the first call — that is the cold start.

## 5. Wire up CI/CD

From Render: **Settings → copy the Service ID** (`srv-...`), and
**Account Settings → API Keys → create one**.

```bash
gh secret set RENDER_SERVICE_ID --repo wouapit999/lawyers-insurance-hub
gh secret set RENDER_API_KEY --repo wouapit999/lawyers-insurance-hub
```

Tell the workflows which target is live, and where to ping:

```bash
gh variable set DEPLOY_TARGET --body render --repo wouapit999/lawyers-insurance-hub
gh variable set API_HEALTH_URL --body "https://lih-api.onrender.com/health/live" --repo wouapit999/lawyers-insurance-hub
```

`deploy-render.yml` now runs on pushes to `production`, and
`deploy-azure.yml` stays dormant until `DEPLOY_TARGET` becomes `azure`.

## 6. Error tracking — Sentry (optional)

Sign up at **https://sentry.io**, create a Node project, copy the DSN into
Render as `SENTRY_DSN` and set `TELEMETRY_DRIVER=sentry`.

## 7. Web app — Vercel

Unchanged from [`vercel-guide.md`](vercel-guide.md), except that
`NEXT_PUBLIC_API_URL` points at `https://lih-api.onrender.com/v1`.

---

## What you give up

Worth knowing rather than discovering:

| Lost | Consequence |
|---|---|
| Always-on API | 30–60 s cold start; mitigated by keep-alive, not eliminated |
| Zone-redundant HA | Neon free has no standby. An outage is an outage |
| 35-day PITR | Neon free keeps ~24 h of history. **Take your own backups** |
| Private networking | Neon and Supabase are reached over the public internet (TLS) |
| Workload identity | Credentials are environment variables |
| 10-year retention | 1 GB fills up. Fine for a pilot, not for a live book |

### Take your own backups

The single most important habit on the free tier, because 24 hours of
point-in-time recovery is not a backup strategy:

```bash
pg_dump "$DATABASE_URL" -Fc -f "lih-$(date +%F).dump"
```

Weekly, kept somewhere off the platform.

---

## Moving to Azure later

Deliberately small, because the abstractions were built for it:

1. `npm install @azure/storage-blob --workspace @lih/api`
2. Run `infrastructure/azure/provision.sh production`
3. Copy objects from the Supabase bucket into the Blob container
4. `pg_dump` from Neon, restore into PostgreSQL Flexible Server
5. Change the switches:

```
DEPLOY_TARGET=azure
STORAGE_DRIVER=azure_blob
AZURE_STORAGE_ACCOUNT=lihstorageproduction
```

```bash
gh variable set DEPLOY_TARGET --body azure --repo wouapit999/lawyers-insurance-hub
```

That last command hands the pipeline over: `deploy-azure.yml` activates,
`deploy-render.yml` and `keep-alive.yml` stand down on their own.

**No application code changes.** Not one file in `backend/src/modules/`. The
only file that knows a vendor exists is
`backend/src/common/storage/storage.module.ts`, and all it does is pick a
driver from a string.

Full detail in [`azure-deployment.md`](azure-deployment.md).

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| First request times out | Cold start. Retry; check keep-alive is running |
| `too many connections` | Using Neon's **direct** URL. Switch to the pooled one |
| `STORAGE_DRIVER=local in production` in logs | Storage not switched to supabase — uploads will vanish on next deploy |
| Uploads 500 | `SUPABASE_SERVICE_KEY` is the anon key, not `service_role` |
| Deploy fails in preDeploy | Migration failed. Read the Render log; usually `DATABASE_URL` |
| Neon compute exhausted | 100 hrs/month used. Autosuspend may be off, or keep-alive is querying too often |

---

## Sources

- [Render free tier](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
- [Render pricing and limits](https://www.srvrlss.io/provider/render/)
- [Neon free tier](https://agentdeals.dev/vendor/neon)
- [Neon review and limits](https://www.srvrlss.io/provider/neon/)
