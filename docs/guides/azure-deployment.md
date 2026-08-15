# Azure deployment guide

Standing up the backend from nothing to serving production traffic.

Budget **half a day** for the first run, most of it waiting on AKS and
PostgreSQL to provision.

---

## Prerequisites

```bash
az --version && kubectl version --client && helm version
```

Log in and select the subscription:

```bash
az login && az account set --subscription "<subscription-id>"
```

You need **Contributor** plus **User Access Administrator** — the script
creates role assignments, which Contributor alone cannot do.

## 1. Provision the estate

```bash
cd infrastructure/azure && chmod +x provision.sh && ./provision.sh production
```

This creates: resource group, VNet with delegated subnets, Log Analytics,
Application Insights, Key Vault (purge protection on), ACR, PostgreSQL
Flexible Server (zone-redundant HA), Redis, Blob (RA-GRS), AKS, workload
identity, and the diagnostic settings.

It is idempotent — re-run it to converge drift.

The database admin password is generated inside the script and stored **only**
in Key Vault. It is never printed and never written to disk:

```bash
az keyvault secret show --vault-name lih-kv-production --name database-url --query value -o tsv
```

## 2. Fill in the provider credentials

Placeholders were created for each. Replace them as merchant onboarding
completes:

```bash
az keyvault secret set --vault-name lih-kv-production --name om-client-id --value "..."
az keyvault secret set --vault-name lih-kv-production --name om-client-secret --value "..."
az keyvault secret set --vault-name lih-kv-production --name om-merchant-key --value "..."
az keyvault secret set --vault-name lih-kv-production --name momo-subscription --value "..."
az keyvault secret set --vault-name lih-kv-production --name momo-api-user --value "..."
az keyvault secret set --vault-name lih-kv-production --name momo-api-key --value "..."
```

Generate the webhook secrets yourself and register the same value with each
provider:

```bash
az keyvault secret set --vault-name lih-kv-production --name om-webhook-secret --value "$(openssl rand -hex 32)"
```

> Start MTN and Orange merchant onboarding **in month one**. It is the longest
> external lead time in the project and the platform cannot collect a single
> franc without it.

## 3. Cluster add-ons

```bash
az aks get-credentials -g lih-rg-production -n lih-aks-production
```

Ingress controller with ModSecurity:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx && helm repo update
```

```bash
helm install ingress-nginx ingress-nginx/ingress-nginx --namespace ingress-nginx --create-namespace --set controller.replicaCount=2 --set controller.config.enable-modsecurity=true --set controller.config.enable-owasp-modsecurity-crs=true --set controller.config.use-forwarded-headers=true --set controller.service.externalTrafficPolicy=Local
```

`externalTrafficPolicy=Local` preserves the client IP, without which every
rate limit would see one address.

cert-manager for TLS:

```bash
helm repo add jetstack https://charts.jetstack.io && helm install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace --set crds.enabled=true
```

```bash
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: rwouapit@bouquet-innovation.net
    privateKeySecretRef:
      name: letsencrypt-production
    solvers:
      - http01:
          ingress:
            class: nginx
EOF
```

## 4. Deploy the application

```bash
kubectl create namespace lih-production
```

Substitute the workload identity client id into the manifests, then apply:

```bash
export AZURE_WORKLOAD_IDENTITY_CLIENT_ID=$(az identity show -g lih-rg-production -n lih-api-identity-production --query clientId -o tsv) && export AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)
```

```bash
sed -e "s|__AZURE_WORKLOAD_IDENTITY_CLIENT_ID__|$AZURE_WORKLOAD_IDENTITY_CLIENT_ID|g" -e "s|__AZURE_TENANT_ID__|$AZURE_TENANT_ID|g" infrastructure/kubernetes/secrets.example.yaml | kubectl apply -n lih-production -f -
```

```bash
envsubst < infrastructure/kubernetes/deployment.yaml | kubectl apply -f - && kubectl apply -f infrastructure/kubernetes/service.yaml && kubectl apply -f infrastructure/kubernetes/ingress.yaml
```

Confirm the secrets actually mounted before expecting the pods to start — a
missing Key Vault permission shows up here:

```bash
kubectl -n lih-production get secret lih-api-secrets -o jsonpath='{.data}' | tr ',' '\n' | wc -l
```

## 5. First deploy through the pipeline

Push to `production` and let the workflow build, scan, migrate and roll out:

```bash
git checkout production && git merge --no-ff staging && git push origin production
```

The workflow will pause for the environment approval before it deploys.

To run the very first migration manually instead:

```bash
kubectl -n lih-production create job --from=cronjob/lih-migrate lih-migrate-initial
```

## 6. DNS

```bash
kubectl -n ingress-nginx get service ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

Point `api.lih.cm` at that address with a short TTL (60 s), which makes a DR
cutover fast when you need it.

## 7. Verify

```bash
curl -fsS https://api.lih.cm/health/ready
```

```bash
curl -fsS https://api.lih.cm/v1/products -H 'Accept-Language: fr' | head -c 300
```

Check the security headers and TLS version:

```bash
curl -sI https://api.lih.cm/v1/products | grep -iE 'strict-transport|x-frame|x-content-type'
```

Confirm the database enforcement actually took effect:

```bash
kubectl -n lih-production exec deploy/lih-api -- npx prisma db execute --stdin <<< "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename IN ('policies','claims','payments');"
```

All three must show `rowsecurity = t`.

---

## Alternative: Azure App Service

AKS is the right target at scale, but App Service is materially simpler and is
a reasonable choice for the MVP's first months — one service instead of a
cluster, no ingress controller, no cert-manager.

```bash
az appservice plan create --name lih-plan --resource-group lih-rg-production --is-linux --sku P1v3
```

```bash
az webapp create --resource-group lih-rg-production --plan lih-plan --name lih-api --deployment-container-image-name lihacr.azurecr.io/lih-api:production
```

```bash
az webapp identity assign --resource-group lih-rg-production --name lih-api
```

Then reference Key Vault directly in the app settings, which removes the CSI
driver entirely:

```bash
az webapp config appsettings set --resource-group lih-rg-production --name lih-api --settings DATABASE_URL="@Microsoft.KeyVault(SecretUri=https://lih-kv-production.vault.azure.net/secrets/database-url/)" NODE_ENV=production DEFAULT_LOCALE=fr
```

What you give up: fine-grained pod control, network policies, and the
migration-Job pattern (migrations would run as a deployment slot swap step
instead). What you gain: roughly a third of the operational surface.

**Recommendation** — start on App Service through the pilot, move to AKS when
either the reporting workload needs separate scaling or the AI service arrives.
The container image is identical, so the move is a deployment change.

---

## Cost estimate

Monthly, South Africa North, production sized for Year 1:

| Resource | Spec | USD/month |
|---|---|---|
| AKS nodes | 3 × D4s_v5 | ~420 |
| PostgreSQL | D4ds_v5, HA, 256 GB | ~510 |
| Redis | Standard C1 | ~55 |
| Blob | 500 GB RA-GRS | ~35 |
| ACR | Premium | ~50 |
| Front Door + WAF | | ~40 |
| Monitor / App Insights | 50 GB | ~120 |
| Key Vault, DNS, egress | | ~30 |
| **Total** | | **≈ 1,260** |

Roughly **760,000 XAF per month**. Against the blueprint's $2.0k/month MVP
infrastructure line, this leaves headroom for staging and dev.

App Service instead of AKS saves ~$250/month.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Pods `CreateContainerConfigError` | Key Vault secret missing, or workload identity lacks *Key Vault Secrets User* |
| `ImagePullBackOff` | ACR not attached: `az aks update --attach-acr lihacr` |
| Migration Job fails on `uuid_generate_v7` | `azure.extensions` does not include PGCRYPTO. Set it, then restart the server |
| Certificate stuck `Pending` | DNS not resolving to the ingress IP yet; the HTTP-01 challenge cannot complete |
| Webhooks return 403 | The webhook ingress is separate — confirm both Ingress objects exist |
| RLS blocks every query | `app.current_tenant` not set. All access must go through `PrismaService.forTenant()` |
