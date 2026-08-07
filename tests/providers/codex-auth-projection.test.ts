import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMutagenCli,
  projectAuthFile,
  projectSharedLockFile,
  type MutagenCli,
} from "../../src/providers/codex/auth-projection.js";
import { createProviderRunWorkspaceManager } from "../../src/providers/run-workspace.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "agent-acp-kit-auth-test-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Codex-compatible auth projection", () => {
  it("reuses an explicit Mutagen binary without invoking automatic installation", async () => {
    const ensureCached = vi.fn(async () => process.execPath);
    await createMutagenCli(
      { PATH: "", TUTTI_MUTAGEN_BIN: process.execPath },
      { ensureCached },
    );
    expect(ensureCached).not.toHaveBeenCalled();
  });

  it("uses the verified cache installer only when override and PATH resolution miss", async () => {
    const ensureCached = vi.fn(async () => process.execPath);
    await createMutagenCli(
      { PATH: "", TUTTI_MUTAGEN_BIN: "" },
      { ensureCached },
    );
    expect(ensureCached).toHaveBeenCalledTimes(1);
  });

  it("prefers a successful file symlink without creating a Mutagen session", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "stable", "auth.json");
    const target = join(root, "run", "auth.json");
    await mkdir(join(root, "stable"), { recursive: true });
    await writeFile(source, "stable");
    const run = vi.fn(async () => ({ stderr: "", stdout: "" }));
    const onCleanup = vi.fn();
    await projectAuthFile({
      mutagenCli: { run },
      onCleanup,
      providerId: "codex",
      runAuthPath: target,
      runId: "symlink",
      sourceAuthPath: source,
      symlinkFile: async () => {},
    });
    expect(run).not.toHaveBeenCalled();
    expect(onCleanup).not.toHaveBeenCalled();
  });

  it("uses Mutagen two-way-safe with default real-time watching when symlinks fail", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "stable", "auth.json");
    const target = join(root, "run", "auth.json");
    await mkdir(join(root, "stable"), { recursive: true });
    await writeFile(source, "stable");
    const callbacks: Array<() => Promise<void>> = [];
    const calls: string[][] = [];
    const cli: MutagenCli = {
      async run(args) {
        calls.push([...args]);
        if (args[1] === "flush") await writeFile(source, await readFile(target));
        return {
          stderr: "",
          stdout: args[1] === "list" ? JSON.stringify({ sessions: [{ conflicts: [] }] }) : "",
        };
      },
    };

    await projectAuthFile({
      mutagenCli: cli,
      onCleanup: (callback) => callbacks.push(callback),
      providerId: "tutti-agent",
      runAuthPath: target,
      runId: "run-1",
      sourceAuthPath: source,
      symlinkFile: async () => {
        throw new Error("symlink denied");
      },
    });
    await writeFile(target, "refreshed");
    await callbacks[0]!();

    expect(await readFile(source, "utf8")).toBe("refreshed");
    expect(calls[0]).toContain("--sync-mode=two-way-safe");
    expect(calls[0]?.some((arg) => arg.startsWith("--watch-mode"))).toBe(false);
    expect(calls.map((args) => args[1])).toEqual(["create", "flush", "flush", "list", "terminate"]);
  });

  it("preserves the Mutagen session when cleanup finds conflicts", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "stable", "auth.json");
    const target = join(root, "run", "auth.json");
    await mkdir(join(root, "stable"), { recursive: true });
    await writeFile(source, "stable");
    const callbacks: Array<() => Promise<void>> = [];
    const calls: string[][] = [];
    await projectAuthFile({
      mutagenCli: {
        async run(args) {
          calls.push([...args]);
          return {
            stderr: "",
            stdout: args[1] === "list" ? JSON.stringify({ conflicts: [{ path: "auth.json" }] }) : "",
          };
        },
      },
      onCleanup: (callback) => callbacks.push(callback),
      providerId: "codex",
      runAuthPath: target,
      runId: "conflict",
      sourceAuthPath: source,
      symlinkFile: async () => {
        throw new Error("symlink denied");
      },
    });

    await expect(callbacks[0]!()).rejects.toThrow(/conflict.*preserved/i);
    expect(calls.some((args) => args[1] === "terminate")).toBe(false);
    await expect(stat(target)).resolves.toBeDefined();
  });

  it("projects Tutti Agent refresh locks onto the same file object", async () => {
    const root = await temporaryDirectory();
    const sourceHome = join(root, "stable");
    const runHome = join(root, "run");
    await projectSharedLockFile(sourceHome, runHome);
    await writeFile(join(runHome, ".refresh.lock"), "locked");
    expect(await readFile(join(sourceHome, ".refresh.lock"), "utf8")).toBe("locked");
    const [sourceStat, runStat] = await Promise.all([
      stat(join(sourceHome, ".refresh.lock")),
      stat(join(runHome, ".refresh.lock")),
    ]);
    expect([runStat.dev, runStat.ino]).toEqual([sourceStat.dev, sourceStat.ino]);
  });

  it("keeps the run workspace when a cleanup callback fails", async () => {
    const manager = createProviderRunWorkspaceManager("test");
    let root = "";
    await manager.prepare("run", undefined, async (workspace) => {
      root = await workspace.getRoot();
      workspace.onCleanup(async () => {
        throw new Error("conflict");
      });
    });
    await expect(manager.cleanup("run")).rejects.toThrow("conflict");
    await expect(stat(root)).resolves.toBeDefined();
  });

  it.skipIf(process.env.RUN_MUTAGEN_E2E !== "1")(
    "round-trips auth through a real Mutagen session",
    async () => {
      const root = await temporaryDirectory();
      const source = join(root, "stable", "auth.json");
      const target = join(root, "run", "auth.json");
      await mkdir(join(root, "stable"), { recursive: true });
      await writeFile(source, "stable");
      const callbacks: Array<() => Promise<void>> = [];
      await projectAuthFile({
        onCleanup: (callback) => callbacks.push(callback),
        providerId: "codex",
        runAuthPath: target,
        runId: "real-e2e",
        sourceAuthPath: source,
        symlinkFile: async () => {
          throw new Error("force Mutagen E2E");
        },
      });
      await writeFile(target, "refreshed-by-run");
      await callbacks[0]!();
      expect(await readFile(source, "utf8")).toBe("refreshed-by-run");
    },
    60_000,
  );
});
