import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";

import { resolveCommandExecutableSync } from "./command-resolver.js";

/**
 * A shell-free Windows command launch plan.
 *
 * Node cannot execute `.cmd`/`.bat` files directly. Passing arbitrary agent
 * arguments through `cmd.exe /c` is unsafe because cmd reparses metacharacters.
 * This adapter resolves direct executable shims, npm/node shims, and PowerShell
 * `-File` shims to shell-free launch plans. Unknown batch files fail closed.
 * Non-Windows callers receive `null`.
 */
export type WindowsBatchResolved = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export function isWindowsBatchShim(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command.trim());
}

export function resolveWindowsBatchCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  options: { env?: NodeJS.ProcessEnv } = {},
): WindowsBatchResolved | null {
  if (platform !== "win32") return null;

  const trimmed = command.trim();
  if (/\.[a-z0-9]+$/i.test(trimmed) && !isWindowsBatchShim(trimmed, platform)) {
    return null;
  }
  let executable = trimmed;
  if (!isWindowsBatchShim(trimmed, platform)) {
    try {
      executable = resolveCommandExecutableSync({
        command: trimmed,
        env: options.env,
        platform,
      });
    } catch {
      if (!isWindowsBatchShim(trimmed, platform)) return null;
    }
  }

  if (!isWindowsBatchShim(executable, platform)) {
    return executable === trimmed
      ? null
      : { command: executable, args: [...args] };
  }

  const target = resolveBatchShimTarget(executable, options.env ?? process.env);
  if (!target) {
    throw new Error(`Unsupported Windows batch shim: ${executable}`);
  }
  return {
    command: target.command,
    args: [...target.prefixArgs, ...args],
    env: target.env,
  };
}

function resolveBatchShimTarget(
  shimPath: string,
  baseEnv: NodeJS.ProcessEnv,
  visited: ReadonlySet<string> = new Set(),
): { command: string; prefixArgs: string[]; env: Record<string, string> } | null {
  const normalizedShimPath = normalize(shimPath).toLowerCase();
  if (visited.has(normalizedShimPath)) return null;
  const nextVisited = new Set(visited).add(normalizedShimPath);
  let content: string;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const shimDir = dirname(shimPath);

  const localEnv = extractBatchShimEnv(content, shimPath, baseEnv);
  const shimEnv = {
    ...baseEnv,
    ...localEnv,
  };
  for (const line of content.split(/\r?\n/)) {
    const forwardedShim = resolveForwardedBatchShimLine(line, shimDir, shimEnv);
    if (forwardedShim) {
      const target = resolveBatchShimTarget(forwardedShim, shimEnv, nextVisited);
      if (target) return { ...target, env: { ...localEnv, ...target.env } };
    }
    const target = resolvePowerShellShimLine(line, shimDir, shimEnv);
    if (target) return { ...target, env: localEnv };
    const direct = resolveDirectShimLine(line, shimDir, shimEnv);
    if (direct) return { ...direct, env: localEnv };
  }
  return null;
}

function resolveForwardedBatchShimLine(
  line: string,
  shimDir: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const match = line
    .trim()
    .match(/^@?call\s+(?:"([^"]+)"|(\S+))\s+%\*\s*$/i);
  if (!match) return null;
  const expanded = expandBatchToken(match[1] ?? match[2] ?? "", shimDir, env);
  if (!expanded) return null;
  const target = normalize(expanded);
  return isWindowsBatchShim(target, "win32") && existsSync(target) ? target : null;
}

function resolveDirectShimLine(
  line: string,
  shimDir: string,
  env: NodeJS.ProcessEnv,
): { command: string; prefixArgs: string[] } | null {
  const passthroughIndex = line.indexOf("%*");
  if (passthroughIndex < 0) return null;
  const prefix = line.slice(0, passthroughIndex).trim();
  if (/^@?if\b/i.test(prefix)) return null;
  const canonicalNpmLine = prefix.match(
    /^@?endlocal\s+&\s+goto\s+\S+\s+2>nul\s+\|\|\s+title\s+%comspec%\s+&\s+(.+)$/i,
  );
  const commandPrefix = (canonicalNpmLine?.[1] ?? prefix)
    .replace(/^@/u, "")
    .trim();
  if (/[&|<>()]/u.test(commandPrefix)) return null;
  const tokens = Array.from(
    commandPrefix.matchAll(/"([^"]*)"|([^\s"]+)/g),
    (match) => (match[1] ?? match[2] ?? "").trim(),
  ).filter(Boolean);
  if (tokens.length === 0) return null;

  const commandToken = tokens[0]!;
  const expandedCommand = expandBatchToken(commandToken, shimDir, env);
  if (!expandedCommand) return null;
  const command = normalize(expandedCommand);
  if (
    new Set(["cmd.exe", "command.com", "powershell.exe", "pwsh.exe"]).has(
      basename(command).toLowerCase(),
    )
  ) {
    return null;
  }
  if (!/\.(?:exe|com)$/i.test(command) || !existsSync(command)) {
    return null;
  }

  const prefixArgs = tokens
    .slice(1)
    .map((token) => expandBatchToken(token, shimDir, env));
  if (prefixArgs.some((token) => token === null)) return null;
  return { command, prefixArgs: prefixArgs as string[] };
}

function resolvePowerShellShimLine(
  line: string,
  shimDir: string,
  env: NodeJS.ProcessEnv,
): { command: string; prefixArgs: string[] } | null {
  const passthroughIndex = line.indexOf("%*");
  if (passthroughIndex < 0) return null;
  const prefix = line.slice(0, passthroughIndex).trim();
  if (!/powershell\.exe/i.test(prefix) || /[&|<>]/u.test(prefix)) return null;
  const tokens = Array.from(prefix.matchAll(/"([^"]*)"|([^\s"]+)/g), (match) =>
    (match[1] ?? match[2] ?? "").trim(),
  ).filter(Boolean);
  if (tokens.length < 3) return null;

  const commandValue = expandBatchToken(
    tokens[0]!.replace(/^@/u, ""),
    shimDir,
    env,
  );
  if (!commandValue) return null;
  const command = normalize(commandValue);
  if (!/powershell\.exe$/i.test(command) || !existsSync(command)) return null;

  const prefixArgs = tokens
    .slice(1)
    .map((token) => expandBatchToken(token, shimDir, env));
  if (prefixArgs.some((token) => token === null)) return null;
  const args = prefixArgs as string[];
  if (
    args.some((arg) =>
      /^-(?:command|encodedcommand|commandwithargs)$/i.test(arg),
    )
  ) {
    return null;
  }
  const fileIndex = args.findIndex((arg) => /^-file$/i.test(arg));
  if (fileIndex < 0 || fileIndex + 1 >= args.length) return null;
  const scriptPath = normalize(args[fileIndex + 1]!);
  if (!/\.ps1$/i.test(scriptPath) || !existsSync(scriptPath)) return null;
  args[fileIndex + 1] = scriptPath;
  return { command, prefixArgs: args };
}

function expandBatchToken(
  token: string,
  shimDir: string,
  env: NodeJS.ProcessEnv,
): string | null {
  let unresolved = false;
  let nodeProgram: string | undefined;
  if (/%_prog%/i.test(token)) {
    const localNode = join(shimDir, "node.exe");
    if (existsSync(localNode)) {
      nodeProgram = localNode;
    } else {
      try {
        nodeProgram = resolveCommandExecutableSync({
          command: "node",
          env,
          platform: "win32",
        });
      } catch {
        return null;
      }
    }
  }
  const expanded = token
    .replace(/%_prog%/gi, nodeProgram ?? "")
    .replace(/%~?dp0%?/gi, `${shimDir}\\`)
    .replace(/%([^%]+)%/g, (_placeholder, envKey: string) => {
      const value = getEnvValue(env, envKey);
      if (value === undefined) unresolved = true;
      return value ?? "";
    });
  return unresolved || /%[^%]+%/u.test(expanded) ? null : expanded;
}

function extractBatchShimEnv(
  content: string,
  shimPath: string,
  baseEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const shimDir = dirname(shimPath);
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:if\s+"%[^"]*"\s*==\s*""\s*)?set\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=\s*"?([^\r\n"]*)"?\s*$/i,
    );
    if (!match) continue;
    const key = match[1]!;
    if (/^(?:dp0|_prog|pathext)$/i.test(key)) continue;
    if (/^\s*if\b/i.test(line) && getEnvValue(baseEnv, key) !== undefined) {
      continue;
    }
    const value = (match[2] ?? "")
      .replace(/%~nx0/gi, basename(shimPath))
      .replace(/%~?dp0%?/gi, `${shimDir}\\`)
      .replace(
        /%([^%]+)%/g,
        (placeholder, envKey: string) =>
          getEnvValue(baseEnv, envKey) ?? placeholder,
      )
      .trim();
    if (value) env[key] = value;
  }
  return env;
}

function getEnvValue(env: NodeJS.ProcessEnv, key: string) {
  const match = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return match ? env[match] : undefined;
}
