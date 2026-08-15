#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# GitHub Actions -> Azure authentication via OIDC federated credentials.
#
# What this replaces: a service principal secret stored as AZURE_CREDENTIALS.
# That JSON blob is a long-lived key to the subscription, it sits in GitHub
# until someone remembers to rotate it, and it is one of the most common ways
# a cloud account is taken over. With federation there is no secret at all —
# GitHub mints a short-lived token per run, and Azure trusts it only for the
# exact repository, branch and environment named in the credential.
#
# Run once per subscription:
#   az login
#   ./setup-oidc.sh
#
# Idempotent: safe to re-run, and re-running is how you converge drift.
# ---------------------------------------------------------------------------
set -euo pipefail

GITHUB_ORG="wouapit999"
GITHUB_REPO="lawyers-insurance-hub"
APP_NAME="github-lih-deploy"

# Resource groups the pipeline may touch. Scope is per-group, never
# subscription-wide: a compromised pipeline should not be able to reach
# resources outside the ones it deploys.
RESOURCE_GROUPS=(
  "lih-rg-production"
  "lih-rg-staging"
  "lih-rg-dev"
)

info()  { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
warn()  { printf '\033[1;33m    %s\033[0m\n' "$1"; }
ok()    { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }

# --- preflight --------------------------------------------------------------
command -v az >/dev/null || { echo "Azure CLI is not installed."; exit 1; }
command -v gh >/dev/null || { echo "GitHub CLI is not installed."; exit 1; }

az account show >/dev/null 2>&1 || {
  echo "Not logged in to Azure. Run: az login"
  exit 1
}

gh auth status >/dev/null 2>&1 || {
  echo "Not logged in to GitHub. Run: gh auth login"
  exit 1
}

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
SUBSCRIPTION_NAME=$(az account show --query name -o tsv)

info "Target"
echo "    Subscription : $SUBSCRIPTION_NAME"
echo "    Id           : $SUBSCRIPTION_ID"
echo "    Tenant       : $TENANT_ID"
echo "    Repository   : $GITHUB_ORG/$GITHUB_REPO"

# --- 1. application registration -------------------------------------------
info "Entra ID application"
APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv 2>/dev/null || true)

if [ -z "$APP_ID" ] || [ "$APP_ID" = "null" ]; then
  APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
  ok "created $APP_NAME ($APP_ID)"
else
  ok "reusing existing $APP_NAME ($APP_ID)"
fi

# --- 2. service principal ---------------------------------------------------
info "Service principal"
SP_ID=$(az ad sp list --filter "appId eq '$APP_ID'" --query "[0].id" -o tsv 2>/dev/null || true)

if [ -z "$SP_ID" ] || [ "$SP_ID" = "null" ]; then
  SP_ID=$(az ad sp create --id "$APP_ID" --query id -o tsv)
  ok "created (object id $SP_ID)"
  # Entra ID replication is eventually consistent; a role assignment issued
  # immediately after creation frequently fails with "principal not found".
  warn "waiting 20s for directory replication…"
  sleep 20
else
  ok "reusing existing (object id $SP_ID)"
fi

# --- 3. role assignments ----------------------------------------------------
info "Role assignments"
for RG in "${RESOURCE_GROUPS[@]}"; do
  SCOPE="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RG"

  if ! az group show --name "$RG" >/dev/null 2>&1; then
    warn "$RG does not exist yet — skipping (run provision.sh first, then re-run this)"
    continue
  fi

  # Contributor deploys the workload. Deliberately NOT Owner: the pipeline has
  # no business granting roles, and Owner would let a compromised workflow
  # give itself permanent access.
  if az role assignment list --assignee "$APP_ID" --scope "$SCOPE" \
       --query "[?roleDefinitionName=='Contributor']" -o tsv | grep -q .; then
    ok "$RG — Contributor already assigned"
  else
    az role assignment create --assignee "$APP_ID" --role Contributor \
      --scope "$SCOPE" --output none
    ok "$RG — Contributor assigned"
  fi

  # Needed to push images to ACR in that group.
  if az role assignment list --assignee "$APP_ID" --scope "$SCOPE" \
       --query "[?roleDefinitionName=='AcrPush']" -o tsv | grep -q .; then
    ok "$RG — AcrPush already assigned"
  else
    az role assignment create --assignee "$APP_ID" --role AcrPush \
      --scope "$SCOPE" --output none 2>/dev/null \
      && ok "$RG — AcrPush assigned" \
      || warn "$RG — AcrPush not assigned (no registry in this group yet)"
  fi
done

# --- 4. federated credentials ----------------------------------------------
# One per trust relationship. The `subject` is what Azure matches against the
# token GitHub presents, so each is scoped as narrowly as the workflow allows.
info "Federated credentials"

add_credential() {
  local name="$1" subject="$2" description="$3"

  if az ad app federated-credential list --id "$APP_ID" \
       --query "[?name=='$name'].name" -o tsv 2>/dev/null | grep -q .; then
    ok "$name already exists"
    return
  fi

  az ad app federated-credential create --id "$APP_ID" --parameters "{
    \"name\": \"$name\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"$subject\",
    \"description\": \"$description\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" --output none
  ok "$name -> $subject"
}

# Environment-scoped. These match the `environment:` key in deploy-azure.yml,
# so a workflow run only receives a token for the environment it declares —
# a run targeting staging cannot obtain production credentials.
add_credential "github-production" \
  "repo:$GITHUB_ORG/$GITHUB_REPO:environment:production" \
  "Production deployments from the production environment"

add_credential "github-staging" \
  "repo:$GITHUB_ORG/$GITHUB_REPO:environment:staging" \
  "Staging deployments"

add_credential "github-dev" \
  "repo:$GITHUB_ORG/$GITHUB_REPO:environment:dev" \
  "Development deployments"

# Branch-scoped, for workflows that run without an environment (the
# infrastructure plan job). Note there is deliberately NO pull_request
# credential: a PR from a fork must never be able to authenticate to Azure.
add_credential "github-branch-main" \
  "repo:$GITHUB_ORG/$GITHUB_REPO:ref:refs/heads/main" \
  "Workflows on main that do not declare an environment"

# --- 5. GitHub secrets ------------------------------------------------------
info "GitHub repository secrets"
REPO="$GITHUB_ORG/$GITHUB_REPO"

gh secret set AZURE_CLIENT_ID       --repo "$REPO" --body "$APP_ID"          && ok "AZURE_CLIENT_ID"
gh secret set AZURE_TENANT_ID       --repo "$REPO" --body "$TENANT_ID"       && ok "AZURE_TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$REPO" --body "$SUBSCRIPTION_ID" && ok "AZURE_SUBSCRIPTION_ID"

# --- 6. verification --------------------------------------------------------
info "Verification"
CRED_COUNT=$(az ad app federated-credential list --id "$APP_ID" --query "length(@)" -o tsv)
echo "    Federated credentials : $CRED_COUNT"
az ad app federated-credential list --id "$APP_ID" \
  --query "[].{name:name, subject:subject}" -o table 2>/dev/null || true

echo ""
echo "    Role assignments:"
az role assignment list --assignee "$APP_ID" --all \
  --query "[].{role:roleDefinitionName, scope:scope}" -o table 2>/dev/null || true

cat <<SUMMARY

OIDC configured. No secret was created or stored anywhere.

  Client id       ${APP_ID}
  Tenant id       ${TENANT_ID}
  Subscription    ${SUBSCRIPTION_ID}

WHAT TO CHECK NEXT

1. The deploy workflow authenticates with azure/login@v2 using these three
   values and 'id-token: write'. Both are already in deploy-azure.yml.

2. Trigger a dev deployment to prove the trust works end to end:

     gh workflow run deploy-azure.yml --repo ${REPO} -f environment=dev

3. If a run fails with AADSTS70021 ("no matching federated identity record"),
   the token's subject did not match any credential. Print the subject the run
   actually presented and compare it with the list above — the usual cause is
   a workflow declaring a different environment name.

SUMMARY
