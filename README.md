# @tutti-os/agent-acp-kit

<p align="center">
  <strong>A TypeScript toolkit for running local coding agents through one ACP-oriented host API.</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue" /></a>
  <a href="https://www.npmjs.com/package/@tutti-os/agent-acp-kit"><img src="https://img.shields.io/npm/v/@tutti-os/agent-acp-kit.svg" alt="npm version"></a>
  <a href="https://github.com/tutti-os/agent-acp-kit/actions/workflows/npm-package-release.yml"><img src="https://github.com/tutti-os/agent-acp-kit/actions/workflows/npm-package-release.yml/badge.svg" alt="release workflow"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node.js >= 22">
  <img src="https://img.shields.io/badge/TypeScript-ready-3178c6" alt="TypeScript ready">
  <img src="https://img.shields.io/badge/ACP-oriented-111827" alt="ACP oriented">
</p>

<p align="center">
  <img src="./assets/agent-acp-kit-architecture.png" alt="Architecture diagram for @tutti-os/agent-acp-kit">
</p>

`@tutti-os/agent-acp-kit` lets a host application detect, launch, stream, cancel, and resume local coding agents through a stable TypeScript facade.

It is built for apps that want to support Codex, Claude Code, and ACP-compatible agents such as Gemini CLI, Cursor Agent, GitHub Copilot CLI, Factory Droid, fast-agent, OpenCode, Qwen Code, Kimi CLI, Kilo, Mistral Vibe, and Trae CLI without scattering provider-specific process, transport, MCP, skill, model, and event parsing logic throughout the app.

This is an embeddable host SDK. It is not a replacement for ACP clients such as [`acpx`](https://github.com/openclaw/acpx), and it is not a single-provider ACP adapter binary such as `codex-acp`.

## Why This Exists

Local coding agents do not all expose the same interface:

- Codex is CLI-first and can stream JSONL from `codex exec --json`.
- Claude Code is CLI-first and streams `stream-json` output.
- ACP-compatible agents speak JSON-RPC session protocols and can be discovered through the ACP Registry.
- Host apps still need their own messages, sessions, tool permissions, replay, canvas state, billing, and product semantics.

This package sits in the middle. It owns local agent execution. Your application owns product behavior.

## ACP-compatible Agents

ACP-compatible agents in the wider ecosystem include:

| Agent              | Typical ACP command                |
| ------------------ | ---------------------------------- |
| Gemini CLI         | `gemini --acp`                     |
| Cursor Agent       | `cursor-agent acp`                 |
| GitHub Copilot CLI | `copilot --acp --stdio`            |
| Factory Droid      | `droid exec --output-format acp`   |
| fast-agent         | `uvx fast-agent-mcp acp`           |
| OpenCode           | `opencode acp`                     |
| Qwen Code          | `qwen --acp --experimental-skills` |
| Kimi CLI           | `kimi acp`                         |
| Kilo               | `kilo acp`                         |
| Mistral Vibe       | `vibe-acp`                         |
| Trae CLI           | `traecli acp serve`                |

This table is for ecosystem orientation. Commands can vary by agent version, so use the registry as the source of truth. Built-in provider support in this package is listed below, and hosts can use `createGenericAcpProvider()` or a custom provider plugin when they already have an ACP command to launch.

For the latest installable agent list, see:

- [ACP Registry guide](https://agentclientprotocol.com/get-started/registry)
- [agentclientprotocol/registry](https://github.com/agentclientprotocol/registry)
- [latest registry JSON](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)

## Install

```bash
npm install @tutti-os/agent-acp-kit
```

Other package managers work too:

```bash
pnpm add @tutti-os/agent-acp-kit
yarn add @tutti-os/agent-acp-kit
bun add @tutti-os/agent-acp-kit
```

Requirements:

- Node.js 22 or newer.
- ESM runtime.
- Installed provider CLIs for the providers you want to use.

## Local Quick Start

For a regular local host, the application owns the workspace directory and
passes that path directly as `cwd`.

```ts
import {
  createClaudeProvider,
  createCodexProvider,
  createLocalAgentRuntime,
} from "@tutti-os/agent-acp-kit";

const runtime = createLocalAgentRuntime({
  providers: [createCodexProvider(), createClaudeProvider()],
});

const detections = await runtime.detect();
console.log(
  detections.map((item) => ({
    provider: item.provider,
    supported: item.supported,
    authState: item.authState,
    models: item.models,
    reason: item.reason,
  })),
);

for await (const event of runtime.run({
  runId: crypto.randomUUID(),
  provider: "codex",
  cwd: "/path/to/workspace",
  prompt: "Inspect this project and summarize the architecture.",
  model: "codex:gpt-5.4",
})) {
  if (event.type === "text_delta") {
    process.stdout.write(event.text);
  }

  if (event.type === "tool_call") {
    console.log("tool started", event.name, event.input);
  }

  if (event.type === "done") {
    console.log("run finished", event.status);
  }
}
```

## What You Get

| Area              | Included                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Runtime facade    | `detect()`, `run()`, `cancel()`, `listProviders()`                                                                      |
| Providers         | Codex, Claude Code, ACP presets, generic ACP, fake test provider                                                        |
| Process runtime   | command resolution, stdin prompt delivery, timeout, cancel, stderr tail, redaction                                      |
| Transports        | JSONL, plain stdout, ACP JSON-RPC                                                                                       |
| MCP delivery      | normalized stdio/http MCP server config passed into provider launch plans                                               |
| Skills            | materialized files, prompt injection, project-instruction style delivery, cleanup                                       |
| Events            | normalized `AgentEvent` discriminated union                                                                             |
| Testing           | fake provider, fake ACP peer, fixtures, conformance helpers                                                             |
| Tutti integration | auto CLI-backed/standalone agent catalog, target-scoped composer options, dynamic skill context, browser-safe contracts |

## Tutti Workspace Apps

Tutti apps keep platform integration behind `@tutti-os/agent-acp-kit/tutti` and keep actual Agent execution in an app-owned local runtime:

```ts
import { createDefaultLocalAgentRuntime } from "@tutti-os/agent-acp-kit";
import { loadTuttiAgentSkillContext } from "@tutti-os/agent-acp-kit/tutti";

const runtime = createDefaultLocalAgentRuntime();
const projectCwd = await resolveAppLocalProjectCwd(projectId);
const detectContext = { cwd: projectCwd };
const agents = await runtime.detect(detectContext);
const agent =
  agents.find((item) => item.isDefault && item.supported) ??
  agents.find((item) => item.supported);
if (!agent) {
  throw new Error("No local Agent is currently available.");
}
if (!agent.agentTargetId)
  throw new Error("Selected Agent has no target identity.");
const skills = await loadTuttiAgentSkillContext({
  agentTargetId: agent.agentTargetId,
  agentSessionId: runId,
  cwd: projectCwd,
  detectContext,
});
for await (const event of runtime.run({
  agentTargetId: agent.agentTargetId,
  runId,
  provider: agent.provider,
  cwd: projectCwd,
  prompt,
  skillManifest: skills.skillManifest,
})) {
  // Persist or stream normalized Agent events in the App.
}
```

The host owns both `cwd` and environment policy. Pass the app-local run or
project directory explicitly; the kit does not derive a business workspace
root from `TUTTI_WORKSPACE_ROOT` or another host path alias. When `env` is
omitted, runtime detection and execution inherit the host process environment.
When `env` is present, its values overlay that ambient environment. The kit
does not apply an application-specific allowlist or remove arbitrary host
variables; it only performs provider/runtime operational normalization such as
removing a nested Claude session marker and extending `PATH`. A host that must
exclude product secrets is responsible for constructing an appropriate process
environment before invoking the runtime.

There is no app-facing mode switch. `runtime.detect()` is the single discovery
API. When `TUTTI_CLI` is configured it uses `agent list` plus target-scoped
composer JSON and preserves every exact Agent Target, including multiple
targets backed by one runtime provider. Shared peer targets whose
`agentTargetId` starts with `shared-agent:` are omitted; this kit only drives
local Provider processes. Without `TUTTI_CLI` it performs direct
Provider plugin detection. `runtime.run()` accepts the selected
`agentTargetId` and applies its latest target-scoped model and reasoning
defaults internally before launching the app-owned local Provider process. When
the Tutti catalog provides an exact `executablePath`, the integration carries it
through `AgentRunInput` to the selected Provider launch plan. This avoids asking
an app process to rediscover a configured Agent CLI from its inherited `PATH`;
catalog entries without that field and standalone hosts continue to use provider-native discovery.
On Windows, process launch resolves native executables, npm/node shims,
PowerShell `-File` shims, and strict argument-forwarding wrappers generated by
Tutti-managed runtimes without routing Agent arguments through `cmd.exe`;
unknown or compound batch programs fail closed.
Node hosts that intentionally execute an Agent CLI outside the normal runtime
may use `resolveProcessInvocation` from the specialized
`@tutti-os/agent-acp-kit/process-adapter` export. Windows batch parsing remains
private to that adapter and is not exported from the package root.
Composer permission defaults are UI presentation state and do not override an
autonomous Workspace App run. Permission comes only from an explicit
`AgentRunInput.permission` selection or the SDK autonomous default described
below.

`loadTuttiAgentCatalog()` and `loadTuttiAgentComposerOptions()` remain available
as low-level compatibility APIs, but Workspace Apps should not compose them
themselves.

Configured Tutti CLI integrations require the exact-target daemon contract.
Catalog, composer, and skill commands use `agentTargetId`/`--agent-id`; the SDK
does not retry with the legacy `agent providers` or `--provider` protocol.
Deprecated provider-only SDK inputs are resolved through the current agent
catalog and are accepted only when exactly one target matches.

Apps that wrap a Provider plugin can preserve that customization:

```ts
const runtime = createDefaultLocalAgentRuntime({
  providers: customProviderPlugins,
});
```

Hosts can pass the same `detectContext` object to runtime detection and skill
helpers. App-owned Tutti children use `projectTuttiCliChildProcess` at their
child boundary and pass returned output through
`redactTuttiCliChildProcessText` before logging or returning errors.

Apps do not construct daemon URLs or CLI argv, read catalog tokens, pass app IDs,
or derive agent IDs from provider names. They persist and round-trip the exact
`agentTargetId` returned by the live catalog. Provider IDs are open runtime
metadata rather than the public selection identity. Claude Code runtime metadata
is canonicalized to `claude-code`; legacy `claude` remains input-only.

Frontend code can import DTO types and guards without Node dependencies:

```ts
import {
  isTuttiAgentCatalog,
  type TuttiAgentCatalog,
} from "@tutti-os/agent-acp-kit/tutti/contracts";
```

## Provider Support

| Provider                    | Status       | Transport                               | Notes                                                                                                                                                                                             |
| --------------------------- | ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                       | Supported    | `codex exec --json` JSONL               | Dynamic model discovery via `codex debug models`; per-run `CODEX_HOME` with durable auth projection and sanitized config; same-provider resume via `codex exec resume --json <session> -`          |
| Claude Code (`claude-code`) | Supported    | `claude -p --output-format stream-json` | Canonical provider ID is `claude-code`; legacy `claude` input is accepted internally; supports fallback model hints, custom model pass-through, and same-provider resume via `--resume <session>` |
| Tutti Agent (`tutti-agent`) | Supported    | `tutti-agent exec --json` JSONL         | First-party canonical provider; runs use a temporary `TUTTI_AGENT_HOME` derived from the VM-local source Home; authentication is probed with `tutti-agent login status`; no Nexight runtime alias |
| Devin for Terminal          | Experimental | ACP JSON-RPC                            | Shared generic ACP transport; command override `DEVIN_ACP_BIN`                                                                                                                                    |
| Hermes (`hermes`)           | Experimental | ACP JSON-RPC                            | Registered by the default runtime; Tutti provider ID `acp:hermes` is accepted as an input alias; command override `HERMES_ACP_BIN`                                                                 |
| Kimi (`kimi`)               | Experimental | ACP JSON-RPC                            | Registered by the default runtime; Tutti provider IDs `kimi-code` and `acp:kimi-code` are accepted as input aliases; command override `KIMI_ACP_BIN`                                               |
| Kiro                        | Experimental | ACP JSON-RPC                            | Shared generic ACP transport; command override `KIRO_ACP_BIN`                                                                                                                                     |
| Kilo                        | Experimental | ACP JSON-RPC                            | Shared generic ACP transport; command override `KILO_ACP_BIN`                                                                                                                                     |
| Mistral Vibe                | Experimental | ACP JSON-RPC                            | Shared generic ACP transport; command override `VIBE_ACP_BIN`                                                                                                                                     |
| Cursor Agent                | Experimental | ACP JSON-RPC                            | Shared generic ACP transport with run-scoped selected skills; command override `CURSOR_ACP_BIN`                                                                                                   |
| Gemini CLI                  | Experimental | ACP JSON-RPC                            | Shared generic ACP transport; command override `GEMINI_ACP_BIN`                                                                                                                                   |
| OpenCode                    | Experimental | ACP JSON-RPC                            | Shared generic ACP transport with run-scoped selected skills; command override `OPENCODE_ACP_BIN`                                                                                                 |
| Qoder CLI                   | Experimental | ACP JSON-RPC                            | Shared generic ACP transport; command override `QODER_ACP_BIN`                                                                                                                                    |
| Qwen Code                   | Experimental | ACP JSON-RPC                            | Shared generic ACP transport; command override `QWEN_ACP_BIN`                                                                                                                                     |
| Generic ACP                 | Experimental | ACP JSON-RPC                            | Bring your own ACP agent command                                                                                                                                                                  |
| Fake                        | Test helper  | In-memory async events                  | For host tests and conformance checks                                                                                                                                                             |

Built-in real local providers do not impose a provider-level concurrency cap. Hosts can still enforce stricter queueing, cancellation, or watchdog policies around `runtime.run()` when a product surface needs serialized execution.

Local Codex runs always use a run-scoped temporary `CODEX_HOME`. The temporary
root comes from run env `TMPDIR`, `TEMP`, or `TMP`, then process env, then the
OS default. The provider shares `auth.json`, `sessions/`, and `plugins/cache/`
with the requested `CODEX_HOME` or the user's default `~/.codex` so token
refreshes, native resume, and plugin assets stay durable across runs; plugin
cache exposure is best-effort and does not block a run. It copies isolated
config files such as `config.json`, `config.toml`, and `instructions.md`,
preserves compatible `config.toml` settings such as custom model providers and
`base_url`, removes Codex config values known to break current CLI parsing,
disables Codex native multi-agent for single-process run lifecycle safety, and
overlays any run-scoped MCP server config.

Auth projection is symlink-first. If file symlinks are unavailable, the kit
uses an already installed official Mutagen `two-way-safe` synchronization
session with its default real-time watcher. Cleanup flushes the session, checks
for conflicts,
and terminates it only when conflict-free; otherwise the run home and Mutagen
session are preserved and cleanup reports an error. When Mutagen is unavailable,
the kit copies the stable auth into every run home and copies a valid changed auth
back atomically at cleanup, unless the stable file also changed. Runtime auth
projection resolves Mutagen from `TUTTI_MUTAGEN_BIN`, then `PATH`, and does not
download it when neither is available. Tutti Agent also projects
`.refresh.lock` as the same OS file object in the stable and run homes.

Codex and Tutti Agent keep one `.agent-acp-kit-codex-root` marker in the
application working directory after the first successful preparation. The
marker is project metadata used by Codex root discovery. It is deliberately
not created and removed per run: concurrent runs share it, avoiding remote
filesystem churn and preventing one finishing run from removing another
run's root marker.

## Host Integration Pattern

Treat this package as the local-agent execution layer, not as your application orchestrator.

Your host should own:

- User, session, run, and message persistence.
- Assistant message anchor creation.
- Runtime policy, such as trusted local mode, default provider, default model, and tool allowlists.
- Domain tools and MCP server creation.
- Mapping `AgentEvent` into your app stream, websocket, or replay protocol.
- Billing, job queues, media storage, canvas writes, and product state.
- Cross-provider resume or handoff semantics.

This package should own:

- Provider detection and capability reporting.
- Provider-specific command args, env, MCP config delivery, and model normalization.
- Process supervision and transport handling.
- Provider output parsing into `AgentEvent`.
- Cleanup of per-run temporary files it creates.

Keep the host adapter thin:

```ts
const mcpServers = [
  {
    name: "app-tools",
    type: "stdio" as const,
    command: process.execPath,
    args: ["/absolute/path/to/app-tools-mcp.js"],
    env: {
      APP_TOOL_TOKEN: runScopedToken,
      APP_DAEMON_URL: "http://127.0.0.1:3001",
    },
  },
];

for await (const event of runtime.run({
  runId,
  provider: selectedProvider,
  cwd: workspaceDir,
  prompt: userPrompt,
  systemPrompt,
  history,
  model,
  mcpServers,
  skillManifest,
  extraAllowedDirs: [workspaceDir],
  // Codex-only: set false to skip writing `.agent-acp-kit-codex-root` into cwd
  // (uses `project_root_markers = []` so cwd is still treated as the project root).
  writeCodexProjectRootMarker: true,
  env: providerEnv,
  resume: resumeContext,
})) {
  await projectAgentEventToHostStream(event);
}
```

## Events

`AgentEvent` is a TypeScript discriminated union. Narrow on `event.type` and TypeScript will expose the fields for that event variant.

```ts
if (event.type === "tool_result" && event.status === "failed") {
  console.error(event.error);
}
```

Common event types:

| Event            | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `status`         | Lifecycle progress such as detecting, spawning, running, warning  |
| `thinking_delta` | Incremental reasoning or thinking text when a provider exposes it |
| `text_delta`     | Assistant text                                                    |
| `tool_call`      | Normalized tool start                                             |
| `tool_result`    | Normalized tool completion or failure                             |
| `stderr`         | Redacted stderr text                                              |
| `error`          | Runtime or provider error                                         |
| `done`           | Terminal event with `completed`, `failed`, or `canceled`          |

ACP subprocess stderr is retained as a redacted diagnostic tail and is included
in failure errors, but it is not streamed as user-visible run output.

For MCP tool events, `name` is the normalized short tool name. Providers that
surface a server namespace may also include `rawName` and `mcpServerName`, so
hosts can distinguish same-named tools exposed by different MCP servers while
keeping backward-compatible short-name routing.

Hosts should persist enough event data for replay and should treat `done` as the terminal source of truth for a run. Individual `error` events are diagnostics, not terminal status by themselves.

### Opt-in timing diagnostics

Apps can ask the runtime for secret-free preparation and execution timings by
setting `metadata.timingDiagnostics` on a run:

```ts
for await (const event of runtime.run({
  runId,
  provider: "codex",
  cwd,
  prompt,
  metadata: { timingDiagnostics: true },
})) {
  if (event.type === "status" && event.diagnostic?.kind === "timing") {
    appLogger.info("agent_kit_timing", event.diagnostic);
    continue;
  }
  // Project normal provider events into the UI.
}
```

Timing diagnostics separate runtime preparation (`process_env`,
`tutti_run_context`, and `provider_plan`) from provider execution
(`transport_started`, `provider_first_event`, `provider_first_text`,
`provider_first_tool`, and `provider_done`). Failed preparation and provider
stream stages carry an `outcome` without including the error message. Each
diagnostic contains stage and total elapsed milliseconds only; it never
contains prompts, paths, environment values, MCP credentials, or provider
output. Hosts should persist these events with their own run id and should not
render them as user-visible agent status messages.

Codex reconnect progress such as `Reconnecting... 2/5 (request timed out)` is a transient provider retry state. The Codex provider maps those JSONL messages to `status` events with `status: "warning"` so hosts can show progress without ending the run.

## Models

Use `runtime.detect()` to get Agent Targets, provider installation/support
status, and authoritative model options.

```ts
const modelOptions = await runtime.detect();
```

Tutti agent catalogs are cached per CLI/workspace and composer options are
cached per CLI/workspace/exact Agent Target for the lifetime of the runtime.
Changing from the workspace root to an app-local project `cwd` therefore does
not repeat provider/model discovery or temporarily invalidate the selected Agent Target;
standalone no-argument detection is cached per Provider. After the catalog,
credentials, models, or local CLI installation changes, call
`runtime.detect({ refresh: true })` to refresh it.

For Agent Extensions, Tutti detection refines the broad catalog with one exact
`agent list --agent-id <agent-id>` availability request per target. These
requests and the initial broad catalog request have a one-minute client timeout.
Exact availability results are cached per runtime scope;
`runtime.detect({ refresh: true })` clears that cache and asks the daemon to
refresh its short-lived, coalesced authentication probe.

Tutti integration keeps two identities separate: `agentTargetId` is the exact
selectable target and `providerId` is the canonical local runtime provider. For
example, Kimi Code uses `extension:kimi-code` and `kimi`. Daemon provider
spellings such as `acp:kimi-code` are normalized through runtime descriptor
aliases and are not exposed as another public identity.

Provider behavior differs:

- Codex: attempts dynamic discovery with `codex debug models`, then falls back to bundled or package model hints.
- Claude Code: returns fallback hints such as `sonnet`, `opus`, `haiku`, and known full ids, then adds configured custom ids from the Claude settings file when present. Custom model ids can be passed through.
- ACP providers: attempt model discovery through ACP session lifecycle when the peer supports it.

Provider plugin diagnostics remain internal to standalone projection. The
public result intentionally contains only provider identity, `supported`,
`authState`, models/default model, and an optional display-only `reason`.

Hosts should not hardcode Codex or Claude model lists above this package. If a UI needs additional custom models, keep that UI behavior in the host and pass the chosen id into `AgentRunInput.model`.

## Permissions

Runs accept an optional provider-neutral permission selection. Pass both the
semantic returned by the composer and its provider mode id when available:

```ts
permission: {
  modeId: selectedMode.id,
  semantic: selectedMode.semantic,
}
```

The SDK maps this policy to each provider. Workspace App runs default to
`full-access` when the host omits `permission`: Codex uses its unrestricted
sandbox mode, Claude uses `--dangerously-skip-permissions`, and ACP requests select a
recognized permissive option when the peer offers one (otherwise the request
is cancelled).
An App can pass an explicit narrower semantic for a run. For ACP, every
non-`full-access` semantic cancels permission requests because the protocol
adapter cannot safely infer a tool's risk from a provider-specific option id.
The `permissionConfig.defaultValue` returned by a Tutti composer is the UI's
initial selection, not an explicit App run selection. Hosts that intentionally
offer a permission picker must pass the user's explicit choice in
`AgentRunInput.permission`; the automatic Tutti runtime integration never
promotes the composer default into execution policy.

## ACP Request Timeouts

ACP lifecycle requests use method-specific defaults: ordinary control requests
time out after 15 seconds, `session/new` after 30 seconds, and
`session/prompt` after 3 minutes. An explicit run or launch-plan `timeoutMs`
continues to override these defaults.

## VM-local Codex Home

For Codex runs, pass the VM session user's existing Codex home explicitly:

```ts
for await (const event of runtime.run({
  runId,
  provider: "codex",
  cwd: workspaceDir,
  prompt,
  env: {
    ...process.env,
    CODEX_HOME: "/home/tsh-runtime/.codex",
  },
  mcpServers,
})) {
  // Project AgentEvent into the host protocol.
}
```

The value in `CODEX_HOME` is the source home owned by the VM session user. The
kit creates a temporary per-run Codex home under `TMPDIR`, projects `auth.json` and
shared session/plugin state from the source home, copies and sanitizes
`config.toml`, and overlays the run's MCP servers. It never treats an App
runtime directory as the source login home.

## Installing Local Providers

Hosts can expose an install action for supported local providers through one
public function:

```ts
import { installAgentProvider } from "@tutti-os/agent-acp-kit";

const result = await installAgentProvider("codex");
```

Supported install targets are `codex` and `claude`. The function installs and
checks the official provider CLIs only:

- Codex install: `npm install -g @openai/codex`
- Claude Code install: `npm install -g @anthropic-ai/claude-code`

ACP adapter packages such as `codex-acp` and `claude-agent-acp` are not required
for these built-in providers. The install status still reports whether legacy
adapter binaries are present as compatibility metadata, but adapter presence no
longer affects `availability`, command selection, or post-install success.

The result is structured instead of throwing raw shell output. Failed installs
include a `failureReason` such as `install_command_failed`,
`install_timed_out`, or `post_install_probe_failed`. A successful install can
still return `auth_required` in `after.availability`; hosts should then prompt
the user to log in with the provider CLI.

Install, detection, and runtime launch envs include common local binary
directories such as `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, npm
configured prefix bins, and npm's global prefix bin when it can be resolved.

## MCP Tools

This package does not define product tools. It accepts `mcpServers` and converts them into the provider's expected format.

```ts
const mcpServers = [
  {
    name: "app-tools",
    type: "stdio" as const,
    command: "node",
    args: ["/absolute/path/to/app-tools-mcp.js"],
    env: { APP_TOOL_TOKEN: runScopedToken },
    toolTimeoutMs: 30 * 60_000,
    startupTimeoutMs: 2 * 60_000,
    // Optional override: "auto" | "prompt" | "writes" | "approve".
    // Run-scoped application MCP servers default to "approve".
    defaultToolsApprovalMode: "approve" as const,
  },
];
```

Timeouts are normalized by provider. Codex writes `startup_timeout_sec` and
`tool_timeout_sec` into its per-run config. Claude Code writes per-server
`timeout` for tool calls. Generic ACP providers receive only standard ACP MCP
server fields because the ACP MCP server schema does not define timeout fields.
Codex also writes `default_tools_approval_mode`; it defaults to `approve` so
trusted run-scoped application MCP tools can execute in non-interactive runs.
Hosts can explicitly choose `auto`, `prompt`, or `writes` for less-trusted MCP
servers. Claude full-access runs use `--dangerously-skip-permissions`.
Codex and Claude MCP delivery uses those provider-native, run-scoped config
paths. Generic ACP providers receive normalized MCP servers through ACP.

Keep tool tokens run-scoped and short-lived. Do not pass broad application secrets or database credentials directly to agent processes.

## Skills

`skillManifest` supports three delivery modes:

- `materialized-files`: writes selected skills into the run-scoped native
  provider home when the provider supports it (`CODEX_HOME/skills` for Codex
  and `TUTTI_AGENT_HOME/skills` for Tutti Agent), or into a provider-owned
  temporary run root for Claude Code and Generic ACP providers, then references
  them in the prompt. Cursor, OpenCode, and the other ACP presets use this
  Generic ACP layout without replacing their authentication `HOME`.
- `prompt-injection`: injects skill content into the provider prompt.
- `project-instructions`: injects instruction-style skill content.

The package handles delivery and cleanup for runtime and adapter execution. A
host that calls a provider's low-level `buildLaunchPlan()` directly owns the
resulting launch-plan artifact lifetime. The host remains the source of truth
for skill selection, permission, and storage.

Codex-compatible provider homes, Claude Code invocation artifacts, and Generic
ACP selected-skill roots are run-scoped. Their parent directory
comes from run env `TMPDIR`, `TEMP`, or `TMP`, falling back to the process env
and then the operating-system temp directory. Consequently VM callers can set
`TMPDIR` to an App runtime directory while non-VM callers need no special
configuration. Selected skills never mutate the source or global provider
home, or the project working directory. Generic ACP child-process `TMPDIR`,
`TEMP`, and `TMP` point at an isolated `tmp/` below the same run root so
provider-generated logs and scratch files are reclaimed with the run. Claude
Code's generated MCP config
is kept in the same temporary run root. Generic ACP MCP definitions are
delivered through ACP `session/new` and are not copied into generated files. For
provider-owned roots,
`materializedPath` is treated as an input hint only; the provider rewrites the
effective path to `<run-home>/skills/<safe-slug>`.

Hosts can also pass skill manifests produced by external commands. Tutti
workspace apps can use the Tutti subpath helper to load dynamic CLI skills, then
decide how to merge Tutti's recommended system prompt with the app-owned prompt:

```ts
import { loadTuttiAgentSkillContext } from "@tutti-os/agent-acp-kit/tutti";

const tuttiContext = await loadTuttiAgentSkillContext({
  agentTargetId,
  agentSessionId: runId,
  cwd,
  commandEnvNames: ["MY_APP_TUTTI_CLI"],
});
const systemPrompt = [
  appSystemPrompt,
  tuttiContext.recommendedSystemPrompt?.content,
]
  .filter(Boolean)
  .join("\n\n");

for await (const event of runtime.run({
  runId,
  provider,
  cwd,
  prompt,
  systemPrompt,
  skillManifest: tuttiContext.skillManifest,
})) {
  await projectAgentEventToHostStream(event);
}
```

## Cancellation And Resume

Use `runtime.cancel(runId)` or abort the `signal` passed into `runtime.run()`.

```ts
const controller = new AbortController();
const stream = runtime.run({ ...input, signal: controller.signal });

controller.abort();
await runtime.cancel(input.runId);
```

Resume is conservative by design:

- Same-provider resume may pass `providerSessionId` or `resumeToken` when the provider supports it.
- If no provider resume metadata exists, pass `resume: { mode: "fresh" }`.
- Cross-provider resume should be host-level handoff: rebuild prompt, history, and context, then start a fresh provider run.

Hosts should still pass durable `history` on every run. Native resume is an optimization for the same provider, not the only source of continuity:

```ts
const sameProvider = previousRun?.provider === selectedProvider;
const providerResumeId =
  previousRun?.providerSessionId ?? previousRun?.resumeToken;
const resume =
  sameProvider && providerResumeId
    ? {
        mode: "provider" as const,
        providerSessionId: previousRun?.providerSessionId,
        resumeToken: previousRun?.resumeToken,
      }
    : { mode: "fresh" as const };

for await (const event of runtime.run({
  runId,
  provider: selectedProvider,
  cwd,
  prompt,
  history: durableMessages,
  resume,
})) {
  if (event.type === "done") {
    await saveRunResumeMetadata(runId, {
      providerSessionId: event.sessionId,
      resumeToken: event.resumeToken,
    });
  }
}
```

## Public API

Main export:

```ts
import {
  createLocalAgentRuntime,
  createCodexProvider,
  createClaudeProvider,
  createDefaultLocalAgentProviderPlugins,
  createGenericAcpProvider,
  installAgentProvider,
  type AgentEvent,
  type AgentRunInput,
} from "@tutti-os/agent-acp-kit";
```

Runtime control plane export:

```ts
import {
  createRuntimeControlPlane,
  inferRuntimeKind,
} from "@tutti-os/agent-acp-kit/runtime-control-plane";
```

Testing export:

```ts
import {
  assertProviderConformance,
  createFakeAcpPeer,
  createFakeProvider,
} from "@tutti-os/agent-acp-kit/testing";
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

## Release Workflow

Use `.github/workflows/npm-package-release.yml` for package releases.

Stable `latest` releases:

- Open and merge a PR that bumps `package.json` to the target stable version.
- Run the workflow from `main` with `version_bump=current`, `dist_tag=latest`, and `dry_run=true` first.
- Re-run with `dry_run=false` to publish the current `package.json` version and push tag `v<version>`.

Beta and other prerelease packages:

- Run the workflow from a feature or release branch.
- Use `dist_tag=beta` and either a prerelease bump such as `prepatch`, `preminor`, `premajor`, or `prerelease`, or `version_bump=custom` with a prerelease version such as `0.3.0-beta.0`.
- The workflow commits the prerelease version bump back to the triggering branch, publishes the package, and pushes tag `v<version>`.

The workflow never commits directly to `main`. Non-`latest` releases must use prerelease semver versions, and `latest` releases must use stable semver versions.

## Security

Local agents execute user-trusted CLIs on the local machine. Only enable this package in trusted local mode.

Recommended host policy:

- Use run-scoped tool tokens with TTL and explicit revoke.
- Do not pass Supabase, database, or cloud provider tokens directly to agents.
- Redact stdout and stderr before persistence.
- Clean per-run temporary directories.
- Limit MCP tool allowlists per run.
- Gate dangerous provider flags behind trusted local mode.
- Persist terminal events durably so cancellation or failure cannot be overwritten by late process output.

## License

@tutti-os/agent-acp-kit is licensed under the [Apache License 2.0](./LICENSE).

## Roadmap

- Stabilize the public `AgentRunInput` and `AgentEvent` contracts.
- Expand provider conformance tests for ACP lifecycle edge cases.
- Add more provider-specific adapters where shared ACP behavior is not enough.
- Add first-class examples for desktop apps and local web apps.
- Add repository-level `CONTRIBUTING.md` and `SECURITY.md` before broader external contribution.
