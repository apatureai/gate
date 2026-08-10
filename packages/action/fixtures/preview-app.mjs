/**
 * Fixture "preview app" for the sandbox supervisor demo. It stands in for the
 * `preview-command` a repo would run in its own GitHub runner (`pnpm dev`,
 * `npm run preview`, …). No network access, no dependencies.
 *
 * Modes (argv[2]):
 *   serve     listen on $PORT and answer the supervisor's readiness probe.
 *   redirect  answer every request with a 302 to an off-loopback host, so the
 *             supervisor's hostile-redirect guard has something to refuse.
 *
 * Routes in `serve` mode:
 *   GET /         the "page" the reviewer would screenshot
 *   GET /env      the env vars this process actually received (allowlist proof)
 *   GET /limits   the rlimits this process is running under (resource-cap proof)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "serve";
const port = Number.parseInt(process.env.PORT ?? "0", 10);
const workerPath = fileURLToPath(new URL("./preview-worker.mjs", import.meta.url));

for (const kind of ["well-behaved", "stubborn"]) {
  spawn(process.execPath, [workerPath, kind], { stdio: "inherit" });
}

// Lines a real dev server prints. The supervisor captures stdout/stderr into a
// bounded ring buffer, and `parsePreviewBuildFacts` turns known patterns (this
// hydration warning) into grounded facts for the critique.
console.log("preview-app: build finished in 412ms");
console.log(
  "preview-app: Warning: Hydration failed because the server-rendered HTML did not match the client",
);

const page = [
  "<!doctype html>",
  "<title>Gate fixture preview app</title>",
  "<h1>Gate fixture preview app</h1>",
  "<p>This is the page a design review would screenshot.</p>",
].join("\n");

const server = createServer((req, res) => {
  if (mode === "redirect") {
    res.writeHead(302, { location: "https://preview.attacker.example/pwn" });
    res.end();
    return;
  }
  if (req.url === "/env") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Object.keys(process.env).sort()));
    return;
  }
  if (req.url === "/limits") {
    const limits = process.report.getReport().userLimits;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        maxUserProcesses: limits.max_user_processes ?? null,
        virtualMemoryBytes: limits.virtual_memory_bytes ?? null,
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`preview-app: listening on http://127.0.0.1:${server.address().port} (mode ${mode})`);
});
