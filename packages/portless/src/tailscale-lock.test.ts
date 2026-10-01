import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withTailscaleLock } from "./tailscale-lock.js";

describe("withTailscaleLock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-tailscale-lock-"));
    lockPath = path.join(dir, "tailscale.lock");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a lock held by `pid`, last modified `ageMs` ago. */
  function writeLock(pid: number, token: string, ageMs: number): void {
    fs.writeFileSync(lockPath, JSON.stringify({ pid, token }));
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(lockPath, at, at);
  }

  function lockToken(): string | undefined {
    if (!fs.existsSync(lockPath)) return undefined;
    return (JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { token: string }).token;
  }

  it("holds the lock only while the work runs and returns its result", () => {
    const result = withTailscaleLock(dir, () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases the lock when the work throws", () => {
    expect(() =>
      withTailscaleLock(dir, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("never takes a live owner's lock because of its age", () => {
    // A holder can be blocked in tailscale commands far longer than the route lock's 10 seconds.
    writeLock(process.pid, "holder", 60_000);
    let ran = false;
    expect(() =>
      withTailscaleLock(
        dir,
        () => {
          ran = true;
        },
        { timeoutMs: 300 }
      )
    ).toThrow("Failed to acquire Tailscale lock");
    expect(ran).toBe(false);
    expect(lockToken()).toBe("holder");
  });

  it("takes the lock of an owner that has exited", () => {
    writeLock(4242, "dead", 0);
    const ran = withTailscaleLock(dir, () => lockToken() !== "dead", {
      timeoutMs: 300,
      isAlive: () => false,
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("takes a live owner's lock once it is held past the ceiling, in case its PID was reused", () => {
    writeLock(process.pid, "reused", 5_000);
    expect(withTailscaleLock(dir, () => true, { timeoutMs: 300, maxHoldMs: 1_000 })).toBe(true);
  });

  it("takes a lock directory left by an older version only once it is stale", () => {
    fs.mkdirSync(lockPath);
    expect(() => withTailscaleLock(dir, () => true, { timeoutMs: 300 })).toThrow(
      "Failed to acquire Tailscale lock"
    );
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(lockPath, old, old);
    expect(withTailscaleLock(dir, () => true, { timeoutMs: 300 })).toBe(true);
  });

  it("does not remove a lock that is no longer its own", () => {
    withTailscaleLock(dir, () => {
      // Someone else's lock replaced this one while the work ran.
      fs.rmSync(lockPath);
      writeLock(process.pid, "successor", 0);
    });
    expect(lockToken()).toBe("successor");
  });

  it("leaves no temporary files behind", () => {
    writeLock(process.pid, "holder", 0);
    expect(() => withTailscaleLock(dir, () => true, { timeoutMs: 100 })).toThrow();
    fs.rmSync(lockPath);
    withTailscaleLock(dir, () => true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
