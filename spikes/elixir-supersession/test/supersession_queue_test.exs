defmodule SupersessionQueueTest do
  use ExUnit.Case, async: false

  # Unique key per test so key processes never collide across tests.
  defp fresh_key(tag),
    do: SupersessionQueue.key("acme", "web-#{tag}-#{System.unique_integer([:positive])}", 42)

  test "newest push wins: publish allowed only for the latest sha (TS guardPublish semantics)" do
    key = fresh_key("guard")
    {:ok, _} = SupersessionQueue.enqueue(key, "sha-old")
    {:ok, job} = SupersessionQueue.start_job(key)

    # A newer push arrives while the old job is in flight.
    {:ok, _} = SupersessionQueue.enqueue(key, "sha-new")

    assert SupersessionQueue.publish_guard(key, job.sha) == :stale_discarded
    {:ok, newer} = SupersessionQueue.start_job(key)
    assert SupersessionQueue.publish_guard(key, newer.sha) == :publish
  end

  test "remove-then-add: at most one pending job per key, the newest" do
    key = fresh_key("pending")
    for sha <- ["a", "b", "c"], do: {:ok, _} = SupersessionQueue.enqueue(key, sha)
    snap = SupersessionQueue.snapshot(key)
    assert snap.pending_count == 1
    assert snap.pending_sha == "c"
    assert snap.current_sha == "c"
  end

  test "supersession signals abort to the in-flight job's subscriber (AbortController analogue)" do
    key = fresh_key("abort")
    {:ok, ref} = SupersessionQueue.enqueue(key, "sha-1", self())
    {:ok, _job} = SupersessionQueue.start_job(key)
    {:ok, _} = SupersessionQueue.enqueue(key, "sha-2", self())
    assert_receive {:aborted, ^ref}, 500
  end

  test "same-sha re-push does not abort the in-flight job" do
    key = fresh_key("same")
    {:ok, ref} = SupersessionQueue.enqueue(key, "sha-1", self())
    {:ok, _} = SupersessionQueue.start_job(key)
    {:ok, _} = SupersessionQueue.enqueue(key, "sha-1", self())
    refute_receive {:aborted, ^ref}, 100
  end

  test "100 concurrent enqueues on one key end with exactly the newest-arriving sha pending" do
    key = fresh_key("concurrent")

    1..100
    |> Task.async_stream(fn i -> SupersessionQueue.enqueue(key, "sha-#{i}") end,
      max_concurrency: 100
    )
    |> Stream.run()

    snap = SupersessionQueue.snapshot(key)
    # The GenServer serializes arrivals, so "newest" is arrival order at the key
    # process; the structural claims are: exactly one pending, and the pending
    # sha IS the current sha (they can never diverge).
    assert snap.pending_count == 1
    assert snap.pending_sha == snap.current_sha
    enqueued = for {:enqueue, sha} <- snap.log, do: sha
    assert length(enqueued) == 100
    assert snap.current_sha == List.last(enqueued)
    # Every other sha is stale at the guard.
    for sha <- enqueued, sha != snap.current_sha do
      assert SupersessionQueue.publish_guard(key, sha) == :stale_discarded
    end
  end

  test "keys are isolated: activity on one repo#pr never touches another" do
    k1 = fresh_key("iso1")
    k2 = fresh_key("iso2")
    {:ok, _} = SupersessionQueue.enqueue(k1, "sha-a")
    {:ok, _} = SupersessionQueue.enqueue(k2, "sha-b")
    {:ok, job2} = SupersessionQueue.start_job(k2)
    {:ok, _} = SupersessionQueue.enqueue(k1, "sha-c")

    assert SupersessionQueue.publish_guard(k2, job2.sha) == :publish
    assert SupersessionQueue.snapshot(k1).current_sha == "sha-c"
    assert SupersessionQueue.snapshot(k2).current_sha == "sha-b"
  end
end
