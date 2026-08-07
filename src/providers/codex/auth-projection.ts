import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveCommandExecutable } from "../../process/command-resolver.js";
import { resolveProcessInvocation } from "../../process/process-adapter.js";
import { ensureCachedMutagen } from "./mutagen-installer.js";

export type MutagenCommandResult = {
  stderr: string;
  stdout: string;
};

export type MutagenCli = {
  run(args: readonly string[]): Promise<MutagenCommandResult>;
};

function envValue(env: NodeJS.ProcessEnv, key: string) {
  const match = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return match ? env[match] : undefined;
}

function mergeEnv(inputEnv: Record<string, string> | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(inputEnv ?? {})) {
    const inheritedKey = Object.keys(env).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    if (inheritedKey && inheritedKey !== key) delete env[inheritedKey];
    env[key] = value;
  }
  return env;
}

function execFileResult(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<MutagenCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        env,
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Mutagen command failed: ${stderr.trim() || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve({ stderr, stdout });
      },
    );
  });
}

export async function createMutagenCli(
  inputEnv: Record<string, string> | undefined,
  options: {
    allowInstall?: boolean;
    ensureCached?: typeof ensureCachedMutagen;
  } = {},
): Promise<MutagenCli> {
  const env = mergeEnv(inputEnv);
  const configured = envValue(env, "TUTTI_MUTAGEN_BIN");
  let executable: string;
  try {
    executable = await resolveCommandExecutable({
      command: configured || "mutagen",
      env,
    });
  } catch (error) {
    if (options.allowInstall === false) throw error;
    try {
      executable = await (options.ensureCached ?? ensureCachedMutagen)();
    } catch (installError) {
      throw new AggregateError(
        [error, installError],
        "Mutagen is required because auth.json could not be symlinked. Configure TUTTI_MUTAGEN_BIN, install mutagen on PATH, or allow the verified automatic installation.",
      );
    }
  }

  return {
    async run(args) {
      const invocation = resolveProcessInvocation({
        args,
        command: executable,
        env,
        overridePath: executable,
      });
      return execFileResult(invocation.command, invocation.args, invocation.env);
    },
  };
}

type AuthSnapshot = {
  bytes: Buffer;
  digest: string;
};

async function readValidAuthSnapshot(path: string): Promise<AuthSnapshot> {
  const bytes = await readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Refusing to synchronize invalid auth JSON at ${path}.`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Refusing to synchronize non-object auth JSON at ${path}.`);
  }
  return {
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function replaceAuthAtomically(path: string, bytes: Buffer) {
  const temporaryPath = join(dirname(path), `.auth.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function registerCopyFallback(params: {
  baseline: AuthSnapshot;
  onCleanup(callback: () => Promise<void>): void;
  runAuthPath: string;
  sourceAuthPath: string;
}) {
  params.onCleanup(async () => {
    const run = await readValidAuthSnapshot(params.runAuthPath);
    if (run.digest === params.baseline.digest) return;

    const source = await readValidAuthSnapshot(params.sourceAuthPath);
    if (source.digest === run.digest) return;
    if (source.digest !== params.baseline.digest) {
      throw new Error(
        "Auth changed in both the stable and run homes while Mutagen was unavailable; both files were preserved for recovery.",
      );
    }
    await replaceAuthAtomically(params.sourceAuthPath, run.bytes);
  });
}

function hasConflictValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return !["", "0", "false", "null", "none"].includes(value.toLowerCase());
  }
  return false;
}

export function mutagenOutputHasConflicts(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(mutagenOutputHasConflicts);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    key.toLowerCase() === "conflicts"
      ? hasConflictValue(child)
      : mutagenOutputHasConflicts(child),
  );
}

async function inspectConflicts(cli: MutagenCli, sessionName: string) {
  const result = await cli.run([
    "sync",
    "list",
    "--template={{ json . }}",
    sessionName,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Mutagen returned invalid JSON while checking auth conflicts.", {
      cause: error,
    });
  }
  return mutagenOutputHasConflicts(parsed);
}

function safeSessionPart(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-").slice(0, 32) || "run";
}

export async function projectAuthFile(params: {
  createMutagenCli?: typeof createMutagenCli;
  env?: Record<string, string>;
  onCleanup(callback: () => Promise<void>): void;
  providerId: string;
  runAuthPath: string;
  runId: string;
  sourceAuthPath: string;
  mutagenCli?: MutagenCli;
  symlinkFile?: typeof symlink;
}) {
  await access(params.sourceAuthPath);
  await mkdir(dirname(params.runAuthPath), { recursive: true });
  await rm(params.runAuthPath, { force: true });
  try {
    await (params.symlinkFile ?? symlink)(params.sourceAuthPath, params.runAuthPath);
    return { kind: "symlink" as const };
  } catch {
    // File symlinks commonly require elevated privileges on Windows. Mutagen
    // supplies the bidirectional, conflict-aware fallback without polling.
  }

  const baseline = await readValidAuthSnapshot(params.sourceAuthPath);
  await replaceAuthAtomically(params.runAuthPath, baseline.bytes);
  let cli: MutagenCli;
  try {
    cli =
      params.mutagenCli ??
      (await (params.createMutagenCli ?? createMutagenCli)(params.env, {
        allowInstall: false,
      }));
  } catch {
    await registerCopyFallback({ ...params, baseline });
    return { kind: "copy" as const };
  }
  const sessionName = [
    "tutti-auth",
    safeSessionPart(params.providerId),
    safeSessionPart(params.runId),
    randomUUID(),
  ].join("-");
  try {
    await cli.run([
      "sync",
      "create",
      `--name=${sessionName}`,
      "--sync-mode=two-way-safe",
      "--no-global-configuration",
      params.sourceAuthPath,
      params.runAuthPath,
    ]);
    // `sync create` can return before the initial scan has established a
    // common baseline. Flush once before launching the provider so an
    // immediate token refresh is not misclassified as a two-sided conflict.
    await cli.run(["sync", "flush", sessionName]);
  } catch (error) {
    try {
      await cli.run(["sync", "terminate", sessionName]);
    } catch {
      // Preserve the original creation/initialization failure.
    }
    await rm(params.runAuthPath, { force: true });
    throw error;
  }

  params.onCleanup(async () => {
    try {
      await cli.run(["sync", "flush", sessionName]);
    } catch (flushError) {
      try {
        if (await inspectConflicts(cli, sessionName)) {
          throw new Error(
            `Mutagen auth synchronization conflict in session ${sessionName}; the run directory and session were preserved for recovery.`,
          );
        }
      } catch (inspectionError) {
        if (inspectionError instanceof Error && inspectionError.message.includes("conflict")) {
          throw inspectionError;
        }
      }
      throw new Error(
        `Mutagen could not flush auth session ${sessionName}; the run directory and session were preserved for recovery.`,
        { cause: flushError },
      );
    }

    if (await inspectConflicts(cli, sessionName)) {
      throw new Error(
        `Mutagen auth synchronization conflict in session ${sessionName}; the run directory and session were preserved for recovery.`,
      );
    }
    try {
      await cli.run(["sync", "terminate", sessionName]);
    } catch (error) {
      throw new Error(
        `Mutagen could not terminate auth session ${sessionName}; the run directory and session were preserved for recovery.`,
        { cause: error },
      );
    }
  });

  return { kind: "mutagen" as const, sessionName };
}

export async function projectSharedLockFile(sourceHome: string, runHome: string) {
  const source = join(sourceHome, ".refresh.lock");
  const target = join(runHome, ".refresh.lock");
  await mkdir(sourceHome, { recursive: true });
  await mkdir(runHome, { recursive: true });
  await writeFile(source, "", { flag: "a" });
  await rm(target, { force: true });
  try {
    await symlink(source, target);
  } catch {
    try {
      await link(source, target);
    } catch (error) {
      throw new Error(
        "Tutti Agent .refresh.lock must reference the same OS file object in stable and run homes.",
        { cause: error },
      );
    }
  }
}
