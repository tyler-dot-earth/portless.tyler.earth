import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Tailscale cleanup across slow shutdowns and killed sessions (#280), against a stand-in
// `tailscale` CLI that keeps its serve config in a JSON file.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../../packages/portless/dist/cli.js");
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/minimal-server");
const PROXY_PORT = 19014;

const isWindows = process.platform === "win32";

// The stand-in answers `serve status` from the config as it was when called, and applies a change
// to the config as it is when the change lands. FAKE_TAILSCALE_DELAY_MS delays every answer, like
// the real CLI; FAKE_TAILSCALE_STATUS_DELAY_MS delays status answers further, and
// FAKE_TAILSCALE_OFF_DELAY_MS delays a removal before it lands.
const FAKE_TAILSCALE = `#!${process.execPath}
const fs = require("node:fs");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms) || 0);
const statePath = process.env.FAKE_TAILSCALE_STATE;
const read = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf-8")) : {});
const write = (serves) => fs.writeFileSync(statePath, JSON.stringify(serves));
const args = process.argv.slice(2);
const command = args.join(" ");
const https = (args.find((arg) => arg.startsWith("--https=")) || "").slice("--https=".length);
fs.appendFileSync(process.env.FAKE_TAILSCALE_LOG, command + "\\n");
let output = "";
let failure = "";
if (command === "version") {
  output = "1.90.6";
} else if (command === "status --json") {
  output = JSON.stringify({ Self: { DNSName: "host.example.ts.net.", Capabilities: ["https"] } });
} else if (command === "serve status --json") {
  const Web = {};
  for (const [port, target] of Object.entries(read())) {
    Web["host.example.ts.net:" + port] = { Handlers: { "/": { Proxy: target } } };
  }
  output = JSON.stringify({ Web });
  sleep(process.env.FAKE_TAILSCALE_STATUS_DELAY_MS);
} else if (args[0] === "serve" && args[args.length - 1] === "off") {
  sleep(process.env.FAKE_TAILSCALE_OFF_DELAY_MS);
  const serves = read();
  if (process.env.FAKE_TAILSCALE_FAIL_OFF === "1") {
    failure = "interrupted";
  } else if (!(https in serves)) {
    failure = "error: failed to remove web serve: handler does not exist";
  } else {
    delete serves[https];
    write(serves);
  }
} else if (args[0] === "serve" && args.includes("--bg")) {
  const serves = read();
  if (https in serves && serves[https] !== args[args.length - 1]) {
    failure = "error: listener already exists for port " + https;
  } else {
    serves[https] = args[args.length - 1];
    write(serves);
  }
} else {
  failure = "unexpected tailscale call: " + command;
}
sleep(process.env.FAKE_TAILSCALE_DELAY_MS);
if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log(output);
`;

function findPidsOnPort(port: number): number[] {
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return output
      ? output
          .split("\n")
          .map((raw) => parseInt(raw, 10))
          .filter((pid) => !isNaN(pid) && pid !== process.pid)
      : [];
  } catch {
    return [];
  }
}

function killPort(port: number): void {
  for (const pid of findPidsOnPort(port)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(50);
  }
  return condition();
}

async function waitUntilAsync(
  condition: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(250);
  }
  return condition();
}

async function waitForChildToExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function isReachable(hostname: string): Promise<boolean> {
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${PROXY_PORT}/`,
        { headers: { Host: hostname } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.setTimeout(2000, () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.end();
    });
    return status >= 200 && status < 400;
  } catch {
    return false;
  }
}

interface RouteOnDisk {
  hostname: string;
  port: number;
  pid: number;
  tailscaleHttpsPort?: number;
}

describe.skipIf(isWindows)("Tailscale cleanup (#280)", () => {
  let tmpRoot: string | undefined;
  const children = new Map<string, ChildProcess>();

  function paths() {
    if (!tmpRoot) throw new Error("test not set up");
    return {
      stateDir: path.join(tmpRoot, "state"),
      binDir: path.join(tmpRoot, "bin"),
      serves: path.join(tmpRoot, "serves.json"),
      log: path.join(tmpRoot, "tailscale.log"),
    };
  }

  function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const p = paths();
    return {
      ...process.env,
      PATH: `${p.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PORTLESS_PORT: PROXY_PORT.toString(),
      PORTLESS_HTTPS: "0",
      PORTLESS_STATE_DIR: p.stateDir,
      FAKE_TAILSCALE_STATE: p.serves,
      FAKE_TAILSCALE_LOG: p.log,
      NO_COLOR: "1",
      ...extra,
    };
  }

  function serves(): Record<string, string> {
    const file = paths().serves;
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {};
  }

  function offCalls(): string[] {
    return fs
      .readFileSync(paths().log, "utf-8")
      .split("\n")
      .filter((line) => line.endsWith(" off"));
  }

  function routes(): RouteOnDisk[] {
    const file = path.join(paths().stateDir, "routes.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : [];
  }

  function routeFor(hostname: string): RouteOnDisk | undefined {
    return routes().find((route) => route.hostname === hostname);
  }

  function prune(extra: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [CLI_PATH, "prune"], {
      env: env(extra),
      encoding: "utf-8",
      timeout: 10_000,
    });
  }

  /** Set up a state directory with the stand-in tailscale CLI, and start the proxy. */
  function setUp(initial: { routes?: object[]; serves?: Record<string, string> } = {}): void {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portless-e2e-tailscale-"));
    const p = paths();
    fs.mkdirSync(p.stateDir);
    fs.mkdirSync(p.binDir);
    fs.writeFileSync(path.join(p.binDir, "tailscale"), FAKE_TAILSCALE, { mode: 0o755 });
    if (initial.routes) {
      fs.writeFileSync(path.join(p.stateDir, "routes.json"), JSON.stringify(initial.routes));
    }
    if (initial.serves) fs.writeFileSync(p.serves, JSON.stringify(initial.serves));
    spawnSync(
      process.execPath,
      [CLI_PATH, "proxy", "start", "--no-tls", "-p", PROXY_PORT.toString()],
      { env: env(), timeout: 15_000 }
    );
  }

  /** Start a Tailscale-shared app without waiting for it. */
  function spawnSharedApp(appName: string, script: string, extra: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, [CLI_PATH, appName, "node", script], {
      cwd: FIXTURE_DIR,
      env: env({ ...extra, PORTLESS_TAILSCALE: "1", APP_NAME: appName }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    children.set(appName, child);
    return { child, output: () => output };
  }

  /** Wait until an app is reachable and its route records a Tailscale port; returns the route. */
  async function waitForSharedApp(appName: string, output: () => string): Promise<RouteOnDisk> {
    const hostname = `${appName}.localhost`;
    const ready = await waitUntilAsync(
      async () =>
        (await isReachable(hostname)) && routeFor(hostname)?.tailscaleHttpsPort !== undefined,
      30_000
    );
    expect(ready, `${appName} did not become ready.\n${output()}`).toBe(true);
    return routeFor(hostname)!;
  }

  async function startSharedApp(appName: string, script: string): Promise<RouteOnDisk> {
    setUp();
    const app = spawnSharedApp(appName, script);
    return waitForSharedApp(appName, app.output);
  }

  afterEach(async () => {
    for (const child of children.values()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildToExit(child, 2000);
      }
    }
    if (tmpRoot) {
      for (const route of routes()) killPort(route.port);
      spawnSync(process.execPath, [CLI_PATH, "proxy", "stop"], { env: env(), timeout: 10_000 });
    }
    killPort(PROXY_PORT);
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
    children.clear();
  });

  it("releases the serve when shutdown begins, so a later prune leaves the next owner's serve alone", async () => {
    setUp();
    // The wrapper ignores SIGTERM, so portless waits out its grace period before exiting. The
    // stand-in CLI takes as long as the real one, so the route is updated after the serve is gone.
    const app = spawnSharedApp("ts-slow-stop", "stubborn-wrapper.js", {
      FAKE_TAILSCALE_DELAY_MS: "250",
    });
    const route = await waitForSharedApp("ts-slow-stop", app.output);
    expect(serves()).toEqual({ "443": `http://127.0.0.1:${route.port}` });

    app.child.kill("SIGTERM");
    const released = await waitUntil(
      () =>
        !("443" in serves()) &&
        routeFor("ts-slow-stop.localhost")?.tailscaleHttpsPort === undefined,
      5000
    );
    expect(released, app.output()).toBe(true);
    expect(app.child.exitCode).toBeNull();

    // Another app takes the port while this one is still stopping, then a supervisor kills
    // this one before its exit cleanup runs.
    fs.writeFileSync(paths().serves, JSON.stringify({ "443": "http://127.0.0.1:4999" }));
    app.child.kill("SIGKILL");
    await waitForChildToExit(app.child, 2000);

    expect(prune().status).toBe(0);
    expect(serves()).toEqual({ "443": "http://127.0.0.1:4999" });
    expect(offCalls()).toEqual(["serve --yes --https=443 off"]);
  });

  it("kills an orphaned server even when its serve can't be removed, then retries the serve", async () => {
    const route = await startSharedApp("ts-retry", "server.js");
    const child = children.get("ts-retry")!;
    child.kill("SIGKILL");
    await waitForChildToExit(child, 2000);
    expect(findPidsOnPort(route.port).length).toBeGreaterThan(0);

    const failed = prune({ FAKE_TAILSCALE_FAIL_OFF: "1" });
    expect(failed.status).toBe(0);
    expect(failed.stdout).toContain("killed PID");
    expect(failed.stderr).toContain("keeping its route to retry");
    expect(await waitUntil(() => findPidsOnPort(route.port).length === 0, 3000)).toBe(true);
    expect(routeFor("ts-retry.localhost")?.tailscaleHttpsPort).toBe(443);

    const retried = prune();
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("removed tailscale serve on port 443");
    expect(serves()).toEqual({});
    expect(routeFor("ts-retry.localhost")).toBeUndefined();
  });

  it("lets only one of two apps starting together release a stale serve", async () => {
    // A dead session's serve on 443 that both apps find. Both read it before either removes it,
    // and the second app's removal lands late, after the first has registered on 443.
    const stale = {
      hostname: "ts-dead.localhost",
      port: 4987,
      pid: 999999,
      tailscaleUrl: "https://host.example.ts.net",
      tailscaleHttpsPort: 443,
    };
    setUp({ routes: [stale], serves: { "443": "http://127.0.0.1:4987" } });
    const slowStatus = { FAKE_TAILSCALE_STATUS_DELAY_MS: "800" };
    const first = spawnSharedApp("ts-first", "server.js", slowStatus);
    const second = spawnSharedApp("ts-second", "server.js", {
      ...slowStatus,
      FAKE_TAILSCALE_OFF_DELAY_MS: "2000",
    });
    const shared = [
      await waitForSharedApp("ts-first", first.output),
      await waitForSharedApp("ts-second", second.output),
    ];

    // Each app's port is served to that app, and neither claims the other's.
    const config = serves();
    for (const route of shared) {
      expect(config[String(route.tailscaleHttpsPort)]).toBe(`http://127.0.0.1:${route.port}`);
    }
    expect(shared[0].tailscaleHttpsPort).not.toBe(shared[1].tailscaleHttpsPort);
    expect(routeFor("ts-dead.localhost")).toBeUndefined();
  });
});
