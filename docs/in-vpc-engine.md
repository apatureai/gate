# In-VPC judgment-engine (enterprise data residency)

Spec: TRD §6, §8, §15.5; ARCHITECTURE §3/§4 (D3).

Enterprise accounts can run `judgment-engine` inside their own VPC so screenshots
(real staging PII) never leave their cloud. Gate stays the same thin GitHub
surface — only the engine endpoint changes.

## How it works

- Each account has an optional `engineEndpoint` in its config, **KMS-encrypted at
  rest** (decrypted only at point of use). It defaults to the hosted engine.
- When set, every `POST/GET/DELETE /jobs` call routes to the customer's in-VPC
  engine (`createAccountEngineTransport` → `resolveEngineRoute`). `engineEndpoint`
  is **Gate-internal routing**, never a `GateReviewRequest` field — the request
  contract is identical hosted vs in-VPC.
- The Gate↔engine seam (async job protocol #45, HMAC auth #47, x-schema-version
  + Zod parse #46) is unchanged; in-VPC just relocates where the engine runs.

## Data-residency guarantee: no silent fallback

An in-VPC account's transport targets **only** the in-VPC endpoint. There is no
code path that retries against the hosted engine. If the in-VPC engine is
unreachable, the review surfaces an explicit error / `not_reviewed`
(`decideDeliveryForError("engine_unavailable")`, #38) and the PR gets a neutral
Check Run — Gate **never** falls back to the hosted engine, so screenshots can
never transit a third party.

## What stays managed

There is **no BYOK** (it adds consumer friction). Standard and paid accounts use
fully-managed hosted serving with zero customer key management; Apature runs the
model. In-VPC is purely a data-residency relocation of the engine, gated to the
enterprise tier (#20).
