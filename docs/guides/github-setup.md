# GitHub setup — `wouapit999/lawyers-insurance-hub`

Exact commands to take this repository from a local folder to a protected,
CI-enabled GitHub repository.

---

## 1. Initialise and push

```bash
cd ~/Documents/Lawyers-Insurance-Hub/lih
```

```bash
git init -b main
```

Before the first commit, confirm nothing sensitive is staged. This platform
holds identity numbers and payment credentials — a secret in the first commit
lives in the history permanently, even if a later commit removes it:

```bash
git add --all --dry-run | grep -iE "\.env$|\.pem$|\.p12$|\.jks$|key\.properties|secrets\.yaml$"
```

That must print nothing. Then:

```bash
git add . && git commit -m "chore: initial commit — LIH platform, infrastructure and CI/CD"
```

Create the repository (private — this is proprietary and holds trade-secret
rating tables):

```bash
gh repo create wouapit999/lawyers-insurance-hub --private --source=. --remote=origin --push
```

Without the `gh` CLI:

```bash
git remote add origin https://github.com/wouapit999/lawyers-insurance-hub.git && git push -u origin main
```

## 2. Create the branches

```bash
git checkout -b develop && git push -u origin develop && git checkout -b staging && git push -u origin staging && git checkout -b production && git push -u origin production && git checkout main
```

## 3. Protect the branches

`production` gets the strictest rules: it deploys real money movement.

```bash
gh api -X PUT repos/wouapit999/lawyers-insurance-hub/branches/production/protection \
  -F required_status_checks[strict]=true \
  -F 'required_status_checks[contexts][]=CI passed' \
  -F enforce_admins=true \
  -F required_pull_request_reviews[required_approving_review_count]=2 \
  -F required_pull_request_reviews[dismiss_stale_reviews]=true \
  -F required_pull_request_reviews[require_code_owner_reviews]=true \
  -F restrictions=null \
  -F required_linear_history=true \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

```bash
gh api -X PUT repos/wouapit999/lawyers-insurance-hub/branches/staging/protection \
  -F required_status_checks[strict]=true \
  -F 'required_status_checks[contexts][]=CI passed' \
  -F enforce_admins=false \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F restrictions=null -F allow_force_pushes=false -F allow_deletions=false
```

```bash
gh api -X PUT repos/wouapit999/lawyers-insurance-hub/branches/main/protection \
  -F required_status_checks[strict]=true \
  -F 'required_status_checks[contexts][]=CI passed' \
  -F enforce_admins=false \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F restrictions=null -F allow_force_pushes=false -F allow_deletions=false
```

## 4. Enable the security features

```bash
gh api -X PATCH repos/wouapit999/lawyers-insurance-hub \
  -F security_and_analysis[secret_scanning][status]=enabled \
  -F security_and_analysis[secret_scanning_push_protection][status]=enabled \
  -F security_and_analysis[dependabot_security_updates][status]=enabled
```

Push protection is the one that earns its keep: it blocks a commit containing
a recognised credential *before* it reaches the remote, rather than alerting
after the key is already public.

## 5. Create the environments

Environments carry the deployment secrets and the production approval gate.

```bash
gh api -X PUT repos/wouapit999/lawyers-insurance-hub/environments/dev
gh api -X PUT repos/wouapit999/lawyers-insurance-hub/environments/staging
gh api -X PUT repos/wouapit999/lawyers-insurance-hub/environments/mobile-release
```

Production requires a human to approve, and only from the production branch:

```bash
gh api -X PUT repos/wouapit999/lawyers-insurance-hub/environments/production \
  -F "reviewers[][type]=User" \
  -F "reviewers[][id]=$(gh api users/wouapit999 --jq .id)" \
  -F deployment_branch_policy[protected_branches]=true \
  -F deployment_branch_policy[custom_branch_policies]=false
```

## 6. Azure OIDC — no stored cloud credential

Federated credentials mean GitHub mints a short-lived token per run instead of
holding a long-lived service principal secret. A leaked `AZURE_CREDENTIALS`
JSON is one of the most common cloud compromises; this removes the thing that
would leak.

```bash
az ad app create --display-name "github-lih-deploy" --query appId -o tsv
```

Take that app id as `$APP_ID`, then:

```bash
az ad sp create --id "$APP_ID"
```

```bash
az role assignment create --assignee "$APP_ID" --role Contributor --scope "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/lih-rg-production"
```

Register one federated credential per environment (repeat for `staging` and
`dev`):

```bash
az ad app federated-credential create --id "$APP_ID" --parameters '{"name":"github-production","issuer":"https://token.actions.githubusercontent.com","subject":"repo:wouapit999/lawyers-insurance-hub:environment:production","audiences":["api://AzureADTokenExchange"]}'
```

## 7. Repository and environment secrets

Repository-level (all environments):

```bash
gh secret set AZURE_CLIENT_ID --body "$APP_ID"
gh secret set AZURE_TENANT_ID --body "$(az account show --query tenantId -o tsv)"
gh secret set AZURE_SUBSCRIPTION_ID --body "$(az account show --query id -o tsv)"
```

Vercel:

```bash
gh secret set VERCEL_TOKEN --body "<token from vercel.com/account/tokens>"
gh secret set VERCEL_ORG_ID --body "<from .vercel/project.json after 'vercel link'>"
gh secret set VERCEL_PROJECT_ID --body "<from .vercel/project.json>"
```

Mobile release (scoped to the `mobile-release` environment so an ordinary PR
workflow cannot read the signing keys):

```bash
gh secret set ANDROID_KEYSTORE_BASE64 --env mobile-release --body "$(base64 -w0 upload-keystore.jks)"
gh secret set ANDROID_KEYSTORE_PASSWORD --env mobile-release
gh secret set ANDROID_KEY_PASSWORD --env mobile-release
gh secret set ANDROID_KEY_ALIAS --env mobile-release
gh secret set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON --env mobile-release < play-service-account.json
gh secret set IOS_DIST_CERTIFICATE_BASE64 --env mobile-release
gh secret set IOS_DIST_CERTIFICATE_PASSWORD --env mobile-release
gh secret set IOS_PROVISIONING_PROFILE_BASE64 --env mobile-release
gh secret set IOS_KEYCHAIN_PASSWORD --env mobile-release
gh secret set APP_STORE_CONNECT_KEY_ID --env mobile-release
gh secret set APP_STORE_CONNECT_ISSUER_ID --env mobile-release
gh secret set APP_STORE_CONNECT_KEY_BASE64 --env mobile-release
```

> **Keep an offline copy of `upload-keystore.jks`.** If it is lost, the
> Android app can never be updated under the same Play listing again. Store it
> in the company safe, not only in GitHub secrets.

## 8. Verify

```bash
gh workflow list && gh run list --limit 5
```

Then open a throwaway pull request into `develop` and confirm the CI checks
appear and the Vercel preview URL is commented.

---

## What the branches do

| Branch | Deploys | Approval |
|---|---|---|
| `main` | nothing — trunk that features cut from | 1 review |
| `develop` | dev.lih.cm + Vercel preview | CI green |
| `staging` | staging.lih.cm — UAT with the Bar pilot cohort | 1 review |
| `production` | api.lih.cm + app.lih.cm | 2 reviews + manual environment approval |
