defmodule SupersessionQueue do
  @moduledoc """
  Public API for the supersession-queue spike. Mirrors gate's
  `reviewQueueKey` / `recordEnqueue` / `guardPublish` semantics; see
  `SupersessionQueue.KeyServer` for the model and the README for the verdict.
  """

  alias SupersessionQueue.KeyServer

  @doc "Supersession/dedup key: `owner/name#pr` (mirrors TS `reviewQueueKey`)."
  def key(owner, name, pr_number), do: "#{owner}/#{name}##{pr_number}"

  @doc """
  Enqueue a review for `key` at `head_sha`, superseding any pending job and
  signaling abort to a superseded in-flight one. `subscriber` (optional pid)
  receives `{:aborted, ref}` for its in-flight job on supersession.
  """
  def enqueue(key, head_sha, subscriber \\ nil) do
    GenServer.call(server(key), {:enqueue, head_sha, subscriber})
  end

  @doc "Promote the pending job to in-flight; `:no_pending` when idle."
  def start_job(key), do: GenServer.call(server(key), :start_job)

  @doc "Publish-time SHA guard: `:publish` or `:stale_discarded`."
  def publish_guard(key, job_sha), do: GenServer.call(server(key), {:publish_guard, job_sha})

  @doc "Test/observability snapshot of one key's state."
  def snapshot(key), do: GenServer.call(server(key), :snapshot)

  defp server(key) do
    case Registry.lookup(SupersessionQueue.Registry, key) do
      [{pid, _}] ->
        pid

      [] ->
        case DynamicSupervisor.start_child(SupersessionQueue.KeySupervisor, {KeyServer, key}) do
          {:ok, pid} -> pid
          {:error, {:already_started, pid}} -> pid
        end
    end
  end
end
