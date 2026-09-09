import fs from "fs";
import path from "path";

let staleQuarantineSequence = 0;

function quarantinePath(lock) {
  const sequence = staleQuarantineSequence++;
  return `${lock}.${process.pid}.${Date.now()}.${sequence}.stale`;
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

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
        const observed = fs.statSync(lock);
        if (Date.now() - observed.mtimeMs > staleMs) {
          // Move the observed inode away atomically before deleting it. A
          // replacement lock created at the original path is then never the
          // path passed to rmSync.
          const stale = quarantinePath(lock);
          try {
            fs.renameSync(lock, stale);
          } catch (renameError) {
            if (renameError.code === "ENOENT") continue;
            throw renameError;
          }
          // A release/reacquire can replace the path before rename. Verify
          // that the quarantined inode is the one we actually observed; if it
          // is not, restore it without overwriting a newer lock.
          if (!sameFileIdentity(observed, fs.statSync(stale))) {
            try {
              fs.linkSync(stale, lock);
              fs.rmSync(stale, { force: true });
            } catch {
              // Never delete either path when the replacement cannot be
              // restored atomically.
            }
            continue;
          }
          try {
            fs.rmSync(stale, { force: true });
          } catch {
            // The live lock path was already detached; do not touch it if
            // cleanup of the quarantined inode is temporarily unavailable.
          }
          continue;
        }
      } catch {
        // Lock vanished while it was being inspected or quarantined — retry.
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
