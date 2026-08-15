# Vercel publishing guide

Deploying the bilingual Next.js web application.

---

## 1. Connect GitHub

1. Sign in at https://vercel.com with **GitHub** (account `wouapit999`), so
   the connection exists from the start rather than being retrofitted.
2. Authorise the Vercel GitHub App for `wouapit999/lawyers-insurance-hub`.
   Grant **selected repositories** access rather than all — Vercel does not
   need to see your other work.

## 2. Import the repository

**Add New…** → **Project** → import `lawyers-insurance-hub`.

Configure it as follows. The root directory setting is the one people get
wrong on a monorepo:

| Setting | Value | Why |
|---|---|---|
| Framework Preset | Next.js | |
| **Root Directory** | `frontend-web` | The repo root is a workspace, not the app |
| Build Command | *(leave default)* | `vercel.json` overrides it — it builds `@lih/domain` first |
| Install Command | `npm ci` | Deterministic, unlike `npm install` |
| Node.js Version | 22.x | Matches CI and the API container |

Do **not** click Deploy yet — deploying before the environment variables exist
produces a first build that fails and then has to be re-run.

## 3. Environment variables

Settings → **Environment Variables**. Add each one and tick the environments
it applies to.

| Variable | Production | Preview | Value |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | ✅ | | `https://api.lih.cm/v1` |
| `NEXT_PUBLIC_API_URL` | | ✅ | `https://staging.api.lih.cm/v1` |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | ✅ | ✅ | `fr` |
| `NEXT_PUBLIC_SUPPORTED_LOCALES` | ✅ | ✅ | `fr,en` |
| `NEXT_PUBLIC_APP_NAME` | ✅ | ✅ | `Lawyers Insurance Hub` |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | ✅ | ✅ | `support@lih.cm` |
| `NEXT_PUBLIC_FEATURE_CARD_PAYMENTS` | ✅ | ✅ | `false` until Phase 2 |
| `SESSION_SECRET` | ✅ | ✅ | 32 random bytes, **different per environment** |
| `NEXT_TELEMETRY_DISABLED` | ✅ | ✅ | `1` |

Two rules worth stating plainly:

- **Anything prefixed `NEXT_PUBLIC_` is in the JavaScript bundle** and
  readable by any visitor. Never put a secret behind that prefix.
- **Preview must never point at the production API.** A preview deployment is
  built from an unreviewed branch; pointing it at production means unmerged
  code can write real policies.

Generate the session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 4. Deploy production

The `git.deploymentEnabled` block in `vercel.json` maps branches to
environments: `production` → production, `staging` and `develop` → preview,
`main` → no automatic deploy.

```bash
git checkout production && git merge --no-ff staging && git push origin production
```

The GitHub Actions workflow then builds and deploys with `--prebuilt`. It
builds in CI rather than on Vercel's builders for two reasons: the web app
imports `@lih/domain` from the monorepo, which Vercel's default detection does
not build; and it means the artifact that passed CI is the artifact that
ships.

## 5. Get the deployment IDs into GitHub

```bash
npx vercel link
```

Then read the generated file and store both IDs:

```bash
cat .vercel/project.json
```

```bash
gh secret set VERCEL_ORG_ID --body "<orgId>" && gh secret set VERCEL_PROJECT_ID --body "<projectId>" && gh secret set VERCEL_TOKEN --body "<token from vercel.com/account/tokens>"
```

## 6. Domains

Settings → **Domains**:

| Domain | Assigned to |
|---|---|
| `app.lih.cm` | Production |
| `staging.app.lih.cm` | `staging` branch |
| `admin.lih.cm` | Production (back-office route group) |

DNS at your registrar:

```
CNAME  app      cname.vercel-dns.com.
CNAME  staging.app  cname.vercel-dns.com.
CNAME  admin    cname.vercel-dns.com.
```

Certificates are issued automatically. Allow up to an hour for propagation
from a Cameroonian registrar.

## 7. Cloudflare in front (recommended)

Cloudflare adds DDoS protection, a WAF, and — the reason that matters most
here — caching at edge locations far closer to Douala and Yaoundé than
Vercel's Frankfurt region.

1. Add `lih.cm` to Cloudflare, point the nameservers at it.
2. Set the `app` record to **Proxied** (orange cloud).
3. SSL/TLS mode: **Full (strict)**. *Flexible* would leave the
   Cloudflare-to-Vercel hop unencrypted, which for a page carrying session
   tokens is not acceptable.
4. Enable: Always Use HTTPS, Automatic HTTPS Rewrites, Brotli, HTTP/3.
5. WAF → enable the Cloudflare Managed Ruleset and the OWASP Core Ruleset.
6. Add a rate-limiting rule on `app.lih.cm/api/*` — 100 requests per minute
   per IP.

Region note: Vercel is set to `fra1` (Frankfurt) in `vercel.json`. That is the
lowest-latency Vercel region for Cameroon; Vercel has no African region, which
is exactly why Cloudflare's edge in front of it is worth the extra hop.

## 8. Verify the deployment

```bash
curl -sI https://app.lih.cm/fr | grep -iE "strict-transport|content-security|x-frame|x-content-type"
```

All four headers must be present — they come from `vercel.json`, and the
deploy workflow fails the build if any is missing.

Then check both locales actually render:

```bash
curl -s -o /dev/null -w "fr:%{http_code}\n" https://app.lih.cm/fr && curl -s -o /dev/null -w "en:%{http_code}\n" https://app.lih.cm/en
```

## 9. Preview deployments on pull requests

Every PR touching `frontend-web/` gets a preview URL, commented on the PR in
both locales by the workflow. Reviewers should open the **French** link first:
French text runs about 20% longer than English, so a layout that survives
French survives English, and not the other way round.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Module not found: @lih/domain` | Root Directory is not `frontend-web`, or the build command was overridden in the dashboard and no longer builds the domain package |
| Build succeeds, page 404s | The locale middleware is not matching. `/` redirects to `/fr`; check the `redirects` block in `vercel.json` |
| Security headers missing | A dashboard-level header override takes precedence over `vercel.json`. Clear it |
| Preview writes to production data | `NEXT_PUBLIC_API_URL` was set at *All Environments* instead of scoped. Fix immediately and audit what the preview wrote |
| Slow first byte from Cameroon | Expected without Cloudflare — Frankfurt is ~180 ms away. Section 7 is the fix |
