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

const FAKE_TAILSCALE = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.join(" ");
const statePath = process.env.FAKE_TAILSCALE_STATE;
const serves = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf-8")) : {};
fs.appendFileSync(process.env.FAKE_TAILSCALE_LOG, command + "\\n");
const https = (args.find((arg) => arg.startsWith("--https=")) || "").slice("--https=".length);
if (command === "version") {
  console.log("1.90.6");
} else if (command === "status --json") {
  console.log(JSON.stringify({ Self: { DNSName: "host.example.ts.net.", Capabilities: ["https"] } }));
} else if (command === "serve status --json") {
  const Web = {};
  for (const [port, target] of Object.entries(serves)) {
    Web["host.example.ts.net:" + port] = { Handlers: { "/": { Proxy: target } } };
  }
  console.log(JSON.stringify({ Web }));
} else if (args[0] === "serve" && args[args.length - 1] === "off") {
  if (process.env.FAKE_TAILSCALE_FAIL_OFF === "1") {
    console.error("interrupted");
    process.exit(1);
  }
  if (!(https in serves)) {
    console.error("error: failed to remove web serve: handler does not exist");
    process.exit(1);
  }
  delete serves[https];
  fs.writeFileSync(statePath, JSON.stringify(serves));
} else if (args[0] === "serve" && args.includes("--bg")) {
  serves[https] = args[args.length - 1];
  fs.writeFileSync(statePath, JSON.stringify(serves));
} else {
  console.error("unexpected tailscale call: " + command);
  process.exit(1);
}
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
  let cliChild: ChildProcess | undefined;
  let appPort: number | undefined;

  function paths() {
    if (!tmpRoot) throw new Error("test not set up");
    return {
      stateDir: path.join(tmpRoot, "state"),
      binDir: path.join(tmpRoot, "bin"),
      serves: path.join(tmpRoot, "serves.json"),
      log: path.join(tmpRoot, "tailscale.log"),
    };
  }

  function env(options: { failOff?: boolean } = {}): NodeJS.ProcessEnv {
    const p = paths();
    return {
      ...process.env,
      PATH: `${p.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PORTLESS_PORT: PROXY_PORT.toString(),
      PORTLESS_HTTPS: "0",
      PORTLESS_STATE_DIR: p.stateDir,
      FAKE_TAILSCALE_STATE: p.serves,
      FAKE_TAILSCALE_LOG: p.log,
      FAKE_TAILSCALE_FAIL_OFF: options.failOff ? "1" : "0",
      NO_COLOR: "1",
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

  function routeFor(hostname: string): RouteOnDisk | undefined {
    const routes: RouteOnDisk[] = JSON.parse(
      fs.readFileSync(path.join(paths().stateDir, "routes.json"), "utf-8")
    );
    return routes.find((route) => route.hostname === hostname);
  }

  function prune(options: { failOff?: boolean } = {}) {
    return spawnSync(process.execPath, [CLI_PATH, "prune"], {
      env: env(options),
      encoding: "utf-8",
      timeout: 10_000,
    });
  }

  /** Start a proxy and a Tailscale-shared app, and wait until the app is reachable. */
  async function startSharedApp(appName: string, script: string): Promise<number> {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portless-e2e-tailscale-"));
    const p = paths();
    fs.mkdirSync(p.stateDir);
    fs.mkdirSync(p.binDir);
    fs.writeFileSync(path.join(p.binDir, "tailscale"), FAKE_TAILSCALE, { mode: 0o755 });

    spawnSync(
      process.execPath,
      [CLI_PATH, "proxy", "start", "--no-tls", "-p", PROXY_PORT.toString()],
      { env: env(), timeout: 15_000 }
    );
    cliChild = spawn(process.execPath, [CLI_PATH, appName, "node", script], {
      cwd: FIXTURE_DIR,
      env: { ...env(), PORTLESS_TAILSCALE: "1", APP_NAME: appName },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    cliChild.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    cliChild.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));

    const hostname = `${appName}.localhost`;
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      ready = (await isReachable(hostname)) && routeFor(hostname)?.tailscaleHttpsPort === 443;
      if (!ready) await sleep(250);
    }
    expect(ready, `App did not become ready.\n${output}`).toBe(true);
    appPort = routeFor(hostname)!.port;
    return appPort;
  }

  afterEach(async () => {
    if (cliChild && cliChild.exitCode === null && cliChild.signalCode === null) {
      cliChild.kill("SIGKILL");
      await waitForChildToExit(cliChild, 2000);
    }
    if (appPort) killPort(appPort);
    if (tmpRoot) {
      spawnSync(process.execPath, [CLI_PATH, "proxy", "stop"], { env: env(), timeout: 10_000 });
    }
    killPort(PROXY_PORT);
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
    cliChild = undefined;
    appPort = undefined;
  });

  it("releases the serve when shutdown begins, so a later prune leaves the next owner's serve alone", async () => {
    // The wrapper ignores SIGTERM, so portless waits out its grace period before exiting.
    const port = await startSharedApp("ts-slow-stop", "stubborn-wrapper.js");
    expect(serves()).toEqual({ "443": `http://127.0.0.1:${port}` });

    cliChild!.kill("SIGTERM");
    expect(await waitUntil(() => !("443" in serves()), 3000)).toBe(true);
    expect(cliChild!.exitCode).toBeNull();
    expect(routeFor("ts-slow-stop.localhost")?.tailscaleHttpsPort).toBeUndefined();

    // Another app takes the port while this one is still stopping, then a supervisor kills
    // this one before its exit cleanup runs.
    fs.writeFileSync(paths().serves, JSON.stringify({ "443": "http://127.0.0.1:4999" }));
    cliChild!.kill("SIGKILL");
    await waitForChildToExit(cliChild!, 2000);

    expect(prune().status).toBe(0);
    expect(serves()).toEqual({ "443": "http://127.0.0.1:4999" });
    expect(offCalls()).toEqual(["serve --yes --https=443 off"]);
  });

  it("kills an orphaned server even when its serve can't be removed, then retries the serve", async () => {
    const port = await startSharedApp("ts-retry", "server.js");
    cliChild!.kill("SIGKILL");
    await waitForChildToExit(cliChild!, 2000);
    expect(findPidsOnPort(port).length).toBeGreaterThan(0);

    const failed = prune({ failOff: true });
    expect(failed.status).toBe(0);
    expect(failed.stdout).toContain("killed PID");
    expect(failed.stderr).toContain("keeping its route to retry");
    expect(await waitUntil(() => findPidsOnPort(port).length === 0, 3000)).toBe(true);
    expect(routeFor("ts-retry.localhost")?.tailscaleHttpsPort).toBe(443);

    const retried = prune();
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("removed tailscale serve on port 443");
    expect(serves()).toEqual({});
    expect(routeFor("ts-retry.localhost")).toBeUndefined();
  });
});
