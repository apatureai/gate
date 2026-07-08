defmodule SupersessionQueue.PropertiesTest do
  @moduledoc """
  StreamData properties over random interleavings of queue events, checked
  against a trivial sequential reference model (a map of key -> state). The
  reference model is an independent restatement of the TS semantics
  (`queue.ts` remove-then-add + `supersession.ts` guardPublish), NOT a copy of
  the GenServer code — divergence between the two is a finding.
  """
  use ExUnit.Case, async: false
  use ExUnitProperties

  @keys ["k1", "k2", "k3"]
  @shas ["s1", "s2", "s3", "s4", "s5"]

  defp command_gen do
    StreamData.frequency([
      {4,
       StreamData.tuple(
         {StreamData.constant(:enqueue), StreamData.member_of(@keys), StreamData.member_of(@shas)}
       )},
      {3, StreamData.tuple({StreamData.constant(:start_job), StreamData.member_of(@keys)})},
      {3,
       StreamData.tuple(
         {StreamData.constant(:publish), StreamData.member_of(@keys), StreamData.member_of(@shas)}
       )}
    ])
  end

  # --- sequential reference model (independent restatement of the TS spec) ----

  defp ref_apply({:enqueue, key, sha}, ref) do
    Map.update(ref, key, %{current: sha, pending: sha, started: []}, fn s ->
      %{s | current: sha, pending: sha}
    end)
  end

  defp ref_apply({:start_job, key}, ref) do
    case ref[key] do
      %{pending: p} = s when p != nil ->
        Map.put(ref, key, %{s | pending: nil, started: [p | s.started]})

      _ ->
        ref
    end
  end

  defp ref_apply({:publish, _key, _sha}, ref), do: ref

  defp ref_verdict({:publish, key, sha}, ref) do
    case ref[key] do
      %{current: ^sha} -> :publish
      _ -> :stale_discarded
    end
  end

  # --- properties --------------------------------------------------------------

  property "random interleavings: verdicts, pending, and current sha match the reference model" do
    check all(commands <- StreamData.list_of(command_gen(), max_length: 40), max_runs: 250) do
      # Namespace keys per run so key processes are fresh every time.
      ns = System.unique_integer([:positive])
      real_key = fn k -> "prop-#{ns}-#{k}" end

      final_ref =
        Enum.reduce(commands, %{}, fn cmd, ref ->
          case cmd do
            {:enqueue, k, sha} ->
              {:ok, _} = SupersessionQueue.enqueue(real_key.(k), sha)
              ref_apply(cmd, ref)

            {:start_job, k} ->
              _ = SupersessionQueue.start_job(real_key.(k))
              ref_apply(cmd, ref)

            {:publish, k, sha} ->
              # The verdict must match the reference model AT THIS POINT in the
              # sequence — the publish-time guard law, for every interleaving.
              assert SupersessionQueue.publish_guard(real_key.(k), sha) == ref_verdict(cmd, ref)
              ref_apply(cmd, ref)
          end
        end)

      for {k, ref_state} <- final_ref do
        snap = SupersessionQueue.snapshot(real_key.(k))
        # No lost updates: current sha equals the last enqueued sha for the key.
        assert snap.current_sha == ref_state.current
        # At most one pending, and exactly the reference's pending.
        assert snap.pending_count in [0, 1]
        assert snap.pending_sha == ref_state.pending
      end

      # Key isolation: keys no command ever referenced have no process at all
      # (any referenced key may legitimately have spawned its server, even for
      # a guard-only probe).
      touched = commands |> Enum.map(&elem(&1, 1)) |> Enum.uniq()

      for k <- @keys -- touched do
        assert Registry.lookup(SupersessionQueue.Registry, real_key.(k)) == []
      end
    end
  end

  property "a published sha is always the latest enqueued sha for its key" do
    check all(commands <- StreamData.list_of(command_gen(), max_length: 30), max_runs: 250) do
      ns = System.unique_integer([:positive])
      real_key = fn k -> "pub-#{ns}-#{k}" end

      Enum.reduce(commands, %{}, fn cmd, last ->
        case cmd do
          {:enqueue, k, sha} ->
            {:ok, _} = SupersessionQueue.enqueue(real_key.(k), sha)
            Map.put(last, k, sha)

          {:start_job, k} ->
            _ = SupersessionQueue.start_job(real_key.(k))
            last

          {:publish, k, sha} ->
            if SupersessionQueue.publish_guard(real_key.(k), sha) == :publish do
              assert last[k] == sha,
                     "published #{sha} but latest enqueued for #{k} was #{inspect(last[k])}"
            end

            last
        end
      end)
    end
  end
end
