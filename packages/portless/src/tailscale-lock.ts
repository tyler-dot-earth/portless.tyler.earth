import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isErrnoException, isProcessAlive } from "./utils.js";

/**
 * A lock for releasing stale Tailscale registrations and registering new ones (#280).
 *
 * Unlike the route lock, a section holding this lock runs `tailscale` commands, each of which can
 * take up to 30 seconds, so the lock is never taken from a live owner because of its age. The lock
 * file names its owner; only a lock whose owner has exited (or one held implausibly long, in case
 * its PID was reused) is removed, and only by a process that has re-checked it under a short steal
 * lock, so two waiters can't both judge a lock stale and then remove each other's fresh one. A
 * holder releases only its own lock.
 */

const LOCK_FILE = "tailscale.lock";
const STEAL_DIR = "tailscale.lock.steal";

/** How long to wait for the lock; a holder may be running several slow `tailscale` commands. */
const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_BASE_MS = 25;
const RETRY_CAP_MS = 250;
/** A live owner's lock is taken after this long, in case the owner's PID was reused. */
const DEFAULT_MAX_HOLD_MS = 10 * 60_000;
/** The steal lock, and a lock file without a readable owner, are only held for a few file operations. */
const SHORT_LIVED_STALE_MS = 10_000;

export interface TailscaleLockOptions {
  timeoutMs?: number;
  maxHoldMs?: number;
  isAlive?: (pid: number) => boolean;
}

interface LockOwner {
  pid: number;
  token: string;
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
      return { pid: parsed.pid, token: parsed.token };
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

function isStale(lock: LockOnDisk, isAlive: (pid: number) => boolean, maxHoldMs: number): boolean {
  if (lock.owner === undefined) return lock.ageMs > SHORT_LIVED_STALE_MS;
  if (!isAlive(lock.owner.pid)) return true;
  return lock.ageMs > maxHoldMs;
}

/** Remove a stale lock, but only if it is still the one that was judged stale. */
function removeIfStillStale(
  dir: string,
  seen: LockOnDisk,
  isAlive: (pid: number) => boolean,
  maxHoldMs: number
): void {
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
      isStale(current, isAlive, maxHoldMs)
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
  const maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const isAlive = options.isAlive ?? isProcessAlive;
  const lockPath = path.join(dir, LOCK_FILE);
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };

  const deadline = Date.now() + timeoutMs;
  let delay = RETRY_BASE_MS;
  let acquired = false;
  while (!acquired) {
    acquired = tryCreate(lockPath, owner);
    if (acquired) break;
    const current = readLock(lockPath);
    // Gone since the attempt: try again right away.
    if (current === undefined) continue;
    if (isStale(current, isAlive, maxHoldMs)) {
      removeIfStillStale(dir, current, isAlive, maxHoldMs);
      if (readLock(lockPath)?.ino !== current.ino) continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("Failed to acquire Tailscale lock");
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
