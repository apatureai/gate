# Queue migration path: BullMQ → Inngest

Spec: TRD §5, §12, §15.3; ARCHITECTURE §8 (D2).

Gate's orchestration depends only on the `ReviewJobWorker` interface
(`enqueue` / `cancel` / `onJob`), never on BullMQ directly. This document is the
pre-decided migration path so the swap is mechanical if the trigger fires.

## Why a migration path exists

BullMQ **cannot preempt an active job**. Gate's supersession is therefore
*disciplined*, not structural: on a newer push we abort the in-flight job's
`AbortSignal` (cooperative) and rely on the **publish-time SHA guard** as the
correctness backstop. If that discipline ever slips, stale results could reach
publish.

## Trigger

Migrate when the **stale-publish rate is non-zero for two consecutive weeks**
(the `gate_stale_publish_total` alert, #36). That is the signal that cooperative
cancellation + the publish guard are not enough in practice.

## Target: Inngest singleton cancel mode

Inngest makes supersession **structural**:

```ts
inngest.createFunction(
  { id: "review", singleton: { key: "event.data.repoPr", mode: "cancel" } },
  { event: "gate/review.requested" },
  async ({ event, step }) => { /* ... */ },
);
```

`singleton: { key: "repo#pr", mode: "cancel" }` cancels the prior run for the
same `repo#pr` automatically — the newest push wins without manual abort
bookkeeping.

## What stays the same

- The `ReviewJobWorker` interface and all orchestration code that depends on it.
- The **publish-time SHA guard remains queue-agnostic** and is retained under any
  adapter — it is the invariant backstop, not a BullMQ detail.
- `ReviewJobPayload` (IDs/refs only) and the durable completed-review identity
  `(repo_owner, repo_name, pr_number, head_sha)`.

## What changes

- Replace `createBullReviewWorker` with an `createInngestReviewWorker` that
  implements the same interface; `enqueue` sends an event, `cancel` is handled by
  singleton mode, `onJob` registers the Inngest function.
- The `cb:engine` circuit breaker and token-bucket move to Inngest concurrency/
  throttling controls where applicable.
