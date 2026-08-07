import {
  access,
  copyFile,
  link,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { LocalAgentProviderPlugin } from "../../core/provider-plugin.js";
import type { AgentEvent } from "../../core/events.js";
import type { RawAgentStream } from "../../core/transport.js";
import { normalizeMcpServerConfigs } from "../../core/mcp.js";
import { resolveAgentPermissionSelection } from "../../core/permissions.js";
import { materializeSkillsIntoRoot } from "../../skills/materialize.js";
import { skillPromptLabel } from "../../skills/prompt-injection.js";
import { runJsonlTransport } from "../../transports/jsonl/jsonl-transport.js";
import { createProviderRunWorkspaceManager } from "../run-workspace.js";
import { projectAuthFile, projectSharedLockFile } from "./auth-projection.js";
import { detectCodex } from "./detect.js";
import { buildCodexLaunchPlan } from "./launch-plan.js";
import { parseCodexItem } from "./parser.js";

const CODEX_PROJECT_ROOT_MARKER = ".agent-acp-kit-codex-root";
const DEFAULT_CODEX_PROJECT_ROOT_MARKERS = [CODEX_PROJECT_ROOT_MARKER, ".git"] as const;

function escapeTomlString(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function normalizeCodexModel(model: string | undefined, providerId = "codex") {
  if (providerId === "codex" && model === "codex:gpt-5") return "gpt-5.4";
  if (providerId === "codex" && model === "codex:gpt-5-mini") {
    return "gpt-5.4-mini";
  }
  const prefix = `${providerId}:`;
  if (model?.startsWith(prefix)) return model.slice(prefix.length);
  return model;
}

async function* parseCodexRawEvents(stream: RawAgentStream): AsyncGenerator<AgentEvent> {
  let sessionId: string | undefined;
  for await (const item of stream) {
    const record =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : undefined;
    if (record?.type === "thread.started" || record?.type === "session_meta") {
      const thread =
        record.thread && typeof record.thread === "object" && !Array.isArray(record.thread)
          ? (record.thread as Record<string, unknown>)
          : undefined;
      const payload =
        record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
          ? (record.payload as Record<string, unknown>)
          : undefined;
      const candidate =
        record.threadId ??
        record.thread_id ??
        record.sessionId ??
        record.session_id ??
        thread?.id ??
        payload?.id;
      if (typeof candidate === "string" && candidate.trim()) {
        sessionId = candidate;
      }
    }
    if (item && typeof item === "object" && "type" in item) {
      const candidate = item as AgentEvent;
      if (candidate.type === "done" && sessionId && !candidate.sessionId) {
        yield { ...candidate, sessionId };
        continue;
      }
      if (
        candidate.type === "done" ||
        candidate.type === "status" ||
        candidate.type === "text_delta" ||
        candidate.type === "thinking_delta" ||
        candidate.type === "tool_call" ||
        candidate.type === "tool_result"
      ) {
        yield candidate;
        continue;
      }
      if (
        candidate.type === "error" &&
        typeof candidate.code === "string" &&
        typeof candidate.message === "string"
      ) {
        yield candidate;
        continue;
      }
    }
    yield* parseCodexItem(item as Parameters<typeof parseCodexItem>[0]);
  }
}

function buildCodexPrompt(input: {
  prompt: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  skills: Array<{ slug: string; deliveryMode: string; materializedPath?: string; content?: string }>;
  systemPrompt?: string;
  runtimeName?: string;
}) {
  const materializedSkills = input.skills.filter(
    (skill) => skill.deliveryMode === "materialized-files" && skill.materializedPath,
  );
  const injectedSkills = input.skills.filter(
    (skill) =>
      skill.deliveryMode === "prompt-injection" ||
      skill.deliveryMode === "project-instructions",
  );
  const historyTranscript = (input.history ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.content}`)
    .join("\n\n");

  const materializedSkillSection =
    materializedSkills.length > 0
      ? `Selected skills are materialized under the current provider run home. Read the referenced SKILL.md before following a skill.\n${materializedSkills
          .map((skill) => `- ${skillPromptLabel(skill.slug)}: ${skill.materializedPath}/SKILL.md`)
          .join("\n")}`
      : "";
  const injectedSkillSection =
    injectedSkills.length > 0
      ? `Injected skills:\n${injectedSkills
          .map((skill) => {
            const base = `- ${skill.slug}`;
            if (skill.content?.trim()) {
              return `${base}\n${skill.content.trim()}`;
            }
            return base;
          })
          .join("\n")}`
      : "";
  const historySection = historyTranscript
    ? `Conversation history:\n${historyTranscript}`
    : "";

  return [
    input.systemPrompt?.trim(),
    `You are a local ${input.runtimeName ?? "Codex"} runtime.`,
    "Prefer available MCP tools instead of faking external side effects.",
    "Do not claim a tool action happened unless the tool actually succeeded.",
    materializedSkillSection,
    injectedSkillSection,
    historySection,
    "Current request:",
    input.prompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function ensureParentDirectory(path: string) {
  await mkdir(dirname(path), { recursive: true });
}

async function copyOptionalFile(source: string, target: string) {
  try {
    await ensureParentDirectory(target);
    await copyFile(source, target);
    return true;
  } catch {
    return false;
  }
}

async function linkDirectory(source: string, target: string) {
  await mkdir(source, { recursive: true });
  await ensureParentDirectory(target);
  await rm(target, { recursive: true, force: true });
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
}

async function linkFile(source: string, target: string) {
  await ensureParentDirectory(target);
  await rm(target, { force: true });
  try {
    await symlink(source, target);
    return;
  } catch {
    // Windows often disallows file symlinks without Developer Mode/admin.
    // A hard link still lets token refresh writes update the shared auth file.
    await link(source, target);
  }
}

// Codex loads its remote model catalog before it can start a turn. Run homes
// are intentionally transient, so a private models_cache.json here would make
// every ACP run cold-start model discovery. Keep this one writable metadata
// file shared with the stable provider Home while leaving run-specific config,
// MCP, skills and temporary files isolated.
async function linkWritableModelsCache(source: string, target: string) {
  try {
    await access(source);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
    try {
      await writeFile(source, "", { encoding: "utf8", flag: "wx" });
    } catch (createError) {
      if (!isNodeErrorWithCode(createError, "EEXIST")) throw createError;
    }
  }
  await linkFile(source, target);
}

function buildMcpConfigBlock(servers: ReturnType<typeof normalizeMcpServerConfigs>) {
  const lines: string[] = [];

  for (const server of servers) {
    lines.push("", `[mcp_servers.${server.name}]`);
    if (server.type === "http") {
      lines.push('type = "http"');
      lines.push(`url = "${escapeTomlString(server.url)}"`);
      if (server.headers && Object.keys(server.headers).length > 0) {
        lines.push("", `[mcp_servers.${server.name}.headers]`);
        for (const [key, value] of Object.entries(server.headers)) {
          lines.push(`${key} = "${escapeTomlString(value)}"`);
        }
      }
    } else {
      lines.push('type = "stdio"');
      lines.push(`command = "${escapeTomlString(server.command)}"`);
      if (server.args && server.args.length > 0) {
        lines.push(
          `args = [${server.args.map((arg) => `"${escapeTomlString(arg)}"`).join(", ")}]`,
        );
      }
    }
    if (server.startupTimeoutMs) {
      lines.push(
        `startup_timeout_sec = ${Math.ceil(server.startupTimeoutMs / 1000)}`,
      );
    }
    if (server.toolTimeoutMs) {
      lines.push(`tool_timeout_sec = ${Math.ceil(server.toolTimeoutMs / 1000)}`);
    }
    lines.push(
      `default_tools_approval_mode = "${server.defaultToolsApprovalMode}"`,
    );

    if (server.env.length > 0) {
      lines.push("", `[mcp_servers.${server.name}.env]`);
      for (const entry of server.env) {
        lines.push(`${entry.key} = "${escapeTomlString(entry.value)}"`);
      }
    }
  }

  return lines.join("\n");
}

function collectMcpRedactionSecrets(
  servers: ReturnType<typeof normalizeMcpServerConfigs>,
) {
  const secrets: string[] = [];
  for (const server of servers) {
    for (const entry of server.env) {
      secrets.push(entry.value);
    }
    if (server.type === "http" && server.headers) {
      secrets.push(...Object.values(server.headers));
    }
  }
  return secrets.filter((secret) => secret.length > 0);
}

async function readOptionalFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function getTomlTableName(line: string) {
  const match = line.trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
  return match?.[1]?.trim();
}

function isTomlTableHeader(line: string) {
  return Boolean(getTomlTableName(line));
}

function isRootTomlKey(line: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escapedKey}\\s*=`).test(line);
}

function isUnsupportedCodexServiceTierLine(line: string) {
  if (!isRootTomlKey(line, "service_tier")) return false;
  const match = line.match(/^\s*service_tier\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))/);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value !== "fast" && value !== "flex";
}

function isMcpServerTable(tableName: string | undefined, serverNames: Set<string>) {
  if (!tableName) return false;
  for (const serverName of serverNames) {
    const prefix = `mcp_servers.${serverName}`;
    if (tableName === prefix || tableName.startsWith(`${prefix}.`)) {
      return true;
    }
  }
  return false;
}

function mergeCodexConfigToml(params: {
  sourceConfig?: string;
  model?: string;
  mcpServers: ReturnType<typeof normalizeMcpServerConfigs>;
}) {
  const mcpConfigBlock = buildMcpConfigBlock(params.mcpServers).trim();
  if (!params.sourceConfig) {
    const lines = [
      params.model && params.model !== "default"
        ? `model = "${escapeTomlString(params.model)}"`
        : undefined,
      mcpConfigBlock,
    ].filter(Boolean);
    return `${lines.join("\n\n")}\n`;
  }

  const serverNames = new Set(params.mcpServers.map((server) => server.name));
  const sourceLines = params.sourceConfig.split(/\r?\n/);
  const rootLines: string[] = [];
  const tableBlocks: string[][] = [];
  let currentTable: string[] | undefined;

  for (const line of sourceLines) {
    if (isTomlTableHeader(line)) {
      currentTable = [line];
      tableBlocks.push(currentTable);
      continue;
    }

    if (currentTable) {
      currentTable.push(line);
    } else {
      rootLines.push(line);
    }
  }

  const mergedRootLines = rootLines.filter((line) => {
    if (params.model && params.model !== "default" && isRootTomlKey(line, "model")) {
      return false;
    }
    return !isUnsupportedCodexServiceTierLine(line);
  });
  while (mergedRootLines.length > 0 && !mergedRootLines[mergedRootLines.length - 1]?.trim()) {
    mergedRootLines.pop();
  }
  if (params.model && params.model !== "default") {
    mergedRootLines.push(`model = "${escapeTomlString(params.model)}"`);
  }

  const mergedTableBlocks = tableBlocks.filter((block) => {
    const tableName = getTomlTableName(block[0] ?? "");
    return !isMcpServerTable(tableName, serverNames);
  });

  const sections = [
    mergedRootLines.join("\n").trim(),
    ...mergedTableBlocks.map((block) => block.join("\n").trim()).filter(Boolean),
    mcpConfigBlock,
  ].filter(Boolean);

  return `${sections.join("\n\n")}\n`;
}

function stripSkillsConfigEntries(content: string) {
  if (!content.includes("[[skills.config]]")) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let inSkillsConfig = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      if (trimmed === "[[skills.config]]") {
        inSkillsConfig = true;
        continue;
      }
      inSkillsConfig = false;
      out.push(line);
      continue;
    }
    if (!inSkillsConfig) {
      out.push(line);
    }
  }

  const stripped = `${out.join("\n").trimEnd()}\n`;
  return stripped.trim() ? stripped : "";
}

const rootFeaturesTableHeaderRe = /^\s*\[\s*features\s*\]\s*(?:#.*)?$/;
const rootDottedMultiAgentRe = /^\s*features\s*\.\s*multi_agent\s*=/;
const featuresTableMultiAgentRe = /^\s*multi_agent\s*=/;
const rootProjectRootMarkersRe = /^\s*project_root_markers\s*=/;
const rootDottedCodexHooksRe = /^(\s*features\s*\.\s*)codex_hooks(\s*=.*)$/;
const rootDottedHooksRe = /^\s*features\s*\.\s*hooks\s*=/;
const featuresTableCodexHooksRe = /^(\s*)codex_hooks(\s*=.*)$/;
const featuresTableHooksRe = /^\s*hooks\s*=/;

function hasFeaturesTableHookDirective(lines: string[]) {
  let currentTable = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (rootFeaturesTableHeaderRe.test(line)) {
      currentTable = "[features]";
      continue;
    }
    if (trimmed.startsWith("[")) {
      currentTable = trimmed;
      continue;
    }
    if (currentTable === "[features]" && featuresTableHooksRe.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function migrateDeprecatedCodexHooksFeature(content: string) {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let currentTable = "";
  let hasRootHooks = lines.some((line) => rootDottedHooksRe.test(line.trim()));
  let hasFeaturesTableHooks = hasFeaturesTableHookDirective(lines);

  for (const line of lines) {
    const trimmed = line.trim();
    if (rootFeaturesTableHeaderRe.test(line)) {
      currentTable = "[features]";
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("[")) {
      currentTable = trimmed;
      out.push(line);
      continue;
    }

    if (currentTable === "") {
      const rootDottedMatch = line.match(rootDottedCodexHooksRe);
      if (rootDottedMatch) {
        if (!hasRootHooks) {
          out.push(`${rootDottedMatch[1]}hooks${rootDottedMatch[2]}`);
          hasRootHooks = true;
        }
        continue;
      }
    }

    if (currentTable === "[features]") {
      if (featuresTableHooksRe.test(trimmed)) {
        hasFeaturesTableHooks = true;
        out.push(line);
        continue;
      }

      const featuresTableMatch = line.match(featuresTableCodexHooksRe);
      if (featuresTableMatch) {
        if (!hasFeaturesTableHooks) {
          out.push(`${featuresTableMatch[1]}hooks${featuresTableMatch[2]}`);
          hasFeaturesTableHooks = true;
        }
        continue;
      }
    }

    out.push(line);
  }

  return out.join("\n");
}

function readTomlStringArray(line: string) {
  const array = line.match(/\[(.*)\]/)?.[1];
  if (!array) return [];
  const values: string[] = [];
  const stringRe = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let match: RegExpExecArray | null;
  while ((match = stringRe.exec(array))) {
    const value = match[1] ?? match[2];
    if (value) values.push(value);
  }
  return values;
}

function formatTomlStringArray(values: string[]) {
  return `[${values.map((value) => `"${escapeTomlString(value)}"`).join(", ")}]`;
}

function mergeCodexProjectRootMarkers(values: string[]) {
  const next: string[] = [];
  for (const marker of [
    CODEX_PROJECT_ROOT_MARKER,
    ...values,
    ...DEFAULT_CODEX_PROJECT_ROOT_MARKERS,
  ]) {
    if (!next.includes(marker)) next.push(marker);
  }
  return next;
}

function resolveCodexProjectRootMarkers(
  values: string[],
  writeMarkerFile: boolean,
): string[] {
  if (!writeMarkerFile) return [];
  return mergeCodexProjectRootMarkers(values);
}

function ensureCodexProjectRootMarkers(content: string, writeMarkerFile = true) {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let inserted = false;
  let currentTable = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      if (!inserted) {
        out.push(
          `project_root_markers = ${formatTomlStringArray(
            resolveCodexProjectRootMarkers([], writeMarkerFile),
          )}`,
          "",
        );
        inserted = true;
      }
      currentTable = trimmed;
      out.push(line);
      continue;
    }

    if (currentTable === "" && rootProjectRootMarkersRe.test(line)) {
      out.push(
        `project_root_markers = ${formatTomlStringArray(
          resolveCodexProjectRootMarkers(readTomlStringArray(line), writeMarkerFile),
        )}`,
      );
      inserted = true;
      continue;
    }

    out.push(line);
  }

  if (!inserted) {
    out.unshift(
      `project_root_markers = ${formatTomlStringArray(
        resolveCodexProjectRootMarkers([], writeMarkerFile),
      )}`,
      "",
    );
  }

  return out.join("\n");
}

function stripMultiAgentDirectives(content: string) {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let currentTable = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (rootFeaturesTableHeaderRe.test(line)) {
      currentTable = "[features]";
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("[")) {
      currentTable = trimmed;
      out.push(line);
      continue;
    }
    if (currentTable === "" && rootDottedMultiAgentRe.test(trimmed)) {
      continue;
    }
    if (currentTable === "[features]" && featuresTableMultiAgentRe.test(trimmed)) {
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}

function ensureCodexMultiAgentDisabled(content: string) {
  const stripped = stripMultiAgentDirectives(migrateDeprecatedCodexHooksFeature(content));
  const lines = stripped.split(/\r?\n/);
  const featuresIndex = lines.findIndex((line) => rootFeaturesTableHeaderRe.test(line));
  if (featuresIndex >= 0) {
    const next = [...lines];
    next.splice(featuresIndex + 1, 0, "multi_agent = false");
    return next.join("\n");
  }

  const trimmed = stripped.trimStart();
  const block = "features.multi_agent = false\n";
  return trimmed ? `${block}\n${trimmed}` : block;
}

function isNodeErrorWithCode(error: unknown, code: string) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code,
  );
}

async function ensureCodexProjectRootMarker(cwd: string) {
  const markerPath = join(cwd, CODEX_PROJECT_ROOT_MARKER);
  await mkdir(cwd, { recursive: true });
  try {
    await writeFile(markerPath, "", { encoding: "utf8", flag: "wx" });
    return;
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) {
      return;
    }
    throw error;
  }
}

async function materializeCodexHome(params: {
  defaultHomeDirName: string;
  displayName: string;
  homeEnvKey: string;
  mcpServers?: Parameters<typeof normalizeMcpServerConfigs>[0];
  env?: Record<string, string>;
  model?: string;
  onCleanup(callback: () => Promise<void>): void;
  providerId: string;
  runHome: string;
  runId: string;
  sharedRefreshLock?: boolean;
  writeProjectRootMarker?: boolean;
}) {
  const normalizedServers = normalizeMcpServerConfigs(params.mcpServers ?? []);
  const sourceHome =
    params.env?.[params.homeEnvKey] ??
    process.env[params.homeEnvKey] ??
    join(homedir(), params.defaultHomeDirName);
  const runHome = params.runHome;
  const sourceAuthPath = join(sourceHome, "auth.json");
  try {
    await access(sourceAuthPath);
  } catch {
    throw new Error(
      `${params.displayName} auth is unavailable for local-agent runs. Expected auth.json under ${sourceHome}.`,
    );
  }
  await projectAuthFile({
    ...(params.env ? { env: params.env } : {}),
    onCleanup: params.onCleanup,
    providerId: params.providerId,
    runAuthPath: join(runHome, "auth.json"),
    runId: params.runId,
    sourceAuthPath,
  });
  if (params.sharedRefreshLock) {
    await projectSharedLockFile(sourceHome, runHome);
  }

  await linkWritableModelsCache(
    join(sourceHome, "models_cache.json"),
    join(runHome, "models_cache.json"),
  );

  await linkDirectory(join(sourceHome, "sessions"), join(runHome, "sessions"));
  try {
    await linkDirectory(join(sourceHome, "plugins", "cache"), join(runHome, "plugins", "cache"));
  } catch {
    // Plugin cache is an optimization for bundled/plugin-backed assets.
    // Codex can still run without it, so keep this best-effort like Multica.
  }
  await copyOptionalFile(join(sourceHome, "config.json"), join(runHome, "config.json"));
  await copyOptionalFile(join(sourceHome, "instructions.md"), join(runHome, "instructions.md"));

  const sourceConfig = stripSkillsConfigEntries(
    (await readOptionalFile(join(sourceHome, "config.toml"))) ?? "",
  );
  const mergedConfig = mergeCodexConfigToml({
    ...(sourceConfig ? { sourceConfig } : {}),
    ...(params.model ? { model: params.model } : {}),
    mcpServers: normalizedServers,
  });
  const writeProjectRootMarker = params.writeProjectRootMarker !== false;
  await writeFile(
    join(runHome, "config.toml"),
    ensureCodexProjectRootMarkers(
      ensureCodexMultiAgentDisabled(mergedConfig),
      writeProjectRootMarker,
    ),
    "utf8",
  );

  return runHome;
}

type CodexCompatibleProviderOptions<TProvider extends string> = {
  command: string;
  defaultHomeDirName: string;
  displayName: string;
  homeEnvKey: string;
  providerId: TProvider;
  requiresKnownAuth: boolean;
  runtimeName: string;
  sharedRefreshLock?: boolean;
};

function createCodexCompatibleProvider<TProvider extends string>(
  options: CodexCompatibleProviderOptions<TProvider>,
): LocalAgentProviderPlugin<"local-agent", TProvider> {
  const runWorkspaces = createProviderRunWorkspaceManager(options.providerId, {
    rootKind: "home",
  });

  async function prepareLaunchPlan(
    params: Parameters<LocalAgentProviderPlugin<"local-agent", TProvider>["buildLaunchPlan"]>[0],
  ) {
    params = {
      ...params,
      permission: resolveAgentPermissionSelection(params.permission),
    };
    return runWorkspaces.prepare(params.runId, params.env, async (workspace) => {
      const codexEnv = params.env;
      const normalizedModel = normalizeCodexModel(params.model, options.providerId);
      const redactionSecrets = collectMcpRedactionSecrets(
        normalizeMcpServerConfigs(params.mcpServers ?? []),
      );
      const codexHome = await workspace.getRoot();
      const providerTemp = join(codexHome, "tmp");
      await mkdir(providerTemp, { recursive: true });
      const writeProjectRootMarker = params.writeCodexProjectRootMarker !== false;
      const homePromise = materializeCodexHome({
        defaultHomeDirName: options.defaultHomeDirName,
        displayName: options.displayName,
        homeEnvKey: options.homeEnvKey,
        ...(codexEnv ? { env: codexEnv } : {}),
        ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
        ...(normalizedModel ? { model: normalizedModel } : {}),
        onCleanup: (callback) => workspace.onCleanup(callback),
        providerId: options.providerId,
        runHome: codexHome,
        runId: params.runId,
        ...(options.sharedRefreshLock ? { sharedRefreshLock: true } : {}),
        writeProjectRootMarker,
      });
      const skillsPromise = materializeSkillsIntoRoot(
        join(codexHome, "skills"),
        params.skillManifest ?? [],
      );
      const [homeResult, skillsResult] = await Promise.allSettled([
        homePromise,
        skillsPromise,
      ]);
      if (homeResult.status === "rejected") throw homeResult.reason;
      if (skillsResult.status === "rejected") throw skillsResult.reason;
      const materialized = skillsResult.value;
      if (writeProjectRootMarker) {
        await ensureCodexProjectRootMarker(params.cwd);
      }
      const prompt = buildCodexPrompt({
        prompt: params.prompt,
        ...(params.history ? { history: params.history } : {}),
        skills: materialized,
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        runtimeName: options.runtimeName,
      });

      const { env: _env, ...paramsWithoutEnv } = params;
      const plan = buildCodexLaunchPlan(
        {
          ...paramsWithoutEnv,
          ...(codexEnv ? { env: codexEnv } : {}),
          env: {
            ...(codexEnv ?? {}),
            [options.homeEnvKey]: codexHome,
            TMPDIR: providerTemp,
            TEMP: providerTemp,
            TMP: providerTemp,
          },
          ...(normalizedModel ? { model: normalizedModel } : {}),
          prompt,
        },
        params.executablePath ?? options.command,
      );
      if (redactionSecrets.length === 0) return plan;
      return {
        ...plan,
        redactionSecrets: Array.from(
          new Set([...(plan.redactionSecrets ?? []), ...redactionSecrets]),
        ),
      };
    });
  }

  const plugin: LocalAgentProviderPlugin<"local-agent", TProvider> = {
    id: options.providerId,
    displayName: options.displayName,
    requiresKnownAuth: options.requiresKnownAuth,
    kind: "local-agent",
    async detect(context) {
      return detectCodex({
        command: options.command,
        defaultHomeDirName: options.defaultHomeDirName,
        ...(context?.cwd ? { cwd: context.cwd } : {}),
        ...(context?.env ? { env: context.env } : {}),
        homeEnvKey: options.homeEnvKey,
        probeAuthStatus: options.requiresKnownAuth,
      });
    },
    capabilities() {
      return {
        cancel: true,
        nativeResume: true,
        streaming: true,
        toolGateway: true,
        maxConcurrentRuns: Number.MAX_SAFE_INTEGER,
      };
    },
    async buildLaunchPlan(params) {
      return {
        ...(await prepareLaunchPlan(params)),
        ...(params.model ? { model: params.model } : {}),
        runId: params.runId,
        transport: "jsonl",
      };
    },
    createAdapter() {
      let adapterRunId: string | undefined;
      return {
        buildLaunchPlan: async (params) => {
          if (adapterRunId) {
            throw new Error("Codex-compatible runtime adapters can prepare only one run.");
          }
          adapterRunId = params.runId;
          try {
            return {
              ...(await prepareLaunchPlan(params)),
              runId: params.runId,
              transport: "jsonl",
            };
          } catch (error) {
            adapterRunId = undefined;
            throw error;
          }
        },
        capabilities: () => plugin.capabilities(),
        parseEvents: async function* (stream) {
          yield* cleanupBeforeTerminal(parseCodexRawEvents(stream), async () => {
            if (adapterRunId) await runWorkspaces.cleanup(adapterRunId);
          });
        },
      };
    },
    async *run(params) {
      const plan = {
        ...(await prepareLaunchPlan(params)),
        runId: params.runId,
        transport: "jsonl" as const,
      };
      yield* cleanupBeforeTerminal(
        runJsonlTransport(plan, parseCodexItem, params.signal),
        () => runWorkspaces.cleanup(params.runId),
      );
    },
  };

  return plugin;
}

export function createCodexProvider() {
  return createCodexCompatibleProvider({
    command: "codex",
    defaultHomeDirName: ".codex",
    displayName: "Codex CLI",
    homeEnvKey: "CODEX_HOME",
    providerId: "codex",
    requiresKnownAuth: false,
    runtimeName: "Codex",
  });
}

export function createTuttiAgentProvider() {
  return createCodexCompatibleProvider({
    command: "tutti-agent",
    defaultHomeDirName: ".tutti-agent",
    displayName: "Tutti Agent",
    homeEnvKey: "TUTTI_AGENT_HOME",
    providerId: "tutti-agent",
    requiresKnownAuth: true,
    runtimeName: "Tutti Agent",
    sharedRefreshLock: true,
  });
}

async function* cleanupBeforeTerminal(
  events: AsyncIterable<AgentEvent>,
  cleanup: () => Promise<void>,
): AsyncGenerator<AgentEvent> {
  let terminal: Extract<AgentEvent, { type: "done" }> | undefined;
  let completed = false;
  try {
    for await (const event of events) {
      if (event.type === "done") terminal = event;
      else yield event;
    }
    completed = true;
  } finally {
    await cleanup();
  }
  if (completed && terminal) yield terminal;
}

export const codexProvider = createCodexProvider();
export const tuttiAgentProvider = createTuttiAgentProvider();
