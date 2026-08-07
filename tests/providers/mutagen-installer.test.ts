import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureCachedMutagen,
  MUTAGEN_VERSION,
} from "../../src/providers/codex/mutagen-installer.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "agent-acp-kit-mutagen-test-"));
  temporaryPaths.push(path);
  return path;
}

function archiveWithBinary(name: string, content: Buffer) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  const padding = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length);
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Mutagen automatic installer", () => {
  it("reuses an existing versioned cache without downloading", async () => {
    const cacheRoot = await temporaryDirectory();
    const target = join(cacheRoot, `v${MUTAGEN_VERSION}`, "win32-x64", "mutagen.exe");
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "cached");
    const downloader = vi.fn(async () => new Uint8Array());
    expect(await ensureCachedMutagen({ cacheRoot, downloader, platform: "win32", arch: "x64" })).toBe(target);
    expect(downloader).not.toHaveBeenCalled();
  });

  it("rejects a checksum mismatch without publishing a partial binary", async () => {
    const cacheRoot = await temporaryDirectory();
    await expect(
      ensureCachedMutagen({
        asset: { fileName: "test.tar.gz", sha256: "0".repeat(64) },
        cacheRoot,
        downloader: async () => archiveWithBinary("mutagen.exe", Buffer.from("bad")),
        platform: "win32",
        arch: "x64",
      }),
    ).rejects.toThrow(/SHA-256 mismatch/);
    await expect(readFile(join(cacheRoot, `v${MUTAGEN_VERSION}`, "win32-x64", "mutagen.exe"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent installs and atomically publishes one verified binary", async () => {
    const cacheRoot = await temporaryDirectory();
    const content = Buffer.from("fake-mutagen-binary");
    const archive = archiveWithBinary("mutagen.exe", content);
    const downloader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return archive;
    });
    const options = {
      asset: {
        fileName: "test.tar.gz",
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
      cacheRoot,
      downloader,
      platform: "win32" as const,
      arch: "x64" as const,
    };
    const [first, second] = await Promise.all([
      ensureCachedMutagen(options),
      ensureCachedMutagen(options),
    ]);
    expect(second).toBe(first);
    expect(downloader).toHaveBeenCalledTimes(1);
    expect(await readFile(first)).toEqual(content);
  });
});
