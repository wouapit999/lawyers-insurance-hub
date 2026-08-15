# Production security checklist

Sign off before the first real premium is collected, then re-run quarterly.
Each item names where it is enforced, so "done" is verifiable rather than
asserted.

Legend: ✅ implemented in code · ⚙️ configuration required at deploy · 📋 process

---

## Authentication

| # | Control | Where | State |
|---|---|---|---|
| 1.1 | Argon2id password hashing, 19 MiB / t=2 | `auth.service.ts` | ✅ |
| 1.2 | Minimum 12-character passwords, length over composition rules | `auth.dto.ts` | ✅ |
| 1.3 | Account lockout after 5 failures, 15 minutes | `registerFailedLogin()` | ✅ |
| 1.4 | Uniform response time for unknown user vs wrong password | `login()` — dummy hash | ✅ |
| 1.5 | Access tokens 15 minutes, refresh 30 days | `JWT_ACCESS_TTL` | ✅ |
| 1.6 | Refresh tokens stored hashed, never in plaintext | `token.service.ts` | ✅ |
| 1.7 | Refresh rotation with reuse detection revoking the chain | `rotate()` | ✅ |
| 1.8 | Session revocation checked per request, not only at issue | `jwt.strategy.ts` | ✅ |
| 1.9 | MFA mandatory for all back-office roles | | ⚙️ enforce at role assignment |
| 1.10 | Step-up MFA on refunds and payouts | `@RequireMfa()` | ✅ |
| 1.11 | Password reset revokes all other sessions | `resetPassword()` | ✅ |
| 1.12 | OTP: 6 digits, 10-minute expiry, 5-attempt cap, hashed | `otp.service.ts` | ✅ |
| 1.13 | Biometric unlock guards the keystore, not a bypass | `api_client.dart` | ✅ |

## Authorisation

| # | Control | Where | State |
|---|---|---|---|
| 2.1 | Deny-by-default: routes authenticated unless `@Public()` | `jwt-auth.guard.ts` | ✅ |
| 2.2 | Granular `resource:action:scope` permissions | `permissions.ts` | ✅ |
| 2.3 | `:all` widens to `:own`, never the reverse | `hasPermission()` + tests | ✅ |
| 2.4 | No human role holds a `:system` permission | CI guardrail | ✅ |
| 2.5 | Own-scoped queries take the id from the token, not the URL | `resolveLawyerId()` | ✅ |
| 2.6 | 404 rather than 403 for other members' records | `policies.findOne()` | ✅ |
| 2.7 | Row-level security keyed to the JWT tenant claim | `020_post_migrate.sql` | ✅ |
| 2.8 | Bar Association role cannot reach any policy, claim or payment | `ROLES.bar_admin` | ✅ |
| 2.9 | Quarterly access review of back-office accounts | | 📋 |

## Data protection

| # | Control | Where | State |
|---|---|---|---|
| 3.1 | TLS 1.2+ everywhere, 1.3 preferred | `ingress.yaml` | ⚙️ |
| 3.2 | HSTS with preload, 2 years | `vercel.json`, ingress | ✅ |
| 3.3 | National ID and passport encrypted AES-256-GCM per value | `crypto.service.ts` | ✅ |
| 3.4 | Random IV per encryption — no deterministic ciphertext | tested | ✅ |
| 3.5 | Tampered ciphertext returns null, never partial plaintext | tested | ✅ |
| 3.6 | Identity numbers masked in every list and profile response | `onboarding.service.ts` | ✅ |
| 3.7 | Secrets redacted from logs and audit snapshots | `audit.service.ts` | ✅ |
| 3.8 | Key Vault purge protection ON | `provision.sh` | ⚙️ |
| 3.9 | Postgres `require_secure_transport = ON` | `provision.sh` | ⚙️ |
| 3.10 | Blob: no public access, no shared-key access, HTTPS only | `provision.sh` | ⚙️ |
| 3.11 | Blob versioning + 10-year soft delete (CIMA) | `provision.sh` | ⚙️ |
| 3.12 | Card data never touches our servers — hosted checkout | `card.provider.ts` | ✅ |

## Application security

| # | Control | Where | State |
|---|---|---|---|
| 4.1 | Input validation on every DTO; unknown properties rejected | `main.ts` whitelist | ✅ |
| 4.2 | SQL injection — parameterised via Prisma; one raw call, no interpolation | `apply-sql.js` | ✅ |
| 4.3 | XSS — React escaping + CSP without `unsafe-eval` | `vercel.json` | ✅ |
| 4.4 | CSRF — bearer tokens in headers, not cookies; SameSite on the session cookie | | ✅ |
| 4.5 | Clickjacking — `X-Frame-Options: DENY`, `frame-ancestors 'none'` | `vercel.json` | ✅ |
| 4.6 | Rate limiting in-app (per user + IP) | `ThrottlerModule` | ✅ |
| 4.7 | Rate limiting at ingress, before Node | `ingress.yaml` | ⚙️ |
| 4.8 | Auth endpoints throttled far below the global default | `@Throttle` | ✅ |
| 4.9 | ModSecurity + OWASP CRS at ingress | `ingress.yaml` | ⚙️ |
| 4.10 | Cloudflare WAF in front of the web app | | ⚙️ |
| 4.11 | Errors leak no stack traces or table names | `problem-details.filter.ts` | ✅ |
| 4.12 | Correlation id on every request and error | `main.ts` | ✅ |
| 4.13 | Uploads scanned — Defender for Storage | | ⚙️ |
| 4.14 | Upload size capped at 25 MB | `ingress.yaml` | ⚙️ |

## Payment integrity

| # | Control | Where | State |
|---|---|---|---|
| 5.1 | Idempotency key required and DB-unique on every payment mutation | `schema.prisma` | ✅ |
| 5.2 | Payment row written before the provider is called | `payInstallment()` | ✅ |
| 5.3 | Webhooks HMAC-verified with constant-time comparison | all providers | ✅ |
| 5.4 | Webhook success independently confirmed with the provider | `handleWebhook()` | ✅ |
| 5.5 | Amount mismatch is flagged, never applied | `handleWebhook()` | ✅ |
| 5.6 | Settlement, ledger and activation in one transaction | `settle()` | ✅ |
| 5.7 | Cover cannot activate without settled payment | `policies:activate:system` | ✅ |
| 5.8 | Refunds are new rows; originals never edited | `refund()` | ✅ |
| 5.9 | Daily reconciliation flags orphans and mismatches to a human | `reconcile()` | ✅ |
| 5.10 | Positive-amount constraints in the database | `020_post_migrate.sql` | ✅ |

## Auditability

| # | Control | Where | State |
|---|---|---|---|
| 6.1 | Every state change writes an audit row with its actor | all services | ✅ |
| 6.2 | Audit rows in the same transaction as the change | `audit.service.ts` | ✅ |
| 6.3 | `audit_logs` rejects UPDATE and DELETE at the database level | trigger | ✅ |
| 6.4 | Monthly partitions, 7-year retention | `020_post_migrate.sql` | ✅ |
| 6.5 | Administrative overrides require a reason string | `reason` field | ✅ |
| 6.6 | Claim transitions recorded with actor and timestamp | `claim_events` | ✅ |
| 6.7 | Logs shipped to Log Analytics, 90-day hot retention | `provision.sh` | ⚙️ |

## Infrastructure

| # | Control | Where | State |
|---|---|---|---|
| 7.1 | Containers run non-root, read-only root filesystem, all caps dropped | `deployment.yaml` | ✅ |
| 7.2 | Database, Redis and Blob on private endpoints — no public ingress | `provision.sh` | ⚙️ |
| 7.3 | Default-deny egress; instance metadata endpoint blocked | `service.yaml` | ✅ |
| 7.4 | Workload identity — no stored cloud credential in the cluster | `provision.sh` | ⚙️ |
| 7.5 | ACR admin account disabled | `provision.sh` | ⚙️ |
| 7.6 | Image scanning; fixable criticals block production | `deploy-azure.yml` | ✅ |
| 7.7 | AKS Defender enabled, patch auto-upgrade on | `provision.sh` | ⚙️ |
| 7.8 | Zone-redundant Postgres HA | `provision.sh` | ⚙️ |
| 7.9 | Pod disruption budget keeps 2 replicas during drains | `deployment.yaml` | ✅ |

## Pipeline

| # | Control | Where | State |
|---|---|---|---|
| 8.1 | Azure auth via OIDC — no long-lived cloud secret | `deploy-azure.yml` | ✅ |
| 8.2 | Production deploys need 2 reviews + environment approval | branch protection | ⚙️ |
| 8.3 | Secret scanning with push protection | GitHub settings | ⚙️ |
| 8.4 | CodeQL `security-extended` on every PR and weekly | `security.yml` | ✅ |
| 8.5 | Gitleaks over full history | `security.yml` | ✅ |
| 8.6 | Dependency audit; criticals fail the build | `security.yml` | ✅ |
| 8.7 | Signing keys scoped to the `mobile-release` environment | GitHub environments | ⚙️ |
| 8.8 | Migrations run as a Job before pods; failure aborts the deploy | `deploy-azure.yml` | ✅ |
| 8.9 | Automatic rollback on failed smoke test | `deploy-azure.yml` | ✅ |

## Compliance and process

| # | Control | State |
|---|---|---|
| 9.1 | CIMA 10-year retention on policies, claims, payments | ✅ schema |
| 9.2 | Data-subject export and delete workflow | 📋 **not built** |
| 9.3 | Consent records for data processing | 📋 **not built** |
| 9.4 | Data-processing agreement with the Bar Association | 📋 |
| 9.5 | External penetration test before launch | 📋 |
| 9.6 | Incident response runbook rehearsed once | 📋 |
| 9.7 | Quarterly access review | 📋 |
| 9.8 | Annual key rotation (JWT, PII, provider) | 📋 |
| 9.9 | ANTIC notification path documented (Law 2010/012) | 📋 |

---

## Blocking items before production

These are not optional and are not yet done:

1. **9.2 / 9.3 — data-subject rights.** Export and delete workflows do not
   exist. Required for GDPR-compatible operation and likely for the Bar
   partnership agreement.
2. **9.5 — penetration test.** No external test has been run against this
   code.
3. **1.9 — MFA enforcement for staff.** The mechanism exists; nothing yet
   forces a back-office account to enrol.
4. **4.13 — upload scanning.** Claim evidence is user-supplied binary content
   and is not currently scanned.
5. **Documents module.** Storage design exists; the upload service does not,
   so no evidence path has been security-reviewed yet.

## Key rotation

| Secret | Frequency | Procedure |
|---|---|---|
| `JWT_ACCESS_SECRET` | 90 days | Rotate in Key Vault; in-flight access tokens die within 15 minutes |
| `JWT_REFRESH_SECRET` | 180 days | Rotating signs everyone out — schedule out of hours |
| `PII_ENCRYPTION_KEY` | Annually | **Requires re-encryption of every stored value.** The `v1.` prefix exists for exactly this; write the migration before rotating |
| Provider credentials | Annually or on staff change | Rotate at the provider first, then Key Vault |
| Database password | 180 days | `az postgres flexible-server update`, then Key Vault, then restart pods |
| Android upload keystore | **Never** | Rotation is impossible without publishing a new Play listing |
