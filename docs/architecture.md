# Deployment architecture

## 1. Production topology

```mermaid
flowchart TB
  subgraph users["Members and staff"]
    L["Lawyers<br/>web · iOS · Android"]
    O["Back office<br/>claims · finance · Bar"]
  end

  subgraph edge["Edge"]
    CF["Cloudflare<br/>DDoS · WAF · edge cache<br/>closest PoP to Douala"]
  end

  subgraph vercel["Vercel — fra1"]
    W["Next.js web app<br/>FR/EN · SSR · CDN"]
  end

  subgraph azure["Azure — South Africa North (3 zones)"]
    FD["Front Door + WAF"]
    ING["NGINX ingress<br/>TLS 1.3 · ModSecurity · rate limit"]

    subgraph aks["AKS · private cluster"]
      API1["lih-api pod<br/>zone 1"]
      API2["lih-api pod<br/>zone 2"]
      API3["lih-api pod<br/>zone 3"]
    end

    subgraph data["Data — private endpoints only"]
      PG[("PostgreSQL Flexible<br/>zone-redundant HA<br/>35-day geo backup")]
      RD[("Redis<br/>sessions · OTP · limits")]
      BL[("Blob RA-GRS<br/>certificates · evidence")]
    end

    KV["Key Vault<br/>purge protection"]
    MON["Monitor · App Insights<br/>Log Analytics"]
  end

  subgraph ext["External"]
    OM["Orange Money"]
    MM["MTN MoMo"]
    CP["CinetPay — cards"]
    NT["SMS · email · push"]
  end

  L --> CF
  O --> CF
  CF --> W
  CF --> FD
  W -- "REST /v1" --> FD
  FD --> ING
  ING --> API1 & API2 & API3

  API1 & API2 & API3 --> PG
  API1 & API2 & API3 --> RD
  API1 & API2 & API3 --> BL
  API1 & API2 & API3 -. "workload identity" .-> KV
  API1 & API2 & API3 --> MON

  API1 --> OM & MM & CP
  API1 --> NT
  OM & MM & CP -. "signed webhooks" .-> ING

  PG -. "geo backup" .-> DR[("West Europe<br/>DR pair")]
```

## 2. CI/CD pipeline

```mermaid
flowchart LR
  PR["Push / PR"] --> S1["1 · Lint<br/>+ typecheck"]
  S1 --> S2["2 · Unit tests<br/>domain + API"]
  S2 --> S3["3 · Integration<br/>real PG + Redis<br/>RLS + audit assertions"]
  S3 --> S4["4 · Build web"]
  S3 --> S5["5 · Build backend"]
  S3 --> S6["6 · Build mobile"]

  S5 --> S7["7 · Docker build<br/>SBOM + provenance"]
  S7 --> S8["8 · Push to ACR<br/>Trivy scan"]
  S8 --> GATE{{"Production?<br/>2 reviews +<br/>environment approval"}}
  GATE --> MIG["Migration Job<br/>pre → migrate → post"]
  MIG --> S9["9 · Deploy AKS<br/>rolling, maxUnavailable 0"]
  S9 --> SMOKE{"Smoke test"}
  SMOKE -- pass --> DONE["Live"]
  SMOKE -- fail --> RB["Automatic rollback"]

  S4 --> S10["10 · Vercel deploy<br/>--prebuilt"]
  S10 --> HDR{"Security headers<br/>+ both locales"}
  HDR -- pass --> DONE
```

Migrations run **before** the new pods and abort the deploy on failure —
no new code starts against a schema it cannot use.

## 3. Branch and environment flow

```mermaid
flowchart LR
  F["feature/*"] --> M["main<br/>1 review"]
  M --> D["develop"]
  D --> ST["staging"]
  ST --> P["production"]
  HF["hotfix/*"] -.-> P
  HF -.-> M

  D --> DEV["dev.lih.cm<br/>auto"]
  ST --> STG["staging.lih.cm<br/>UAT · Bar pilot"]
  P --> PRD["api.lih.cm + app.lih.cm<br/>2 reviews + approval"]
```

## 4. Repository structure

```
lawyers-insurance-hub/
├── backend/                    NestJS API — 12 service-shaped modules
│   ├── src/
│   │   ├── common/             prisma · auth guards · crypto · audit · filters
│   │   ├── config/             environment validation (fails fast at boot)
│   │   ├── i18n/{en,fr}/       bilingual API messages
│   │   └── modules/            auth · onboarding · catalogue · policies
│   │                           claims · payments · health
│   ├── prisma/
│   │   ├── schema.prisma       28 tables
│   │   ├── sql/                RLS · partitioning · uuidv7 · constraints
│   │   └── seed.ts             roles · permissions · catalogue · rating tables
│   ├── scripts/apply-sql.js
│   └── Dockerfile              multi-stage, non-root, distroless-style
│
├── frontend-web/               Next.js 15 · App Router · next-intl
│   ├── src/lib/api-client.ts   single-flight refresh · bigint money
│   └── messages/{en,fr}.json
│
├── mobile-app/                 Flutter — Android + iOS
│   └── lib/core/               money.dart · api_client.dart (keystore, offline)
│
├── desktop-app/                Electron — Windows + macOS, auto-update
│
├── packages/domain/            Pure logic, no framework, no I/O
│   └── src/                    money · rating · state machines · RBAC
│
├── infrastructure/
│   ├── azure/provision.sh      full estate, idempotent
│   ├── kubernetes/             deployment · service · ingress · secrets · job
│   └── terraform/
│
├── docs/
│   ├── adr/                    decision records
│   └── guides/                 github · vercel · azure · testflight · DR · runbook
│
├── scripts/
└── .github/workflows/          ci · deploy-azure · deploy-vercel · release-mobile · security
```

## 5. Request path — paying a premium

The flow with the strictest correctness requirements in the system.

```mermaid
sequenceDiagram
    autonumber
    participant M as Lawyer
    participant A as API
    participant DB as PostgreSQL
    participant P as MTN MoMo

    M->>A: POST /installments/{id}/pay<br/>Idempotency-Key: uuid
    A->>DB: SELECT payment WHERE idempotency_key
    alt key already used
        DB-->>A: existing payment
        A-->>M: 202 — original result, no second charge
    else new
        A->>DB: INSERT payment (initiated)
        Note over A,DB: Row exists BEFORE the provider is called —<br/>a timeout still leaves an auditable record
        A->>P: requestToPay
        P-->>A: 202 pending
        A->>DB: UPDATE payment (pending, providerRef)
        A-->>M: 202 — confirm on your handset
        P-->>M: USSD prompt
        M->>P: PIN
        P->>A: webhook: SUCCESSFUL
        A->>A: verify HMAC
        A->>P: GET requesttopay/{ref}
        P-->>A: SUCCESSFUL, amount
        Note over A: Callback alone never settles money
        A->>DB: BEGIN
        A->>DB: payment → succeeded
        A->>DB: installment → paid
        A->>DB: INSERT ledger_entry
        A->>DB: policy → active (policies:activate:system)
        A->>DB: INSERT outbox_event + audit_log
        A->>DB: COMMIT
        Note over A,DB: Money and cover commit together, or neither does
    end
```

## 6. Where the state machines live

```mermaid
stateDiagram-v2
    direction LR
    [*] --> draft
    draft --> submitted: submit
    submitted --> under_review: start_review
    under_review --> approved: approve
    approved --> active: activate (system only)
    active --> suspended: suspend
    suspended --> active: reinstate
    active --> expired: expire
    expired --> renewed: renew
    active --> cancelled: cancel
    submitted --> cancelled: reject
    renewed --> [*]
    cancelled --> [*]
```

`activate` carries `policies:activate:system`, a permission held by no human
role. Only the payment settlement transaction can perform it — which is how
"cover never starts before money arrives" is enforced structurally rather than
by convention.
