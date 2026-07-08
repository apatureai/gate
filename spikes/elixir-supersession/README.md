# elixir-supersession (BEAM spike)

Founder-directed language spike executing the Elixir revisit gate that core
ADR-0001 and pointer's ADRs left as prose: model gate's supersession queue as OTP
processes and report honestly what the BEAM buys and costs.

## What it models (mirroring `packages/service/src/{queue,supersession}.ts` exactly)

- Supersession/dedup key `owner/name#pr` — at most one pending review per PR,
  **newest push wins** (remove-then-add).
- Abort signal to a superseded in-flight job (the TS `AbortController`, here a
  message; cooperative in both worlds).
- The **publish-time SHA guard**: publish only if the job's sha still equals
  `current_sha`; stale results are discarded, never published.
- Deliberately NOT modeled: the durable completed-review identity
  `(repo_owner, repo_name, pr_number, head_sha)` — a different concern (the `runs`
  table), same separation as the TS code.

Shape: one `GenServer` per key under `Registry` + `DynamicSupervisor` (chosen over
a single global GenServer so per-key serialization IS the isolation boundary and a
crashed key process takes down exactly one PR's queue state).

## What the properties prove (StreamData, 250 runs each)

Random interleavings of `enqueue` / `start_job` / `publish` across keys, checked
against an **independent sequential reference model** (a restatement of the TS
spec, not a copy of the GenServer):

1. Every publish verdict matches the reference at that point in the sequence.
2. No lost updates: final `current_sha` per key = last enqueued sha.
3. At most one pending job per key, exactly the reference's.
4. Key isolation: unreferenced keys have no process at all.
5. A `:publish` verdict only ever fires for the latest enqueued sha of its key.

Plus unit tests: the abort message on supersession (and its absence on same-sha
re-push), and 100 concurrent enqueues on one key ending with exactly one pending
job whose sha equals `current_sha` — the invariant that in TS is *guarded* is here
*unrepresentable to violate*, because the key process serializes transitions.

## The verdict

**TS + Redis stays. The revisit gate does not fire today.**

What the BEAM genuinely bought, measured on this spike:

- The semantic core is **141 lines** (vs **315** for the TS
  `supersession.ts` + `queue.ts` + `worker.ts` trio) and the two central
  invariants (one pending per key; pending/current can't diverge) hold
  *structurally* rather than by guarded discipline — the property suite couldn't
  break them by construction.
- Supervision and per-key crash isolation come free.

Why that still doesn't justify adoption:

- The LOC win is misleading: BullMQ/Redis carries **persistence, retries,
  delayed jobs, and horizontal workers** that this in-memory model doesn't —
  reproducing those on the BEAM means Oban + Postgres, at which point the
  footprint advantage disappears.
- The TS publish-time guard is already the queue-agnostic backstop, is
  property-tested semantics-equivalent here, and survives process crashes because
  it lives in Redis, not process state.
- Polyglot ops cost (deploy image, observability, on-call literacy) lands on the
  revenue surface — the worst place for it, pre-go-live (#64).

**When to re-open:** if gate ever needs *stateful per-session live processes* —
pointer's interactive sidecar shape (long-lived per-user sessions, presence,
fan-in of browser events) is the workload where Registry-per-key stops being a
modeling trick and becomes the architecture. That is pointer's documented Elixir
revisit gate, and this spike is the executable half of that argument.

## Running

```sh
cd spikes/elixir-supersession
mix deps.get && mix test          # 8 tests: 2 properties (250 runs) + 6 unit
mix format --check-formatted
```

Deliberately outside the root pnpm workspace and CI (gate's harness is
untouched); the spike is evidence for an architecture decision, not a shipped
component.
