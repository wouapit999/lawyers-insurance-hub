# Security Policy — Politique de sécurité

Lawyers Insurance Hub processes national identity numbers, passport numbers,
insurance claims and live payment transactions for members of the Cameroon Bar
Association. Security reports are treated as production incidents.

---

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

| Channel | Address |
|---|---|
| Preferred | GitHub → **Security** tab → *Report a vulnerability* (private advisory) |
| Email | security@bouquet-innovation.net (cc rwouapit@bouquet-innovation.net) |

Include: affected component, reproduction steps, impact, and any proof of
concept. If you can, tell us whether real member data was exposed — that
changes our regulatory notification clock, not our response to you.

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement | 48 hours |
| Initial triage and severity | 5 business days |
| Fix for critical (CVSS ≥ 9.0) | 7 days |
| Fix for high (7.0–8.9) | 30 days |
| Fix for medium / low | Next scheduled release |

We will credit you in the advisory unless you ask us not to. We do not
currently run a paid bounty programme.

### Safe harbour

Research conducted in good faith under this policy will not lead to legal
action from us. That protection requires you to:

- test only against `staging.lih.cm`, never production;
- use only accounts you created;
- stop at proof of access — do not read, copy, alter or delete member data;
- not degrade service (no load or denial-of-service testing);
- give us reasonable time to remediate before disclosing.

---

## Supported versions

| Version | Supported |
|---|---|
| 1.x (current) | ✅ |
| < 1.0 (pre-launch) | ❌ |

---

## Where the security controls actually live

Reviewers and auditors: these are the files to read, not the marketing claims.

| Control | Implementation |
|---|---|
| Password hashing | Argon2id, 19 MiB / t=2 / p=1 — `backend/src/modules/auth/auth.service.ts` |
| Session revocation | Checked per request, not only at token issue — `backend/src/modules/auth/jwt.strategy.ts` |
| Refresh-token reuse detection | Replayed token revokes the whole chain — `token.service.ts` |
| Authorisation | Deny-by-default global guard; `resource:action:scope` — `common/auth/permissions.guard.ts` |
| Tenant isolation | PostgreSQL row-level security bound to the JWT claim — `prisma/sql/020_post_migrate.sql` |
| PII encryption | AES-256-GCM per-value, random IV — `common/security/crypto.service.ts` |
| Audit trail | Append-only trigger, monthly partitions — `020_post_migrate.sql` |
| Payment idempotency | Unique constraint on `idempotency_key` — `prisma/schema.prisma` |
| Webhook authenticity | HMAC verify **then** independent provider confirmation — `payments.service.ts` |
| Secrets | Azure Key Vault → container env. Never in the repo, never in CI variables |

---

## Handling of member data

- **National ID and passport numbers** are encrypted at column level and
  returned masked (`•••••••••0123`) by every list and profile endpoint.
  Retrieving a full value is a separate, audited support action.
- **Card data never reaches our servers.** Card payments redirect to the
  CinetPay hosted page; we store a token. Any change that appears to require a
  PAN, CVV or expiry date on our side is wrong by construction.
- **Logs are scrubbed** by a shared serialiser before write. Password hashes,
  MFA secrets, refresh tokens and identity numbers are redacted, including in
  audit `before`/`after` snapshots.
- **Retention** follows the CIMA Insurance Code: policies, claims and payments
  for 10 years after closure; audit logs 7 years, immutable.

---

## Incident response

1. **Contain** — revoke affected sessions (`POST /v1/auth/logout/all`), rotate
   the implicated secret in Key Vault, restrict network access if needed.
2. **Assess** — determine whether personal data was accessed. Query
   `audit_logs` for the actor and window.
3. **Notify** — if member data was exposed, notify the Cameroon Bar
   Association and affected members. Assess ANTIC notification duties under
   Law No. 2010/012.
4. **Remediate and record** — fix, deploy, then write the post-mortem into
   `docs/incidents/`.

The on-call runbook is [`docs/guides/maintenance-runbook.md`](docs/guides/maintenance-runbook.md).

---

## Signalement en français

**N'ouvrez pas d'issue publique pour une faille de sécurité.**

Signalez-la via l'onglet **Security** de GitHub (avis privé) ou par courriel à
security@bouquet-innovation.net. Accusé de réception sous 48 heures, triage
sous 5 jours ouvrés, correction sous 7 jours pour une faille critique.

La recherche menée de bonne foi contre `staging.lih.cm` uniquement, sans accès
aux données réelles des membres et sans dégradation du service, ne donnera lieu
à aucune poursuite de notre part.
