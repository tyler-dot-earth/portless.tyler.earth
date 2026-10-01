import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isErrnoException, isProcessAlive } from "./utils.js";

/**
 * A lock for releasing stale Tailscale registrations and registering new ones (#280).
 *
 * Unlike the route lock, a section holding this lock runs `tailscale` commands, each of which can
 * take up to 30 seconds, so the lock is never taken from a live owner because of its age: waiters
 * time out instead. The lock file names its owner by PID and start time; only a lock whose owner
 * has exited, or whose PID now belongs to a process that started at another time, is removed, and
 * only by a process that has re-checked it under a short steal lock, so two waiters can't both
 * judge a lock stale and then remove each other's fresh one. A holder releases only its own lock.
 */

const LOCK_FILE = "tailscale.lock";
const STEAL_DIR = "tailscale.lock.steal";

/** How long to wait for the lock; a holder may be running several slow `tailscale` commands. */
const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_BASE_MS = 25;
const RETRY_CAP_MS = 250;
/** The steal lock, and a lock file without a readable owner, are only held for a few file operations. */
const SHORT_LIVED_STALE_MS = 10_000;

export interface TailscaleLockOptions {
  timeoutMs?: number;
  isAlive?: (pid: number) => boolean;
  /** When a process started, or undefined when that can't be told. */
  startedAt?: (pid: number) => string | undefined;
}

interface LockOwner {
  pid: number;
  token: string;
  /** When the owner started, to tell it from a later process given the same PID. */
  started?: string;
}

interface LockChecks {
  isAlive: (pid: number) => boolean;
  startedAt: (pid: number) => string | undefined;
}

/**
 * When a process started according to `ps`, in a fixed timezone and locale: `lstart` is local time
 * in the caller's format, so two processes would otherwise describe the same start differently.
 */
export function psStartTime(pid: number): string | undefined {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * When a process started: its boot-relative start time from `/proc` on Linux, or `ps` elsewhere.
 * Undefined when it can't be read, such as on Windows.
 */
export function processStartTime(pid: number): string | undefined {
  if (process.platform === "win32") return undefined;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      // Fields after the command name, which may contain spaces; `starttime` is field 22 overall.
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
    } catch {
      return undefined;
    }
  }
  return psStartTime(pid);
}

interface LockOnDisk {
  /** Undefined when the file can't be read as an owner, such as a lock directory from an older portless. */
  owner: LockOwner | undefined;
  ino: number;
  ageMs: number;
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function parseOwner(raw: string): LockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      "token" in parsed &&
      typeof parsed.pid === "number" &&
      typeof parsed.token === "string"
    ) {
      const started =
        "started" in parsed && typeof parsed.started === "string" ? parsed.started : undefined;
      return { pid: parsed.pid, token: parsed.token, ...(started ? { started } : {}) };
    }
  } catch {
    // Not an owner record
  }
  return undefined;
}

function readLock(lockPath: string): LockOnDisk | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return undefined;
  }
  let owner: LockOwner | undefined;
  if (stat.isFile()) {
    try {
      owner = parseOwner(fs.readFileSync(lockPath, "utf-8"));
    } catch {
      owner = undefined;
    }
  }
  return { owner, ino: stat.ino, ageMs: Date.now() - stat.mtimeMs };
}

/** Create the lock with its owner record in one step, so a reader never sees it without an owner. */
function tryCreate(lockPath: string, owner: LockOwner): boolean {
  const temp = `${lockPath}.${owner.token}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(owner));
  try {
    fs.linkSync(temp, lockPath);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === "EEXIST") return false;
    throw err;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function isStale(lock: LockOnDisk, checks: LockChecks): boolean {
  if (lock.owner === undefined) return lock.ageMs > SHORT_LIVED_STALE_MS;
  if (!checks.isAlive(lock.owner.pid)) return true;
  // A live process with the owner's PID is the owner, unless it provably started at another time.
  if (lock.owner.started === undefined) return false;
  const started = checks.startedAt(lock.owner.pid);
  return started !== undefined && started !== lock.owner.started;
}

/** Remove a stale lock, but only if it is still the one that was judged stale. */
function removeIfStillStale(dir: string, seen: LockOnDisk, checks: LockChecks): void {
  const stealPath = path.join(dir, STEAL_DIR);
  try {
    fs.mkdirSync(stealPath);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "EEXIST") return;
    // Another process is removing it; clear a steal lock left by one that died mid-removal.
    try {
      if (Date.now() - fs.statSync(stealPath).mtimeMs > SHORT_LIVED_STALE_MS) {
        fs.rmSync(stealPath, { recursive: true, force: true });
      }
    } catch {
      // Already gone
    }
    return;
  }
  try {
    const lockPath = path.join(dir, LOCK_FILE);
    const current = readLock(lockPath);
    if (
      current !== undefined &&
      current.ino === seen.ino &&
      current.owner?.token === seen.owner?.token &&
      isStale(current, checks)
    ) {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(stealPath, { recursive: true, force: true });
  }
}

/**
 * Run `fn` while holding the Tailscale lock in `dir`. Throws when the lock can't be acquired
 * within the timeout.
 */
export function withTailscaleLock<T>(
  dir: string,
  fn: () => T,
  options: TailscaleLockOptions = {}
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checks: LockChecks = {
    isAlive: options.isAlive ?? isProcessAlive,
    startedAt: options.startedAt ?? processStartTime,
  };
  const lockPath = path.join(dir, LOCK_FILE);
  const started = checks.startedAt(process.pid);
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    ...(started ? { started } : {}),
  };

  const deadline = Date.now() + timeoutMs;
  let delay = RETRY_BASE_MS;
  let acquired = false;
  while (!acquired) {
    acquired = tryCreate(lockPath, owner);
    if (acquired) break;
    const current = readLock(lockPath);
    // Gone since the attempt: try again right away.
    if (current === undefined) continue;
    if (isStale(current, checks)) {
      removeIfStillStale(dir, current, checks);
      if (readLock(lockPath)?.ino !== current.ino) continue;
    }
    if (Date.now() >= deadline) {
      const holder = current.owner ? ` held by process ${current.owner.pid}` : "";
      throw new Error(
        `Failed to acquire Tailscale lock${holder}. If no portless process is running, remove ${lockPath}.`
      );
    }
    sleep(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, RETRY_CAP_MS);
  }

  try {
    return fn();
  } finally {
    // Remove the lock only while it is still ours.
    if (readLock(lockPath)?.owner?.token === owner.token) {
      fs.rmSync(lockPath, { force: true });
    }
  }
}
