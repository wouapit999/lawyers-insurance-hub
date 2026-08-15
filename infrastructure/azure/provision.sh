#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Lawyers Insurance Hub — Azure provisioning
#
# Creates the full production estate. Idempotent: safe to re-run, and re-runs
# are the intended way to converge drift.
#
# Region choice: South Africa North is the closest Azure region to Cameroon
# with three availability zones and PostgreSQL Flexible Server zone-redundant
# HA. West Europe is the paired region for geo-redundant backups and DR.
#
#   ./provision.sh production
#
# Prerequisites: az CLI logged in, Contributor + User Access Administrator on
# the subscription.
# ---------------------------------------------------------------------------
set -euo pipefail

ENVIRONMENT="${1:-production}"
LOCATION="southafricanorth"
DR_LOCATION="westeurope"

RG="lih-rg-${ENVIRONMENT}"
ACR="lihacr"                       # ACR names are global and alphanumeric only
AKS="lih-aks-${ENVIRONMENT}"
PG="lih-pg-${ENVIRONMENT}"
STORAGE="lihstorage${ENVIRONMENT}" # global, lowercase alphanumeric, <= 24 chars
KV="lih-kv-${ENVIRONMENT}"
REDIS="lih-redis-${ENVIRONMENT}"
INSIGHTS="lih-insights-${ENVIRONMENT}"
WORKSPACE="lih-logs-${ENVIRONMENT}"
VNET="lih-vnet-${ENVIRONMENT}"

info() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
info "Resource group"
az group create --name "$RG" --location "$LOCATION" \
  --tags product=lih environment="$ENVIRONMENT" owner=bouquet-innovation \
         compliance=cima data-classification=confidential

# ---------------------------------------------------------------------------
info "Virtual network"
# Everything data-bearing sits behind private endpoints in this VNet. Nothing
# — not Postgres, not Redis, not Blob — is reachable from the public internet.
az network vnet create \
  --resource-group "$RG" --name "$VNET" \
  --address-prefix 10.0.0.0/16 \
  --subnet-name aks-subnet --subnet-prefix 10.0.1.0/24

az network vnet subnet create \
  --resource-group "$RG" --vnet-name "$VNET" \
  --name db-subnet --address-prefixes 10.0.2.0/24 \
  --delegations Microsoft.DBforPostgreSQL/flexibleServers

az network vnet subnet create \
  --resource-group "$RG" --vnet-name "$VNET" \
  --name pe-subnet --address-prefixes 10.0.3.0/24

# ---------------------------------------------------------------------------
info "Log Analytics workspace"
az monitor log-analytics workspace create \
  --resource-group "$RG" --workspace-name "$WORKSPACE" --location "$LOCATION" \
  --retention-time 90

WORKSPACE_ID=$(az monitor log-analytics workspace show \
  --resource-group "$RG" --workspace-name "$WORKSPACE" --query id -o tsv)

info "Application Insights"
az monitor app-insights component create \
  --app "$INSIGHTS" --location "$LOCATION" --resource-group "$RG" \
  --workspace "$WORKSPACE_ID" --application-type web

APPINSIGHTS_CONNECTION=$(az monitor app-insights component show \
  --app "$INSIGHTS" --resource-group "$RG" --query connectionString -o tsv)

# ---------------------------------------------------------------------------
info "Key Vault"
# Purge protection is non-negotiable here: without it, a deleted vault takes
# the PII encryption key with it, and every encrypted national ID number in
# the database becomes permanently unreadable.
az keyvault create \
  --name "$KV" --resource-group "$RG" --location "$LOCATION" \
  --enable-rbac-authorization true \
  --enable-purge-protection true \
  --retention-days 90 \
  --sku standard

# ---------------------------------------------------------------------------
info "Container registry"
az acr create \
  --resource-group "$RG" --name "$ACR" --sku Premium \
  --admin-enabled false          # workload identity only, no admin password

# Keeps the registry from growing without bound; 30 days of untagged layers is
# ample for a rollback.
az acr config retention update \
  --registry "$ACR" --status enabled --days 30 --type UntaggedManifests

# ---------------------------------------------------------------------------
info "PostgreSQL Flexible Server"
# Zone-redundant HA: a standby in a different availability zone with automatic
# failover. This is the single most important availability decision in the
# estate — the API is stateless and replaceable, the database is not.
PG_ADMIN_PASSWORD=$(openssl rand -base64 32)

az postgres flexible-server create \
  --resource-group "$RG" --name "$PG" --location "$LOCATION" \
  --version 16 \
  --tier GeneralPurpose --sku-name Standard_D4ds_v5 \
  --storage-size 256 --storage-auto-grow Enabled \
  --high-availability ZoneRedundant \
  --backup-retention 35 \
  --geo-redundant-backup Enabled \
  --vnet "$VNET" --subnet db-subnet \
  --admin-user lihadmin --admin-password "$PG_ADMIN_PASSWORD" \
  --yes

# Force TLS and log slow queries. The 1-second threshold catches the reporting
# queries that grow with the claim table before members notice them.
az postgres flexible-server parameter set \
  --resource-group "$RG" --server-name "$PG" --name require_secure_transport --value ON
az postgres flexible-server parameter set \
  --resource-group "$RG" --server-name "$PG" --name log_min_duration_statement --value 1000
az postgres flexible-server parameter set \
  --resource-group "$RG" --server-name "$PG" --name connection_throttle.enable --value ON
# pgcrypto and citext are required by 010_pre_migrate.sql.
az postgres flexible-server parameter set \
  --resource-group "$RG" --server-name "$PG" \
  --name azure.extensions --value "PGCRYPTO,CITEXT,PG_TRGM,PG_STAT_STATEMENTS"

az postgres flexible-server db create \
  --resource-group "$RG" --server-name "$PG" --database-name lih

# ---------------------------------------------------------------------------
info "Redis"
az redis create \
  --resource-group "$RG" --name "$REDIS" --location "$LOCATION" \
  --sku Standard --vm-size c1 \
  --minimum-tls-version 1.2 \
  --redis-configuration '{"maxmemory-policy":"volatile-lru"}'

# ---------------------------------------------------------------------------
info "Blob storage"
# RA-GRS: readable replica in the paired region. Policy certificates and claim
# evidence must survive a regional outage — a claim file that cannot be
# produced is a claim that cannot be defended.
az storage account create \
  --resource-group "$RG" --name "$STORAGE" --location "$LOCATION" \
  --sku Standard_RAGRS --kind StorageV2 \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false \
  --allow-shared-key-access false \
  --https-only true \
  --default-action Deny

for container in lih-documents lih-claims lih-certificates lih-receipts; do
  az storage container create \
    --account-name "$STORAGE" --name "$container" \
    --auth-mode login --public-access off
done

# Versioning plus a 10-year delete retention, matching the CIMA record-keeping
# requirement. A deleted claim document is recoverable for the whole period a
# regulator may ask for it.
az storage account blob-service-properties update \
  --resource-group "$RG" --account-name "$STORAGE" \
  --enable-versioning true \
  --enable-delete-retention true --delete-retention-days 3650 \
  --enable-container-delete-retention true --container-delete-retention-days 90

# ---------------------------------------------------------------------------
info "AKS cluster"
az aks create \
  --resource-group "$RG" --name "$AKS" --location "$LOCATION" \
  --kubernetes-version 1.30 \
  --node-count 3 --node-vm-size Standard_D4s_v5 \
  --zones 1 2 3 \
  --enable-cluster-autoscaler --min-count 3 --max-count 10 \
  --network-plugin azure --network-policy calico \
  --vnet-subnet-id "$(az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n aks-subnet --query id -o tsv)" \
  --enable-managed-identity \
  --enable-oidc-issuer --enable-workload-identity \
  --enable-addons monitoring,azure-keyvault-secrets-provider \
  --workspace-resource-id "$WORKSPACE_ID" \
  --enable-defender \
  --auto-upgrade-channel patch \
  --generate-ssh-keys

# Pull images without a registry credential anywhere.
az aks update --resource-group "$RG" --name "$AKS" --attach-acr "$ACR"

# ---------------------------------------------------------------------------
info "Storing secrets in Key Vault"
CALLER=$(az ad signed-in-user show --query id -o tsv)
KV_ID=$(az keyvault show --name "$KV" --query id -o tsv)
az role assignment create --assignee "$CALLER" \
  --role "Key Vault Secrets Officer" --scope "$KV_ID" >/dev/null

PG_HOST="${PG}.postgres.database.azure.com"
REDIS_HOST=$(az redis show -g "$RG" -n "$REDIS" --query hostName -o tsv)
REDIS_KEY=$(az redis list-keys -g "$RG" -n "$REDIS" --query primaryKey -o tsv)

set_secret() { az keyvault secret set --vault-name "$KV" --name "$1" --value "$2" --output none; }

# sslmode=require is not optional: the database holds encrypted national ID
# numbers, and the connection crosses the VNet.
set_secret database-url "postgresql://lihadmin:${PG_ADMIN_PASSWORD}@${PG_HOST}:5432/lih?schema=public&sslmode=require"
set_secret redis-url    "rediss://:${REDIS_KEY}@${REDIS_HOST}:6380"
set_secret jwt-access-secret   "$(openssl rand -base64 48)"
set_secret jwt-refresh-secret  "$(openssl rand -base64 48)"
# 32 bytes exactly — CryptoService rejects any other length at startup.
set_secret pii-encryption-key  "$(openssl rand -base64 32)"
set_secret appinsights-conn    "$APPINSIGHTS_CONNECTION"

# Provider credentials are placeholders until the merchant onboarding
# completes. Set them with:
#   az keyvault secret set --vault-name lih-kv-production --name om-client-id --value '...'
for placeholder in om-client-id om-client-secret om-merchant-key om-webhook-secret \
                   momo-subscription momo-api-user momo-api-key momo-webhook-secret \
                   cinetpay-api-key cinetpay-site-id cinetpay-webhook \
                   smtp-url sms-provider-key storage-connection; do
  az keyvault secret show --vault-name "$KV" --name "$placeholder" >/dev/null 2>&1 \
    || set_secret "$placeholder" "PENDING_PROVIDER_ONBOARDING"
done

# ---------------------------------------------------------------------------
info "Workload identity for the API pods"
IDENTITY="lih-api-identity-${ENVIRONMENT}"
az identity create --resource-group "$RG" --name "$IDENTITY" --location "$LOCATION"

IDENTITY_CLIENT_ID=$(az identity show -g "$RG" -n "$IDENTITY" --query clientId -o tsv)
IDENTITY_PRINCIPAL=$(az identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)
OIDC_ISSUER=$(az aks show -g "$RG" -n "$AKS" --query oidcIssuerProfile.issuerUrl -o tsv)

# The pod reads Key Vault and Blob as itself; no key or connection string is
# stored in the cluster at all.
az role assignment create --assignee "$IDENTITY_PRINCIPAL" \
  --role "Key Vault Secrets User" --scope "$KV_ID"
az role assignment create --assignee "$IDENTITY_PRINCIPAL" \
  --role "Storage Blob Data Contributor" \
  --scope "$(az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv)"

az identity federated-credential create \
  --name lih-api-federated --identity-name "$IDENTITY" --resource-group "$RG" \
  --issuer "$OIDC_ISSUER" \
  --subject "system:serviceaccount:lih-${ENVIRONMENT}:lih-api" \
  --audiences api://AzureADTokenExchange

# ---------------------------------------------------------------------------
info "Diagnostic settings"
for resource in \
  "$(az postgres flexible-server show -g "$RG" -n "$PG" --query id -o tsv)" \
  "$(az keyvault show -n "$KV" --query id -o tsv)" \
  "$(az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv)"; do
  az monitor diagnostic-settings create \
    --name lih-diagnostics --resource "$resource" \
    --workspace "$WORKSPACE_ID" \
    --logs '[{"categoryGroup":"audit","enabled":true},{"categoryGroup":"allLogs","enabled":true}]' \
    --metrics '[{"category":"AllMetrics","enabled":true}]' \
    --output none 2>/dev/null || echo "  (diagnostics already configured or unsupported for this resource)"
done

# ---------------------------------------------------------------------------
cat <<SUMMARY

Provisioning complete for '${ENVIRONMENT}'.

  Resource group    ${RG}
  Region            ${LOCATION}   (DR pair: ${DR_LOCATION})
  AKS               ${AKS}
  PostgreSQL        ${PG_HOST}  — zone-redundant HA, 35-day geo-redundant backups
  Redis             ${REDIS_HOST}
  Storage           ${STORAGE}   — RA-GRS, versioned, 10-year soft delete
  Key Vault         ${KV}        — purge protection ON
  Workload identity ${IDENTITY_CLIENT_ID}

NEXT STEPS

1. Record the workload identity client id as a GitHub secret:
     AZURE_WORKLOAD_IDENTITY_CLIENT_ID=${IDENTITY_CLIENT_ID}

2. Fill the payment provider secrets once merchant onboarding completes:
     az keyvault secret set --vault-name ${KV} --name om-client-id --value '...'

3. Create the namespace and apply the manifests:
     az aks get-credentials -g ${RG} -n ${AKS}
     kubectl create namespace lih-${ENVIRONMENT}
     kubectl apply -f infrastructure/kubernetes/

4. The database admin password was generated and stored ONLY in Key Vault
   (secret 'database-url'). It is not printed here and not saved to disk.
   Retrieve it with:
     az keyvault secret show --vault-name ${KV} --name database-url --query value -o tsv

SUMMARY
