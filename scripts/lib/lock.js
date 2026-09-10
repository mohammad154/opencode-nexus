import fs from "fs";
import path from "path";

let staleQuarantineSequence = 0;

function quarantinePath(lock) {
  const sequence = staleQuarantineSequence++;
  return `${lock}.${process.pid}.${Date.now()}.${sequence}.stale`;
}

function sameFileIdentity(left, right) {
  // rename(2) may change ctime, so device/inode are the stable identity
  // fields for the observed lock through quarantine.
  return left.dev === right.dev && left.ino === right.ino;
}

function createLock(lock) {
  const fd = fs.openSync(lock, "wx");
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + "\n",
      "utf8",
    );
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    fs.rmSync(lock, { force: true });
    throw error;
  }
}

function lockOwnerIsAlive(lock) {
  try {
    const content = JSON.parse(fs.readFileSync(lock, "utf8"));
    const pid = Number(content?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM proves that a process exists but is owned by someone else; only
      // ESRCH is evidence that the lock owner died.
      return error?.code === "ESRCH" ? false : true;
    }
  } catch {
    // Preserve the legacy age-based reap behavior for old/corrupt lockfiles.
    return null;
  }
}

/**
 * Acquire a coarse advisory lockfile via O_EXCL (mode "wx").
 * Supports stale/dead-owner reaping, retry loop with backoff, and ensures
 * cleanup on success or error. A lock with a live recorded PID is never
 * reaped merely because a long operation exceeds `staleMs`.
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
      fd = createLock(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      // Reap a stale lock (older than staleMs, default 10s) left by a crashed writer.
      let observedFd = null;
      try {
        // Keep the observed inode open across the rename. Without that pin,
        // a fast unlink/create race can reuse an inode and look like the old
        // lock, causing us to delete a replacement owner's lock.
        observedFd = fs.openSync(lock, "r");
        const observed = fs.fstatSync(observedFd);
        const ownerAlive = lockOwnerIsAlive(lock);
        const ageMs = Date.now() - observed.mtimeMs;
        if (ownerAlive === false || (ageMs > staleMs && ownerAlive !== true)) {
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
          // A successful reap is not an exhausted acquisition retry. Try
          // once immediately so `{ retries: 1 }` still recovers a dead lock.
          try {
            fd = createLock(lock);
            break;
          } catch (retryError) {
            if (retryError.code !== "EEXIST") throw retryError;
          }
        }
      } catch (reapError) {
        // A disappearing pathname is a normal contender race. Permission,
        // filesystem, and metadata-write failures are actionable and must not
        // be misreported as a busy verification lock.
        if (reapError?.code === "ENOENT") continue;
        throw reapError;
      } finally {
        if (observedFd !== null) {
          try { fs.closeSync(observedFd); } catch {}
        }
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
