# user-ai_antigravity

Google Antigravity (`agy`) as a browser terminal on GCP Cloud Run (us-central1).

- Image source: `src/` (Dockerfile, entrypoint.sh, toolbar_inject.html). One container: oauth2-proxy (Google provider) on `$PORT` 8080 in front of ttyd on 127.0.0.1:7681.
- Runtime declaration (the one source): cloudy-t-infra `c_vps/vps_gcloud/src/terraform.json` → `cloud_run_services[name=agy]` (2 vCPU, 2 GiB, min 1 instance, gen2, session affinity, GCS volume `<project>-antigravity-persist` on `/persist`).
- Image build: `.github/workflows/cloud-run-images.yml` (manual dispatch, linux/amd64, pushes to the declared Artifact Registry path).
- Secrets: referenced by Secret Manager name only (`agy-oauth-client-id`, `agy-oauth-client-secret`, `agy-cookie-secret`, `agy-allowed-email`) and injected as `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `COOKIE_SECRET`, `ALLOWED_EMAIL`. No value lives in this repo.
- Not a VM compose service: there is no build.json here, so Ship does not render or deploy it; Terraform in cloudy-t-infra owns it once `managed` is set.
