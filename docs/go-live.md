# Go-live runbook (#64)

Provisioning + secrets to take Gate live. These need real cloud accounts/credentials and are **operator actions**, not build-loop code. The app enforces the env half of this at boot: pass `process.env` as `env` to the production server and `start()` throws one aggregated error listing every missing required variable (`assertProductionEnv` / `PRODUCTION_ENV_VARS`, `@gate/service`). Set everything below, then deploy.

## Required environment variables (fail-fast checked)

`PRODUCTION_ENV_VARS` (derived from `@gate/secrets` + infra URLs) — `start()` refuses to serve if any is missing/blank:

| Variable | Purpose |
|---|---|
| `GITHUB_APP_ID` | GitHub App id for JWT minting |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App auth (JWT → installation tokens) |
| `GITHUB_WEBHOOK_SECRET` | Verify inbound webhook signatures |
| `JUDGMENT_ENGINE_ENDPOINT` | Hosted engine `/jobs` base URL |
| `JUDGMENT_ENGINE_API_KEY` | Engine auth |
| `JUDGMENT_ENGINE_HMAC_SECRET` | Sign engine job requests |
| `STRIPE_SECRET_KEY` | Billing API |
| `STRIPE_WEBHOOK_SECRET` | Verify Stripe webhook signatures |
| `DATABASE_URL` | Postgres (runs, findings, feedback, billing) |
| `REDIS_URL` | Redis (supersession `sha:`, token-buckets, quotas) |
| `GATE_SCREENSHOT_OBJECT_URL_TEMPLATE` | Absolute screenshot object URL template containing `{objectKey}` for `/i/:artifactId.png` redirects |
| `SCREENSHOT_CAPABILITY_SECRET` | Verify private screenshot capability tokens |
| `FEEDBACK_TOKEN_SECRET` | Verify one-time feedback POST tokens |

Per-repo / optional (not boot-required): Vercel `protection_bypass` (per-repo config), `OTEL_EXPORTER_OTLP_ENDPOINT` (observability).

## Provisioning checklist

- [ ] **Branch protection** on `main`: require the CI check (`lint · typecheck · test`) before merge.
- [ ] **Postgres** (Neon/Fly): provision; set `DATABASE_URL`; run migrations (Fly release command, #33); app connects as a **non-superuser without BYPASSRLS** so RLS (#50) holds.
- [ ] **Redis** (Upstash/Fly): `maxmemory-policy=noeviction` (#34); set `REDIS_URL`. `runStartupChecks` fails fast otherwise.
- [ ] **Fly app** `apature-gate`: configure deploy (#32); `fly secrets set` for every variable above + the per-repo/optional ones.
- [ ] **Artifact routes**: set `GATE_SCREENSHOT_OBJECT_URL_TEMPLATE` to the engine/object-store signed-read template, for example `https://objects.example.com/{objectKey}?signature=...`; Gate URL-encodes `{objectKey}` and redirects only after `/i` authorization.
- [ ] **AWS KMS**: bind `SecretStore`/`KmsKeyProvider` (#35) to real KMS; per-tenant CMK for enterprise crypto-shredding (#52/#20).
- [ ] **GitHub App**: create from the manifest (`buildAppManifest`, #21) with minimal scopes (never `contents: write`); webhook URL → deployed `/webhook`.
- [ ] **Observability**: point OTLP at the collector; load `observability/alerts.yaml` + `observability/dashboard.json` (#36).
- [ ] **Marketplace + demo** (GTM): publisher verification, listing assets, demo recording, scheduled live smoke test.

## Verifying the env half locally

```ts
import { checkRequiredEnv } from "@gate/service";
const { ok, missing } = checkRequiredEnv(process.env);
if (!ok) console.error("missing:", missing);
```

Or just boot with `env: process.env` and read the thrown error — it names everything missing in one pass.
