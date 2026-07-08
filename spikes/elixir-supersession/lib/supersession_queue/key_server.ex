defmodule SupersessionQueue.KeyServer do
  @moduledoc """
  One process per supersession key (`owner/name#pr`), mirroring
  `packages/service/src/{queue,supersession}.ts`:

    * `enqueue/2` — sets `current_sha`, REPLACES any pending job
      (remove-then-add: at most one pending per key), and signals abort to an
      in-flight job for an older sha (TS: AbortController; here: a message the
      job's owner can consume — cooperative, exactly like the TS worker #48).
    * `start_job/1` — promotes the pending job to in-flight.
    * `publish_guard/2` — the publish-time SHA guard: `:publish` only when the
      job's sha still equals `current_sha`, else `:stale_discarded`. The guard
      is the queue-agnostic backstop, same as TS `guardPublish`.

  The point of the BEAM shape: everything the TS code enforces with a Redis key
  plus guarded checks at stage boundaries is *structural* here — the GenServer
  serializes all transitions for its key, so "at most one pending" and
  "newest wins" cannot race by construction, and key isolation is process
  isolation. The durable completed-review identity
  `(owner, name, pr, head_sha)` stays OUTSIDE this model on purpose — it is a
  different concern (the `runs` table), exactly as in TS.
  """
  use GenServer

  @type job :: %{key: String.t(), sha: String.t(), ref: reference()}

  defmodule State do
    @moduledoc false
    defstruct key: nil,
              current_sha: nil,
              pending: nil,
              in_flight: nil,
              # audit trail consumed by the property tests
              log: []
  end

  # --- client -----------------------------------------------------------------

  def start_link(key) do
    GenServer.start_link(__MODULE__, key, name: via(key))
  end

  def via(key), do: {:via, Registry, {SupersessionQueue.Registry, key}}

  # --- server -----------------------------------------------------------------

  @impl true
  def init(key), do: {:ok, %State{key: key}}

  @impl true
  def handle_call({:enqueue, sha, subscriber}, _from, %State{} = s) do
    # Abort signal for a superseded in-flight job (cooperative, like the TS
    # AbortController threaded through worker #48 / engine poll #4).
    if s.in_flight != nil and s.in_flight.sha != sha and s.in_flight.subscriber != nil do
      send(s.in_flight.subscriber, {:aborted, s.in_flight.ref})
    end

    job = %{key: s.key, sha: sha, ref: make_ref(), subscriber: subscriber}

    s = %State{
      s
      | current_sha: sha,
        # remove-then-add: the older pending job is dropped, never queued behind
        pending: job,
        log: [{:enqueue, sha} | s.log]
    }

    {:reply, {:ok, job.ref}, s}
  end

  def handle_call(:start_job, _from, %State{pending: nil} = s),
    do: {:reply, :no_pending, s}

  def handle_call(:start_job, _from, %State{pending: job} = s) do
    s = %State{s | pending: nil, in_flight: job, log: [{:start, job.sha} | s.log]}
    {:reply, {:ok, %{key: job.key, sha: job.sha, ref: job.ref}}, s}
  end

  def handle_call({:publish_guard, sha}, _from, %State{} = s) do
    verdict = if sha == s.current_sha, do: :publish, else: :stale_discarded
    s = %State{s | in_flight: clear_if_sha(s.in_flight, sha), log: [{verdict, sha} | s.log]}
    {:reply, verdict, s}
  end

  def handle_call(:snapshot, _from, %State{} = s) do
    {:reply,
     %{
       current_sha: s.current_sha,
       pending_sha: s.pending && s.pending.sha,
       in_flight_sha: s.in_flight && s.in_flight.sha,
       pending_count: if(s.pending, do: 1, else: 0),
       log: Enum.reverse(s.log)
     }, s}
  end

  defp clear_if_sha(nil, _sha), do: nil
  defp clear_if_sha(job, sha), do: if(job.sha == sha, do: nil, else: job)
end
