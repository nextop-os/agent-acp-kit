import { describe, expect, it, vi } from "vitest";

import { createClaudeProvider } from "../../src/providers/claude/index.js";
import type { RuntimeAgentDescriptor } from "../../src/runtime/create-runtime.js";
import { TuttiIntegrationError } from "../../src/tutti/cli-json-runner.js";
import { createTuttiRuntimeIntegration } from "../../src/tutti/runtime-integration.js";

const descriptors: RuntimeAgentDescriptor<"local-agent", string>[] = [
  {
    id: "codex",
    displayName: "Codex",
    kind: "local-agent",
    requiresKnownAuth: false,
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    kind: "local-agent",
    requiresKnownAuth: true,
  },
];

function catalog() {
  return {
    schemaVersion: 1,
    defaultAgentTargetId: "team:writer",
    agents: [
      {
        id: "team:writer",
        name: "Writer",
        provider: "codex",
        executablePath: "/resolved/bin/codex",
        availability: { status: "available", reasonCode: "", detail: "" },
      },
      {
        id: "team:reviewer",
        name: "Reviewer",
        provider: "codex",
        availability: { status: "available", reasonCode: "", detail: "" },
      },
      {
        id: "local:claude-code",
        name: "Claude Code",
        provider: "claude-code",
        availability: {
          status: "unavailable",
          reasonCode: "auth_required",
          detail: "Provider authentication is required.",
        },
      },
    ],
  };
}

function claudeCatalog() {
  return {
    schemaVersion: 1,
    defaultAgentTargetId: "local:claude-code",
    agents: [
      {
        id: "local:claude-code",
        name: "Claude Code",
        provider: "claude-code",
        availability: { status: "available", reasonCode: "", detail: "" },
      },
    ],
  };
}

function composer(agentTargetId: string) {
  const model =
    agentTargetId === "team:writer" ? "writer-model" : "reviewer-model";
  return {
    schemaVersion: 2,
    agentTargetId,
    providerId: "codex",
    effectiveSettings: { model },
    modelConfig: {
      configurable: true,
      currentValue: model,
      defaultValue: model,
      options: [{ id: model, value: model, label: model }],
    },
    permissionConfig: {
      configurable: true,
      defaultValue: "auto",
      modes: [{ id: "auto", label: "Auto", semantic: "auto" }],
    },
    reasoningConfig: {
      configurable: true,
      currentValue: "high",
      defaultValue: "medium",
      options: [{ id: "high", value: "high", label: "High" }],
    },
    speedConfig: {
      configurable: false,
      currentValue: "",
      defaultValue: "",
      options: [],
    },
  };
}

function claudeComposer() {
  return {
    schemaVersion: 2,
    agentTargetId: "local:claude-code",
    providerId: "claude-code",
    effectiveSettings: { model: "default", permissionModeId: "default" },
    modelConfig: {
      configurable: true,
      currentValue: "default",
      defaultValue: "default",
      options: [{ id: "default", value: "default", label: "Default" }],
    },
    permissionConfig: {
      configurable: true,
      defaultValue: "default",
      modes: [
        {
          id: "default",
          label: "Default",
          semantic: "ask-before-write",
        },
      ],
    },
    reasoningConfig: {
      configurable: false,
      currentValue: "",
      defaultValue: "",
      options: [],
    },
    speedConfig: {
      configurable: false,
      currentValue: "",
      defaultValue: "",
      options: [],
    },
  };
}

describe("Tutti-aware runtime integration", () => {
  it("returns exact Agent Targets and target-scoped models from one detect call", async () => {
    const calls: string[][] = [];
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) return catalog();
        const target = args[args.indexOf("--agent-id") + 1]!;
        return composer(target);
      },
    });

    const detected = await integration.detect({
      descriptors,
      context: { cwd: "/workspace/project" },
    });

    expect(detected).toMatchObject([
      {
        agentTargetId: "team:writer",
        executablePath: "/resolved/bin/codex",
        provider: "codex",
        displayName: "Writer",
        supported: true,
        isDefault: true,
        defaultModelId: "writer-model",
        models: [{ id: "writer-model", label: "writer-model" }],
      },
      {
        agentTargetId: "team:reviewer",
        provider: "codex",
        supported: true,
        defaultModelId: "reviewer-model",
      },
      {
        agentTargetId: "local:claude-code",
        provider: "claude-code",
        supported: false,
        authState: "missing",
        models: [],
      },
    ]);
    expect(calls.filter((args) => args.includes("list"))).toHaveLength(1);
    expect(
      calls.filter((args) => args.includes("composer-options")),
    ).toHaveLength(2);
  });

  it("maps Tutti extension provider aliases to canonical runtime providers", async () => {
    const extensionDescriptors: RuntimeAgentDescriptor<
      "local-agent",
      string
    >[] = [
      {
        id: "hermes",
        aliases: ["acp:hermes"],
        displayName: "Hermes",
        kind: "local-agent",
        requiresKnownAuth: false,
      },
      {
        id: "kimi",
        aliases: ["kimi-code", "acp:kimi-code"],
        displayName: "Kimi CLI",
        kind: "local-agent",
        requiresKnownAuth: false,
      },
    ];
    const extensionCatalog = {
      schemaVersion: 1,
      defaultAgentTargetId: "extension:hermes",
      agents: [
        {
          id: "extension:hermes",
          name: "Hermes Agent",
          provider: "acp:hermes",
          executablePath: "/resolved/bin/hermes",
          availability: { status: "available", reasonCode: "", detail: "" },
        },
        {
          id: "extension:kimi-code",
          name: "Kimi Code",
          provider: "acp:kimi-code",
          executablePath: "/resolved/bin/kimi",
          availability: { status: "available", reasonCode: "", detail: "" },
        },
      ],
    };
    const runTuttiCli = vi.fn(async (args: string[]) => {
      if (args.includes("list")) {
        const targetIndex = args.indexOf("--agent-id");
        if (targetIndex < 0) return extensionCatalog;
        const targetId = args[targetIndex + 1]!;
        const agent = extensionCatalog.agents.find(
          (candidate) => candidate.id === targetId,
        )!;
        return {
          ...extensionCatalog,
          agents: [
            targetId === "extension:hermes"
              ? {
                  ...agent,
                  availability: {
                    status: "unavailable",
                    reasonCode: "auth_required",
                    detail: "authentication required",
                  },
                }
              : agent,
          ],
        };
      }
      const agentTargetId = args[args.indexOf("--agent-id") + 1]!;
      return {
        ...composer(agentTargetId),
        providerId:
          agentTargetId === "extension:hermes" ? "acp:hermes" : "acp:kimi-code",
      };
    });
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli,
    });

    const extensionDetected = await integration.detect({
      descriptors: extensionDescriptors,
    });
    expect(extensionDetected).toMatchObject([
      {
        agentTargetId: "extension:hermes",
        provider: "hermes",
        supported: false,
        authState: "missing",
      },
      {
        agentTargetId: "extension:kimi-code",
        provider: "kimi",
        supported: true,
      },
    ]);
    await integration.detect({ descriptors: extensionDescriptors });
    expect(
      runTuttiCli.mock.calls.filter(
        ([args]) => args.includes("list") && args.includes("--agent-id"),
      ),
    ).toHaveLength(2);

    await integration.detect({
      descriptors: extensionDescriptors,
      context: { refresh: true },
    });
    const refreshedAvailabilityCalls = runTuttiCli.mock.calls.filter(
      ([args]) =>
        args.includes("list") &&
        args.includes("--agent-id") &&
        args.includes("--refresh"),
    );
    expect(refreshedAvailabilityCalls).toHaveLength(2);
    await expect(
      integration.prepareRun({
        descriptors: extensionDescriptors,
        env: { TUTTI_CLI: "/usr/bin/tutti-cli" },
        run: {
          agentTargetId: "extension:kimi-code",
          runId: "run-kimi-extension",
          provider: "kimi",
          cwd: "/workspace/project",
          prompt: "hello",
        },
      }),
    ).resolves.toMatchObject({
      provider: "kimi",
      executablePath: "/resolved/bin/kimi",
    });
  });

  it("single-flights and caches Tutti detection until refresh", async () => {
    const runTuttiCli = vi.fn(async (args: string[]) =>
      args.includes("list")
        ? catalog()
        : composer(args[args.indexOf("--agent-id") + 1]!),
    );
    const integration = createTuttiRuntimeIntegration({ runTuttiCli });
    const input = { descriptors, context: { cwd: "/workspace/project" } };

    await Promise.all([integration.detect(input), integration.detect(input)]);
    expect(
      runTuttiCli.mock.calls.filter(([args]) => args.includes("list")),
    ).toHaveLength(1);

    await integration.detect({
      ...input,
      context: { ...input.context, refresh: true },
    });
    expect(
      runTuttiCli.mock.calls.filter(([args]) => args.includes("list")),
    ).toHaveLength(2);
  });

  it("reuses workspace and exact-target caches when project cwd changes", async () => {
    const runTuttiCli = vi.fn(async (args: string[]) =>
      args.includes("list")
        ? catalog()
        : composer(args[args.indexOf("--agent-id") + 1]!),
    );
    const integration = createTuttiRuntimeIntegration({ runTuttiCli });
    const env = {
      TUTTI_CLI: "/opt/tsh/bundle/bin/tutti",
      TUTTI_WORKSPACE_ID: "workspace-1",
    };

    await integration.detect({
      descriptors,
      context: { cwd: "/workspace", env },
    });
    await integration.detect({
      descriptors,
      context: {
        cwd: "/workspace/.tsh/apps/data/app-1/projects/project-1",
        env,
      },
    });

    expect(
      runTuttiCli.mock.calls.filter(([args]) => args.includes("list")),
    ).toHaveLength(1);
    expect(
      runTuttiCli.mock.calls.filter(([args]) =>
        args.includes("composer-options"),
      ),
    ).toHaveLength(2);
  });

  it("refreshes the exact target before runtime preparation", async () => {
    let catalogPath = "/resolved/bin/codex-old";
    const runTuttiCli = vi.fn(async (args: string[]) => {
      if (!args.includes("list")) {
        return composer(args[args.indexOf("--agent-id") + 1]!);
      }
      const payload = catalog();
      payload.agents[0]!.executablePath = catalogPath;
      return payload;
    });
    const integration = createTuttiRuntimeIntegration({ runTuttiCli });
    const env = {
      TUTTI_CLI: "/opt/tsh/bundle/bin/tutti",
      TUTTI_WORKSPACE_ID: "workspace-1",
    };
    await integration.detect({
      descriptors,
      context: { cwd: "/workspace", env },
    });
    catalogPath = "/resolved/bin/codex-new";

    const prepared = await integration.prepareRun({
      descriptors,
      env,
      run: {
        agentTargetId: "team:writer",
        runId: "run-cached-target",
        provider: "codex",
        cwd: "/workspace/.tsh/apps/data/app-1/projects/project-1",
        prompt: "hello",
      },
    });

    expect(prepared.executablePath).toBe("/resolved/bin/codex-new");
    expect(
      runTuttiCli.mock.calls.filter(([args]) => args.includes("list")),
    ).toHaveLength(2);
    expect(
      runTuttiCli.mock.calls.filter(
        ([args]) =>
          args.includes("composer-options") && args.includes("team:writer"),
      ),
    ).toHaveLength(2);
  });

  it("retries one timed-out read-only runtime preparation request", async () => {
    let listAttempts = 0;
    const runTuttiCli = vi.fn(async (args: string[]) => {
      if (args.includes("list")) {
        listAttempts += 1;
        if (listAttempts === 1) {
          throw new TuttiIntegrationError("cli_timeout", "Tutti CLI request timed out.");
        }
        return catalog();
      }
      return composer("team:writer");
    });
    const integration = createTuttiRuntimeIntegration({ runTuttiCli });

    await expect(
      integration.prepareRun({
        descriptors,
        env: { TUTTI_CLI: "/usr/bin/tutti-cli" },
        run: {
          agentTargetId: "team:writer",
          runId: "run-retry-timeout",
          provider: "codex",
          cwd: "/workspace/project",
          prompt: "hello",
        },
      }),
    ).resolves.toMatchObject({ executablePath: "/resolved/bin/codex" });
    expect(listAttempts).toBe(2);
  });

  it("does not retry non-timeout runtime preparation failures", async () => {
    const runTuttiCli = vi.fn(async () => {
      throw new TuttiIntegrationError("cli_execution_failed", "failed");
    });
    const integration = createTuttiRuntimeIntegration({ runTuttiCli });

    await expect(
      integration.prepareRun({
        descriptors,
        env: { TUTTI_CLI: "/usr/bin/tutti-cli" },
        run: {
          agentTargetId: "team:writer",
          runId: "run-no-retry",
          provider: "codex",
          cwd: "/workspace/project",
          prompt: "hello",
        },
      }),
    ).rejects.toMatchObject({ code: "cli_execution_failed" });
    expect(runTuttiCli).toHaveBeenCalledTimes(1);
  });

  it("applies target-scoped model and reasoning defaults without applying the permission UI default", async () => {
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli: async (args) =>
        args.includes("list") ? catalog() : composer("team:writer"),
    });
    const prepared = await integration.prepareRun({
      descriptors,
      env: { TUTTI_CLI: "/usr/bin/tutti-cli" },
      run: {
        agentTargetId: "team:writer",
        runId: "run-1",
        provider: "codex",
        cwd: "/workspace/project",
        prompt: "hello",
      },
    });
    expect(prepared).toMatchObject({
      executablePath: "/resolved/bin/codex",
      model: "writer-model",
      reasoning: "high",
    });
    expect(prepared).not.toHaveProperty("permission");
  });

  it("keeps the provider fallback when the catalog has no resolved executable", async () => {
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli: async (args) =>
        args.includes("list") ? catalog() : composer("team:reviewer"),
    });
    const prepared = await integration.prepareRun({
      descriptors,
      env: { TUTTI_CLI: "/usr/bin/tutti-cli" },
      run: {
        agentTargetId: "team:reviewer",
        runId: "run-provider-fallback",
        provider: "codex",
        cwd: "/workspace/project",
        prompt: "hello",
      },
    });

    expect(prepared).not.toHaveProperty("executablePath");
  });

  it("preserves an explicit run permission instead of replacing it with the permission UI default", async () => {
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli: async (args) =>
        args.includes("list") ? catalog() : composer("team:writer"),
    });
    const prepared = await integration.prepareRun({
      descriptors,
      env: { TUTTI_CLI: "/usr/bin/tutti-cli" },
      run: {
        agentTargetId: "team:writer",
        runId: "run-explicit-permission",
        provider: "codex",
        cwd: "/workspace/project",
        prompt: "hello",
        permission: { semantic: "locked-down", modeId: "read-only" },
      },
    });

    expect(prepared.permission).toEqual({
      semantic: "locked-down",
      modeId: "read-only",
    });
  });

  it("lets the Claude provider apply the autonomous default after ignoring its permission UI default", async () => {
    const integration = createTuttiRuntimeIntegration<
      "local-agent",
      "claude-code"
    >({
      runTuttiCli: async (args) =>
        args.includes("list") ? claudeCatalog() : claudeComposer(),
    });
    const claudeDescriptors: RuntimeAgentDescriptor<
      "local-agent",
      "claude-code"
    >[] = [
      {
        id: "claude-code",
        displayName: "Claude Code",
        kind: "local-agent",
        requiresKnownAuth: true,
      },
    ];
    const prepared = await integration.prepareRun({
      descriptors: claudeDescriptors,
      env: { TUTTI_CLI: "/usr/bin/tutti-cli" },
      run: {
        agentTargetId: "local:claude-code",
        runId: "run-claude-autonomous-default",
        provider: "claude-code",
        cwd: "/workspace/project",
        prompt: "call the app tool",
      },
    });

    expect(prepared).not.toHaveProperty("permission");
    const plan = await createClaudeProvider().buildLaunchPlan(prepared);
    expect(plan.args).toContain("--dangerously-skip-permissions");
  });

  it("rejects provider-only runs when Tutti CLI is active", async () => {
    const integration = createTuttiRuntimeIntegration();
    await expect(
      integration.prepareRun({
        descriptors,
        env: { TUTTI_CLI: "/usr/bin/tutti-cli" },
        run: {
          runId: "run-provider-only",
          provider: "codex",
          cwd: "/workspace/project",
          prompt: "hello",
        },
      }),
    ).rejects.toThrow("exact agentTargetId");
  });

  it("does not activate Tutti behavior without a configured CLI", async () => {
    const integration = createTuttiRuntimeIntegration();
    await expect(
      integration.detect({ descriptors, context: { env: { TUTTI_CLI: "" } } }),
    ).resolves.toBeUndefined();
  });

  it("fails closed without inventing standalone targets when the Tutti catalog fails", async () => {
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli: async () => {
        throw new Error("catalog unavailable");
      },
    });

    await expect(
      integration.detect({
        descriptors,
        context: { env: { TUTTI_CLI: "/usr/bin/tutti-cli" } },
      }),
    ).resolves.toEqual([]);
  });

  it("retries after a transient Tutti catalog failure instead of caching the empty result", async () => {
    let catalogAttempts = 0;
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli: async (args) => {
        if (args.includes("list") && catalogAttempts++ === 0) {
          throw new Error("temporary catalog failure");
        }
        return args.includes("list")
          ? catalog()
          : composer(args[args.indexOf("--agent-id") + 1]!);
      },
    });
    const input = {
      descriptors,
      context: { env: { TUTTI_CLI: "/usr/bin/tutti-cli" } },
    };

    await expect(integration.detect(input)).resolves.toEqual([]);
    await expect(integration.detect(input)).resolves.toHaveLength(3);
    expect(catalogAttempts).toBe(2);
  });
});
