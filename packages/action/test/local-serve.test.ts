import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildAllowlistedEnv, startLocalServer, type LocalServerHandle } from "../src/index.js";

// Real fixture child processes (localhost only — no mock, no external network),
// per #70 AC. Each fixture reads PORT from its (test-supplied) env.
const node = (script: string): string => `node -e '${script}'`;
const serve = (status: number, extra = ""): string =>
  node(`require("http").createServer((q,r)=>{r.writeHead(${status}${extra});r.end("ok")}).listen(process.env.PORT,"127.0.0.1")`);

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function groupDead(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
}
async function waitGroupDead(pid: number, ms = 5_000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (groupDead(pid)) return true;
    await sleep(25);
  }
  return groupDead(pid);
}

let active: LocalServerHandle | undefined;
afterEach(async () => {
  await active?.stop();
  active = undefined;
});

const envWith = (port: number, extra: Record<string, string> = {}): Record<string, string> => ({
  ...buildAllowlistedEnv(),
  PORT: String(port),
  ...extra,
});

describe("startLocalServer (#70 Part 3 — real fixtures)", () => {
  it("ready: a server that responds 200 → ok, and stop() kills the whole group", async () => {
    const port = await freePort();
    const res = await startLocalServer(serve(200), {
      url: `http://127.0.0.1:${port}`,
      cwd: process.cwd(),
      env: envWith(port),
      ceilingMs: 10_000,
      pollIntervalMs: 100,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    active = res.server;
    await res.server.stop();
    expect(await waitGroupDead(res.server.pid)).toBe(true); // no orphan
  }, 20_000);

  it("ready-status set (DR-10): 401 and 302→loopback are ready", async () => {
    for (const fixture of [serve(401), serve(302, `,{location:"/home"}`)]) {
      const port = await freePort();
      const res = await startLocalServer(fixture, {
        url: `http://127.0.0.1:${port}`,
        cwd: process.cwd(),
        env: envWith(port),
        ceilingMs: 10_000,
        pollIntervalMs: 100,
      });
      expect(res.ok).toBe(true);
      if (res.ok) await res.server.stop();
    }
  }, 20_000);

  it("ready_status (#80): a custom status set accepts an otherwise-unready code (503)", async () => {
    const port = await freePort();
    // 503 is NOT in the default Playwright ready set → would be not_ready by default.
    const res = await startLocalServer(serve(503), {
      url: `http://127.0.0.1:${port}`,
      cwd: process.cwd(),
      env: envWith(port),
      readyStatus: [503],
      ceilingMs: 10_000,
      pollIntervalMs: 100,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      active = res.server;
      await res.server.stop();
    }
  }, 20_000);

  it("ready_status (#80): the default set still rejects 503 (no custom set → not_ready)", async () => {
    const port = await freePort();
    const res = await startLocalServer(serve(503), {
      url: `http://127.0.0.1:${port}`,
      cwd: process.cwd(),
      env: envWith(port),
      ceilingMs: 600,
      pollIntervalMs: 100,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_ready");
  }, 20_000);

  it("ready_path (#80): polls a specific path that 200s while the base 404s", async () => {
    const port = await freePort();
    // Base "/" → 404 (not ready); "/healthz" → 200 (ready).
    const fixture = node(
      `require("http").createServer((q,r)=>{if(q.url==="/healthz"){r.writeHead(200);r.end("ok")}else{r.writeHead(404);r.end("nf")}}).listen(process.env.PORT,"127.0.0.1")`,
    );
    const res = await startLocalServer(fixture, {
      url: `http://127.0.0.1:${port}`,
      cwd: process.cwd(),
      env: envWith(port),
      readyPath: "/healthz",
      ceilingMs: 10_000,
      pollIntervalMs: 100,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      active = res.server;
      await res.server.stop();
    }
  }, 20_000);

  it("early_exit: a command that exits before ready → early_exit, not an engine handoff", async () => {
    const port = await freePort();
    const res = await startLocalServer(node("process.exit(1)"), {
      url: `http://127.0.0.1:${port}`,
      cwd: process.cwd(),
      env: envWith(port),
      ceilingMs: 30_000, // would hang here if early-exit weren't short-circuited
      pollIntervalMs: 100,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("early_exit");
  }, 20_000);

  it("not_ready: a process that never binds → not_ready at the ceiling, then killed", async () => {
    const port = await freePort();
    const res = await startLocalServer(node("setInterval(()=>{},1000)"), {
      url: `http://127.0.0.1:${port}`,
      cwd: process.cwd(),
      env: envWith(port),
      ceilingMs: 600,
      pollIntervalMs: 100,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_ready");
  }, 20_000);

  it("redirected_off_loopback (U2): a 3xx to a non-loopback host fails fast, not after the ceiling", async () => {
    const port = await freePort();
    const startedAt = Date.now();
    const res = await startLocalServer(serve(302, `,{location:"http://evil.example.com/"}`), {
      url: `http://127.0.0.1:${port}`,
      cwd: process.cwd(),
      env: envWith(port),
      ceilingMs: 30_000,
      pollIntervalMs: 100,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("redirected_off_loopback");
  }, 5_000);

  it("orphan-free: a server that spawns a same-group child — stop() reaps the whole tree", async () => {
    const port = await freePort();
    const fixture = node(
      `require("child_process").spawn("node",["-e","setInterval(()=>{},1000)"]);` +
        `require("http").createServer((q,r)=>{r.writeHead(200);r.end()}).listen(process.env.PORT,"127.0.0.1")`,
    );
    const res = await startLocalServer(fixture, {
      url: `http://127.0.0.1:${port}`,
      cwd: process.cwd(),
      env: envWith(port),
      ceilingMs: 10_000,
      pollIntervalMs: 100,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await res.server.stop();
    expect(await waitGroupDead(res.server.pid)).toBe(true); // group gone ⇒ grandchild gone too
  }, 20_000);

  it("grace→SIGKILL: a server that traps SIGTERM is force-killed after the grace window", async () => {
    const port = await freePort();
    const fixture = node(
      `process.on("SIGTERM",()=>{});` +
        `require("http").createServer((q,r)=>{r.writeHead(200);r.end()}).listen(process.env.PORT,"127.0.0.1")`,
    );
    const res = await startLocalServer(fixture, {
      url: `http://127.0.0.1:${port}`,
      cwd: process.cwd(),
      env: envWith(port),
      ceilingMs: 10_000,
      pollIntervalMs: 100,
      graceMs: 300, // SIGTERM ignored → escalate to SIGKILL after 300ms
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await res.server.stop();
    expect(await waitGroupDead(res.server.pid)).toBe(true);
  }, 20_000);

  it("stop() is idempotent", async () => {
    const port = await freePort();
    const res = await startLocalServer(serve(200), {
      url: `http://127.0.0.1:${port}`,
      cwd: process.cwd(),
      env: envWith(port),
      ceilingMs: 10_000,
      pollIntervalMs: 100,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await res.server.stop();
    await expect(res.server.stop()).resolves.toBeUndefined(); // second call: no throw
  }, 20_000);
});

describe("buildAllowlistedEnv (#70 fork-safety)", () => {
  it("passes PATH but never secrets (allowlist, default-deny)", () => {
    const env = buildAllowlistedEnv({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      JUDGMENT_ENGINE_API_KEY: "sk-secret",
      JUDGMENT_ENGINE_HMAC_SECRET: "hmac",
      GITHUB_TOKEN: "ghs_token",
      MY_APP_SECRET: "x",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/runner");
    expect(env.JUDGMENT_ENGINE_API_KEY).toBeUndefined();
    expect(env.JUDGMENT_ENGINE_HMAC_SECRET).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.MY_APP_SECRET).toBeUndefined();
  });
});
