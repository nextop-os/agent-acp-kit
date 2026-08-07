import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthFileMirror } from "../../src/providers/codex/auth-mirror.js";

const tempDirs: string[] = [];

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-acp-kit-auth-mirror-"));
  tempDirs.push(root);
  const stableDir = join(root, "stable");
  const runDir = join(root, "run");
  await mkdir(stableDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const stableAuthPath = join(stableDir, "auth.json");
  const runAuthPath = join(runDir, "auth.json");
  await writeFile(stableAuthPath, '{"token":"stable-v1"}', "utf8");
  return { root, runAuthPath, stableAuthPath };
}

async function atomicReplace(path: string, content: string) {
  const temp = `${path}.next`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("createAuthFileMirror", () => {
  it("falls back to a fresh copy and refreshes a stale run file on reuse", async () => {
    const fixture = await createFixture();
    const rejectSymlink = async () => {
      throw new Error("file symlinks unavailable");
    };
    await writeFile(fixture.runAuthPath, '{"token":"stale-run"}', "utf8");

    const first = await createAuthFileMirror({ ...fixture, createSymlink: rejectSymlink });
    expect(first.mode).toBe("copy");
    await expect(readFile(fixture.runAuthPath, "utf8")).resolves.toBe(
      '{"token":"stable-v1"}',
    );
    await first.close();

    await writeFile(fixture.stableAuthPath, '{"token":"stable-v2"}', "utf8");
    await writeFile(fixture.runAuthPath, '{"token":"older-run"}', "utf8");
    const reused = await createAuthFileMirror({ ...fixture, createSymlink: rejectSymlink });
    await expect(readFile(fixture.runAuthPath, "utf8")).resolves.toBe(
      '{"token":"stable-v2"}',
    );
    await reused.close();
  });

  it("mirrors an atomic run-home replacement back to stable auth", async () => {
    const fixture = await createFixture();
    const mirror = await createAuthFileMirror({
      ...fixture,
      createSymlink: async () => {
        throw new Error("force copy fallback");
      },
    });

    await atomicReplace(fixture.runAuthPath, '{"token":"run-v2"}');
    await vi.waitFor(async () => {
      await expect(readFile(fixture.stableAuthPath, "utf8")).resolves.toBe(
        '{"token":"run-v2"}',
      );
    });
    await mirror.close();
  });

  it("fails closed when stable auth changes independently", async () => {
    const fixture = await createFixture();
    const mirror = await createAuthFileMirror({
      ...fixture,
      createSymlink: async () => {
        throw new Error("force copy fallback");
      },
    });

    await atomicReplace(fixture.stableAuthPath, '{"token":"external-v2"}');
    await atomicReplace(fixture.runAuthPath, '{"token":"run-v2"}');

    await expect(mirror.close()).rejects.toThrow("changed concurrently");
    await expect(readFile(fixture.stableAuthPath, "utf8")).resolves.toBe(
      '{"token":"external-v2"}',
    );
  });

  it("closes its watcher and does not sync later changes", async () => {
    const fixture = await createFixture();
    const mirror = await createAuthFileMirror({
      ...fixture,
      createSymlink: async () => {
        throw new Error("force copy fallback");
      },
    });
    await mirror.close();

    await atomicReplace(fixture.runAuthPath, "after-close");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(readFile(fixture.stableAuthPath, "utf8")).resolves.toBe(
      '{"token":"stable-v1"}',
    );
  });

  it("captures watcher errors without throwing from the event callback", async () => {
    const fixture = await createFixture();
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    const mirror = await createAuthFileMirror({
      ...fixture,
      createSymlink: async () => {
        throw new Error("force copy fallback");
      },
      watchDirectory: (() => watcher) as unknown as typeof watch,
    });

    expect(() => watcher.emit("error", new Error("watch failed"))).not.toThrow();
    await expect(mirror.close()).rejects.toThrow("watch failed");
    expect(watcher.close).toHaveBeenCalled();
  });

  it("retries a slow in-place write during final flush and shares concurrent close", async () => {
    const fixture = await createFixture();
    const mirror = await createAuthFileMirror({
      ...fixture,
      createSymlink: async () => {
        throw new Error("force copy fallback");
      },
    });
    const handle = await open(fixture.runAuthPath, "w");
    await handle.write('{"token":"run-');
    const writing = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      await handle.write("v2-");
      await new Promise((resolve) => setTimeout(resolve, 15));
      await handle.write('complete"}');
      await handle.close();
    })();

    const closes = Promise.all([mirror.close(), mirror.close()]);
    await writing;
    await closes;
    await expect(readFile(fixture.stableAuthPath, "utf8")).resolves.toBe(
      '{"token":"run-v2-complete"}',
    );
  });

  it("rejects malformed run auth without overwriting stable auth", async () => {
    const fixture = await createFixture();
    const mirror = await createAuthFileMirror({
      ...fixture,
      createSymlink: async () => {
        throw new Error("force copy fallback");
      },
    });

    await atomicReplace(fixture.runAuthPath, '{"token":');

    await expect(mirror.close()).rejects.toThrow("not valid JSON");
    await expect(readFile(fixture.stableAuthPath, "utf8")).resolves.toBe(
      '{"token":"stable-v1"}',
    );
  });
});
