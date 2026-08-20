import fs from "fs";
import path from "path";

/**
 * Acquire a coarse advisory lockfile via O_EXCL (mode "wx").
 * Supports stale lock reaping, retry loop with backoff, and ensures
 * cleanup on success or error.
 *
 * @template T
 * @param {string} filePath Target file path being locked
 * @param {() => T} fn Callback executed while holding the lock
 * @param {object} [options]
 * @param {number} [options.retries=100] Max retry attempts
 * @param {number} [options.delayMs=5] Delay between retry attempts in ms
 * @param {number} [options.staleMs=10000] Age after which an existing lock is reaped
 * @returns {T}
 */
export function withFileLock(
  filePath,
  fn,
  { retries = 100, delayMs = 5, staleMs = 10000 } = {},
) {
  const lock = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let fd = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      // Reap a stale lock (older than staleMs, default 10s) left by a crashed writer.
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > staleMs) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // Lock vanished between stat and rm — retry immediately
        continue;
      }

      const wait = delayMs;
      const until = Date.now() + wait;
      while (Date.now() < until) {
        // Synchronous pause; file operations are short-lived
      }
    }
  }

  if (fd === null) {
    throw new Error(`could not acquire lock: ${lock}`);
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    fs.rmSync(lock, { force: true });
  }
}
