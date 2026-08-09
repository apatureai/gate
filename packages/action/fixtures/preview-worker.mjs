/**
 * Child worker for the sandbox supervisor demo fixture.
 *
 * A real dev server forks children (a bundler, a watcher, a worker pool), so the
 * fixture forks two of these to give the supervisor an actual process TREE to
 * tear down rather than a single process.
 *
 * `stubborn` traps SIGTERM and refuses to exit. That is the interesting case:
 * teardown is gated on the whole process GROUP being gone, so a trapped
 * grandchild must be escalated to SIGKILL after the grace window instead of
 * being orphaned on the runner.
 */
const kind = process.argv[2] ?? "well-behaved";

if (kind === "stubborn") {
  process.on("SIGTERM", () => {
    console.log("preview-worker: stubborn worker ignoring SIGTERM");
  });
}

console.log(`preview-worker: ${kind} worker up (pid ${process.pid})`);
setInterval(() => {}, 60_000);
