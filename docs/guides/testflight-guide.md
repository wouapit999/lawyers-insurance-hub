# TestFlight publishing guide

Getting the iOS app into the hands of Cameroon Bar Association members for
pilot testing, before App Store release.

Budget **2–3 weeks** end to end. The long poles are Apple's Developer Program
enrolment (up to 2 weeks for an organisation) and the first App Review pass on
the TestFlight build, not the build itself.

---

## 1. Apple Developer Program enrolment

Enrol as an **organisation**, not an individual. An individual account puts a
personal name on the App Store listing, and cannot add team members — a
problem the day someone other than you needs to ship a build.

You will need:

| Requirement | Notes for Cameroon |
|---|---|
| Legal entity name | Must match the Bouquet Innovation registration exactly |
| D-U-N-S number | Free from Dun & Bradstreet; allow 5–10 business days |
| Legal authority to bind the entity | Apple phones to verify |
| US $99 / year | Card payment |

Start the D-U-N-S lookup first: it gates everything else and is the step that
most often stalls.

→ https://developer.apple.com/programs/enroll/

## 2. App Store Connect — create the app record

At https://appstoreconnect.apple.com → **Apps** → **+**:

| Field | Value |
|---|---|
| Platform | iOS |
| Name | Lawyers Insurance Hub |
| Primary language | **French (France)** — Cameroon's dominant legal-practice language |
| Bundle ID | `cm.lih.app` (register in the Developer portal first) |
| SKU | `LIH-IOS-001` |
| User Access | Full Access |

Add English (U.K.) as a second localisation. A French-only listing reads as an
oversight to the anglophone bar in the North-West and South-West.

## 3. Certificates and provisioning

### 3.1 Distribution certificate

On a Mac:

```bash
openssl genrsa -out ios_distribution.key 2048 && openssl req -new -key ios_distribution.key -out ios_distribution.csr -subj "/emailAddress=rwouapit@bouquet-innovation.net/CN=Bouquet Innovation/C=CM"
```

Upload the `.csr` at Developer portal → **Certificates** → **+** → *Apple
Distribution*. Download the resulting `.cer`, then convert to the `.p12` the
pipeline needs:

```bash
openssl x509 -in distribution.cer -inform DER -out distribution.pem -outform PEM && openssl pkcs12 -export -inkey ios_distribution.key -in distribution.pem -out ios_distribution.p12
```

Choose a strong export password — it becomes `IOS_DIST_CERTIFICATE_PASSWORD`.

### 3.2 Provisioning profile

Developer portal → **Profiles** → **+** → *App Store Connect* → select bundle
ID `cm.lih.app` and the distribution certificate. Download the
`.mobileprovision`.

### 3.3 App Store Connect API key

Users and Access → **Integrations** → **App Store Connect API** → **+**, role
*App Manager*. Download the `.p8` — **it can be downloaded exactly once**.

An API key rather than an Apple ID password: it is scoped, revocable, and does
not break when a 2FA prompt appears on someone's phone at 2 a.m.

### 3.4 Load the secrets into GitHub

```bash
gh secret set IOS_DIST_CERTIFICATE_BASE64 --env mobile-release --body "$(base64 -w0 ios_distribution.p12)"
gh secret set IOS_PROVISIONING_PROFILE_BASE64 --env mobile-release --body "$(base64 -w0 LIH_AppStore.mobileprovision)"
gh secret set APP_STORE_CONNECT_KEY_BASE64 --env mobile-release --body "$(base64 -w0 AuthKey_XXXXXXXXXX.p8)"
gh secret set APP_STORE_CONNECT_KEY_ID --env mobile-release --body "XXXXXXXXXX"
gh secret set APP_STORE_CONNECT_ISSUER_ID --env mobile-release --body "<Issuer ID from the API keys page>"
gh secret set IOS_KEYCHAIN_PASSWORD --env mobile-release --body "$(openssl rand -base64 24)"
gh secret set IOS_DIST_CERTIFICATE_PASSWORD --env mobile-release
```

## 4. Export options

`mobile-app/ios/ExportOptions.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store</string>
  <key>teamID</key><string>YOUR_TEAM_ID</string>
  <key>uploadSymbols</key><true/>
  <key>signingStyle</key><string>manual</string>
  <key>provisioningProfiles</key>
  <dict><key>cm.lih.app</key><string>LIH AppStore Profile</string></dict>
</dict>
</plist>
```

## 5. Ship a build to TestFlight

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Or manually: **Actions** → *Release · Mobile* → **Run workflow** → platform
`ios`.

Apple processes the build in 10–30 minutes, after which it appears under
TestFlight in App Store Connect.

## 6. Export compliance — answer this correctly

Apple asks whether the app uses encryption. **Yes** — HTTPS, and AES-256-GCM
for the identity numbers held on device.

It then asks whether the encryption is exempt. **Yes**: the app uses only
standard encryption in the operating system and standard HTTPS, which falls
under the exemption in category 5D992. Declare this once in App Store Connect
and it applies to subsequent builds.

Answering carelessly here is the most common reason a first TestFlight build
sits unavailable.

## 7. Set up the pilot tester group

### Internal testing — up to 100 users, no review, available immediately

TestFlight → **Internal Testing** → **+**. Add the Bouquet Innovation team and
the insurer's claims and finance staff. Builds reach them within minutes of
processing.

### External testing — the Bar cohort, up to 10,000 users

TestFlight → **External Testing** → **+** → name the group
**"Cameroon Bar Association Pilot"**.

The first external build needs **Beta App Review** — usually 24–48 hours.
Provide:

| Field | What to write |
|---|---|
| Beta App Description | The bilingual pilot description below |
| Feedback email | pilot@lih.cm |
| Demo account | A pre-verified account on **staging**, never production |
| Notes for reviewer | See below — this is the part that prevents a rejection |

**Notes for the reviewer** — Apple's reviewer is not a Cameroonian advocate
and will otherwise be blocked at the first screen:

> This app is restricted to advocates registered with the Cameroon Bar
> Association. Account creation requires a Bar registration number that is
> verified against the Bar's register, so the reviewer cannot self-register.
>
> Please use the demo account below, which is pre-verified on our staging
> environment and holds sample policies and claims:
>
> Email: `reviewer@demo.lih.cm` · Password: (supplied in App Store Connect)
>
> Payments in this build use provider sandboxes; no real money moves.
> Insurance products are underwritten by our licensed partner insurer under
> CIMA regulation.

**Beta App Description** (both locales):

> **FR** — Lawyers Insurance Hub permet aux avocats inscrits au Barreau du
> Cameroun de souscrire, payer et gérer leurs assurances, et de déclarer leurs
> sinistres depuis leur téléphone. Paiement par Orange Money et MTN Mobile
> Money. Application entièrement bilingue.
>
> **EN** — Lawyers Insurance Hub lets advocates registered with the Cameroon
> Bar Association subscribe to, pay for and manage their insurance, and file
> claims from their phone. Payment by Orange Money and MTN Mobile Money.
> Fully bilingual.

### Inviting the testers

Use a **public link** (TestFlight → group → *Enable Public Link*) rather than
collecting 500 email addresses. The Bar can circulate one URL through its own
channels, and members join themselves — far less friction than an invitation
list someone has to maintain.

## 8. What to ask testers to check

Give the pilot cohort a specific list; "try the app" produces no useful
feedback:

1. Register with your real Bar number and confirm verification completes.
2. Compare two professional-liability plans and request a quotation.
3. Pay a premium with **your own** Orange Money or MTN MoMo number — this is
   the flow that most needs real-world testing across both networks.
4. Download the certificate and confirm the French text is correct and the
   amount reads properly.
5. File a test vehicle claim with photos, **with mobile data turned off**, and
   confirm it syncs when you reconnect.
6. Switch the app to English and back, and report anything untranslated or
   any text that overflows its button.

Point 3 matters most. Mobile-money behaviour varies by network, by handset and
by region, and no amount of sandbox testing substitutes for real numbers on
real networks in Douala and Yaoundé.

## 9. Build expiry

TestFlight builds expire after **90 days**. Plan a refresh build roughly every
60 days during a long pilot, or testers will find the app has silently stopped
working.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "No suitable application records found" | Bundle ID in Xcode does not match App Store Connect. Check `cm.lih.app` exactly |
| "Invalid Swift Support" | Rebuild with `flutter build ipa`, not a manual `xcodebuild` |
| Build processes then disappears | Almost always the export compliance question. Answer it in App Store Connect |
| `altool` authentication fails | Check the `.p8` is base64'd with `-w0` — a wrapped key silently fails to parse |
| External build stuck "Waiting for Review" > 3 days | Contact App Review; a missing demo account is the usual reason |
