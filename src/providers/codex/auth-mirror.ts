import { createHash, randomUUID } from "node:crypto";
import { access, lstat, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { dirname, resolve } from "node:path";

const authLocks = new Map<string, Promise<void>>();

function fingerprint(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function assertValidAuthJson(content: Buffer) {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("Refusing to mirror provider auth because auth.json is not valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Refusing to mirror provider auth because auth.json is not a JSON object.");
  }
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

class UnsettledAuthSnapshotError extends Error {}

async function readConsistentFile(path: string, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await stat(path);
    const content = await readFile(path);
    const after = await stat(path);
    if (
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      content.byteLength === after.size
    ) {
      const firstFingerprint = fingerprint(content);
      await delay(25);
      const verify = await readFile(path);
      if (fingerprint(verify) === firstFingerprint) return content;
    }
    await delay(25);
  }
  throw new UnsettledAuthSnapshotError("Provider auth did not settle to a consistent snapshot.");
}

async function withAuthLock<T>(authPath: string, operation: () => Promise<T>): Promise<T> {
  const canonicalPath = await realpath(authPath).catch(() => resolve(authPath));
  const key = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  const previous = authLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const chained = previous.then(() => current);
  authLocks.set(key, chained);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (authLocks.get(key) === chained) authLocks.delete(key);
  }
}

async function prepareAtomicReplacement(path: string, content: Buffer) {
  const tempPath = `${path}.agent-acp-kit-${randomUUID()}.tmp`;
  const mode = (await stat(path)).mode;
  const handle = await open(tempPath, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  return {
    commit: () => rename(tempPath, path),
    cleanup: () => rm(tempPath, { force: true }),
  };
}

async function refreshRunAuth(params: {
  createSymlink: (source: string, target: string) => Promise<void>;
  runAuthPath: string;
  stableContent: Buffer;
  stableAuthPath: string;
}) {
  try {
    const existing = await lstat(params.runAuthPath);
    await rm(params.runAuthPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A new run home normally has no auth file yet.
  }

  try {
    await params.createSymlink(params.stableAuthPath, params.runAuthPath);
    return "symlink" as const;
  } catch {
    // Windows commonly rejects file symlinks without Developer Mode/admin.
    await writeFile(params.runAuthPath, params.stableContent, { flag: "wx" });
    return "copy" as const;
  }
}

export type AuthFileMirror = {
  close(): Promise<void>;
  mode: "copy" | "symlink";
};

export async function createAuthFileMirror(params: {
  runAuthPath: string;
  stableAuthPath: string;
  /** Test seam for exercising the Windows copy fallback on every platform. */
  createSymlink?: (source: string, target: string) => Promise<void>;
  watchDirectory?: typeof watch;
}): Promise<AuthFileMirror> {
  const stableAuthPath = resolve(params.stableAuthPath);
  const runAuthPath = resolve(params.runAuthPath);
  const createSymlink =
    params.createSymlink ??
    (async (source: string, target: string) => symlink(source, target));

  let expectedStableFingerprint = "";
  let lastRunFingerprint = "";
  const mode = await withAuthLock(stableAuthPath, async () => {
    await access(stableAuthPath);
    const stableContent = await readConsistentFile(stableAuthPath);
    expectedStableFingerprint = fingerprint(stableContent);
    lastRunFingerprint = expectedStableFingerprint;
    return refreshRunAuth({
      createSymlink,
      runAuthPath,
      stableAuthPath,
      stableContent,
    });
  });

  let watcher: FSWatcher | undefined;
  let closing = false;
  let terminalError: Error | undefined;
  let syncQueue = Promise.resolve();
  let debounceTimer: NodeJS.Timeout | undefined;
  let closePromise: Promise<void> | undefined;

  async function syncRunToStable(snapshotAttempts = 4) {
    let runContent: Buffer;
    try {
      runContent = await readConsistentFile(runAuthPath, snapshotAttempts);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    assertValidAuthJson(runContent);
    const runFingerprint = fingerprint(runContent);
    if (runFingerprint === lastRunFingerprint) return;

    await withAuthLock(stableAuthPath, async () => {
      const replacement = await prepareAtomicReplacement(stableAuthPath, runContent);
      try {
        const stableContent = await readConsistentFile(stableAuthPath, snapshotAttempts);
        const stableFingerprint = fingerprint(stableContent);
        if (stableFingerprint === runFingerprint) {
          expectedStableFingerprint = stableFingerprint;
          lastRunFingerprint = runFingerprint;
          return;
        }
        if (stableFingerprint !== expectedStableFingerprint) {
          throw new Error(
            "Refusing to overwrite provider auth because the stable auth file changed concurrently.",
          );
        }
        await replacement.commit();
        const committedFingerprint = fingerprint(
          await readConsistentFile(stableAuthPath, snapshotAttempts),
        );
        if (committedFingerprint !== runFingerprint) {
          throw new Error("Provider auth changed during the final atomic replacement.");
        }
        expectedStableFingerprint = runFingerprint;
        lastRunFingerprint = runFingerprint;
      } finally {
        await replacement.cleanup();
      }
    });
  }

  function scheduleSync() {
    if (closing || terminalError) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      syncQueue = syncQueue
        .then(() => syncRunToStable())
        .catch((error: unknown) => {
          if (error instanceof UnsettledAuthSnapshotError && !closing) {
            scheduleSync();
            return;
          }
          terminalError =
            error instanceof Error ? error : new Error("Unable to synchronize provider auth.");
        });
    }, 25);
    debounceTimer.unref();
  }

  const watchDirectory = params.watchDirectory ?? watch;
  watcher = watchDirectory(dirname(runAuthPath), { persistent: false }, (_event, filename) => {
    if (!filename || filename.toString() === "auth.json") scheduleSync();
  });
  watcher.on("error", (error) => {
    terminalError =
      error instanceof Error ? error : new Error("Provider auth watcher failed.");
    try {
      watcher?.close();
    } catch {
      // Preserve the original watcher failure.
    }
    watcher = undefined;
  });

  async function closeMirror() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      watcher?.close();
      watcher = undefined;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      await syncQueue;
      if (!terminalError) {
        try {
          await syncRunToStable(20);
        } catch (error) {
          terminalError =
            error instanceof Error ? error : new Error("Unable to synchronize provider auth.");
        }
      }
      if (terminalError) throw terminalError;
    })();
    return closePromise;
  }

  return {
    mode,
    close: closeMirror,
  };
}
