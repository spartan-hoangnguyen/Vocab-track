# Automatic release

`.github/workflows/release.yml` releases the extension to the Chrome Web Store.
It runs only when you start it. Each release waits days for Google's review, so
merges collect on `main` until you release them together. The decisions are in
`tools/release.py`. This page explains how to release, what a run does, and the
one-time setup.

## How to release

1. Pull `main` and make sure that it holds what you want to ship.
2. Start the workflow:

   ```bash
   gh workflow run release.yml
   gh run watch
   ```

   Or open **Actions > release > Run workflow** on GitHub. Leave **dry_run**
   off to release. Turn it on to check sign-in and packaging only.
3. The log ends with `submitted: PENDING_REVIEW`. Chrome publishes the version
   when the review passes.
4. Pull `main` again. The run pushed a `chore(release): vX.Y.Z` commit.

## What a run does

1. The workflow runs `tools/release.py selftest` and `test/run.sh`. If the tests
   fail three times, the run stops and releases nothing.
2. The script asks the store for the item status. If a version is in review, the
   run stops. A new upload restarts a review, and an in-depth review takes days.
3. The script reads the commit subjects since the last `v*` tag:

   | Commit | Release |
   |---|---|
   | `feat(...)!:` or `BREAKING CHANGE` | major: `0.3.0` → `1.0.0` |
   | `feat` | minor: `0.3.0` → `0.4.0` |
   | `fix`, `perf` | patch: `0.3.0` → `0.3.1` |
   | anything else (`docs`, `test`, `chore`, `refactor`) | no release |

4. The script commits the new version to `manifest.json` as
   `chore(release): vX.Y.Z`, tags it, and pushes both to `main`.
5. The script builds the tag with `tools/package.sh`, uploads the zip, and
   submits it for review. Chrome publishes the version when the review passes.

If a version is in review, the run stops and releases nothing. Start it again
after the review clears. If an upload fails after the push, the next run finds a
tag newer than the store and uploads that tag.

## One-time setup

Do these steps once. Until the GitHub variables exist, the workflow skips and
does nothing. This setup is complete for this repository.

### 1. Make sure that the account is ready

The publisher account (`quanghoang0016@gmail.com`) must have 2-Step
Verification on. The store refuses API publishing without it.

### 2. Create the service account and the GitHub trust

Run these commands in a shell with `gcloud` signed in to the project owner:

```bash
PROJECT=vocab-track-512107
REPO=spartan-hoangnguyen/Vocab-track
NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
SA=cws-release@$PROJECT.iam.gserviceaccount.com

gcloud services enable chromewebstore.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com --project $PROJECT

gcloud iam service-accounts create cws-release --project $PROJECT \
  --display-name 'Chrome Web Store release from GitHub'

gcloud iam workload-identity-pools create github --project $PROJECT \
  --location global --display-name GitHub

gcloud iam workload-identity-pools providers create-oidc vocab-track --project $PROJECT \
  --location global --workload-identity-pool github \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' \
  --attribute-condition "assertion.repository=='$REPO' && assertion.ref=='refs/heads/main'"

MEMBER="principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"
for ROLE in roles/iam.workloadIdentityUser roles/iam.serviceAccountTokenCreator; do
  gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT \
    --role $ROLE --member "$MEMBER"
done

echo "GCP_WIF_PROVIDER=projects/$NUMBER/locations/global/workloadIdentityPools/github/providers/vocab-track"
echo "GCP_SERVICE_ACCOUNT=$SA"
```

The attribute condition lets only `main` of this repository get a token. A
branch or a fork cannot release.

### 3. Give the service account access to the store

In the Chrome Web Store Developer Dashboard, open **Account** and add the
service account email (`cws-release@vocab-track-512107.iam.gserviceaccount.com`).
A publisher can have one service account. Then copy the **Publisher ID** from
**Publisher > Settings**.

### 4. Set the GitHub variables

These values are identifiers, not secrets:

```bash
gh variable set GCP_WIF_PROVIDER --body '<GCP_WIF_PROVIDER from step 2>'
gh variable set GCP_SERVICE_ACCOUNT --body 'cws-release@vocab-track-512107.iam.gserviceaccount.com'
gh variable set CWS_PUBLISHER_ID --body '<Publisher ID from step 3>'
```

### 5. Create the bootstrap tag

The script counts commits from the last `v*` tag. Version 0.2.0 was submitted
on 2026-10-19 from commit `c37cbaf`, the last commit to touch `manifest.json`
before that date. If you built that zip from another commit, tag that one:

```bash
git tag v0.2.0 c37cbaf
git push origin v0.2.0
```

### 6. Do a dry run

```bash
gh workflow run release.yml -f dry_run=true
gh run watch
```

The identity pool accepts only runs on `main`. A run started on another branch
fails at sign-in.

A dry run tests, signs in, reads the store status, and packages the last tag. It
uploads nothing.

## Known limits

- Google documents service accounts for the store API, but not a token from
  Workload Identity Federation. The dry run is the proof. If the sign-in step
  fails, the error names the missing role.
- The API publish keeps the current visibility (Unlisted). If you change the
  visibility in the dashboard, publish once by hand. After that, the API can
  publish again.
- If an upload succeeds and the submit fails, the next run uploads the same
  version again. The store can refuse it. Then submit the draft in the
  dashboard by hand.
- Partial rollout (`deployPercentage`) needs more than 10,000 weekly users, so
  every release goes to 100%.
