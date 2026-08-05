import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACP_PROVIDER_SPECS,
  DEFAULT_LOCAL_AGENT_PROVIDER_IDS,
  createDefaultLocalAgentProviderPlugins,
  createGenericAcpProvider,
  createKnownAcpProvider,
} from "../../src/index.js";
import { createFakeAcpPeerScript } from "../../src/testing/index.js";
import { writeNodeCommand } from "../helpers/node-command.js";

describe("ACP provider wrappers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("reports unsupported when an ACP provider command is not installed", async () => {
    const provider = createGenericAcpProvider({
      args: ["acp"],
      command: "definitely-missing-acp-provider",
      displayName: "Missing ACP",
      providerId: "missing-acp",
    });

    await expect(provider.detect()).resolves.toMatchObject({
      authState: "missing",
      executablePath: "definitely-missing-acp-provider",
      supported: false,
      unsupportedReason: expect.stringContaining("Executable not found"),
      version: "not-installed",
    });
  });

  it("keeps a redacted diagnostic when ACP model discovery fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-acp-diagnostic-"));
    tempDirs.push(dir);
    const secret = "acp-diagnostic-secret";
    const command = writeNodeCommand(
      dir,
      "broken-acp",
      `
process.stderr.write("registry probe failed with ${secret}");
setTimeout(() => process.exit(42), 10);
`,
    );
    const provider = createGenericAcpProvider({
      args: [],
      command: "broken-acp",
      displayName: "Broken ACP",
      providerId: "broken-acp",
    });

    const detection = await provider.detect({
      env: { PATH: dir },
      redactionSecrets: [secret],
    });

    expect(detection).toMatchObject({
      executablePath: command,
      models: [],
      supported: true,
      diagnostics: [
        {
          message: expect.stringContaining(
            "ACP model detection exited with code 42",
          ),
          source: "acp-model-discovery",
        },
      ],
    });
    expect(detection?.diagnostics?.[0]?.message).toContain("[REDACTED]");
    expect(detection?.diagnostics?.[0]?.message).not.toContain(secret);
  });

  it("exposes concrete provider plugins backed by the shared ACP transport", async () => {
    for (const spec of ACP_PROVIDER_SPECS) {
      const provider = createKnownAcpProvider(spec.id);
      const adapter = provider.createAdapter!();
      const plan = await adapter.buildLaunchPlan({
        runId: `run_${provider.id}`,
        cwd: "/tmp",
        prompt: "hello",
        permission: { modeId: "full-access", semantic: "full-access" },
        runtimeKind: "local-agent",
        runtimeProvider: provider.id,
      });

      expect(plan.promptInput).toBe("stdin");
      expect(plan.permission).toEqual({
        modeId: "full-access",
        semantic: "full-access",
      });
      for await (const _event of adapter.parseEvents((async function* () {})())) {
        // Drain to clean the run-scoped provider temp root.
      }
      const defaultAdapter = provider.createAdapter!();
      const defaultPlan = await defaultAdapter.buildLaunchPlan({
        runId: `run_default_${provider.id}`,
        cwd: "/tmp",
        prompt: "hello",
        runtimeKind: "local-agent",
        runtimeProvider: provider.id,
      });
      expect(defaultPlan.permission).toEqual({ semantic: "full-access" });
      for await (const _event of defaultAdapter.parseEvents((async function* () {})())) {
        // Drain to clean the run-scoped provider temp root.
      }
      expect(plan.args).toEqual(spec.args);
      expect(provider.capabilities()).toMatchObject({
        maxConcurrentRuns: Number.MAX_SAFE_INTEGER,
        nativeResume: false,
        streaming: true,
      });
    }
  });

  it("uses the host-resolved executable for an ACP run", async () => {
    const provider = createGenericAcpProvider({
      args: ["acp"],
      command: "cursor-agent",
      displayName: "Cursor",
      providerId: "cursor",
    });
    const adapter = provider.createAdapter!();
    const plan = await adapter.buildLaunchPlan({
      runId: "run-resolved-cursor",
      cwd: "/tmp",
      prompt: "hello",
      executablePath: process.execPath,
    });

    expect(plan.command).toBe(process.execPath);
    for await (const _event of adapter.parseEvents((async function* () {})())) {
      // Drain to clean the run-scoped provider temp root.
    }
  });

  it("builds the curated default provider list", () => {
    const providers = createDefaultLocalAgentProviderPlugins();

    expect(providers.map((provider) => provider.id)).toEqual(
      DEFAULT_LOCAL_AGENT_PROVIDER_IDS,
    );
    expect(providers.map((provider) => provider.kind)).toEqual(
      providers.map(() => "local-agent"),
    );
  });

  for (const providerId of ["cursor", "opencode"] as const) {
    it(`materializes selected skills under TMPDIR for ${providerId} and cleans the adapter run`, async () => {
      const scratch = mkdtempSync(join(tmpdir(), `agent-acp-kit-${providerId}-skills-`));
      tempDirs.push(scratch);
      const cwd = join(scratch, "workspace");
      const runtimeTmp = join(scratch, "runtime-tmp");
      mkdirSync(cwd, { recursive: true });
      const provider = createKnownAcpProvider(providerId);
      const adapter = provider.createAdapter!();
      const mcpServers = [
        {
          type: "stdio" as const,
          name: "workspace-tools",
          command: "workspace-mcp",
          args: ["serve"],
          env: { TOOL_TOKEN: "run-token" },
        },
      ];

      const plan = await adapter.buildLaunchPlan({
        runId: `run-${providerId}-skills`,
        cwd,
        prompt: "Use the selected workspace skill.",
        env: { TMPDIR: runtimeTmp },
        mcpServers,
        skillManifest: [
          {
            skillId: "workspace/editor",
            slug: "workspace-editor",
            deliveryMode: "materialized-files",
            content: "# Workspace editor\n",
          },
          {
            skillId: "workspace/rules",
            slug: "workspace-rules",
            deliveryMode: "prompt-injection",
            content: "Keep formal files in the workspace data directory.",
          },
        ],
      });

      const [runDir] = readdirSync(runtimeTmp);
      const skillPath = join(runtimeTmp, runDir!, "skills", "workspace-editor");
      expect(readFileSync(join(skillPath, "SKILL.md"), "utf8")).toBe(
        "# Workspace editor\n",
      );
      expect(plan.prompt).toContain(`${skillPath}/SKILL.md`);
      expect(plan.prompt).toContain("Keep formal files in the workspace data directory.");
      expect(plan.mcpServers).toEqual(mcpServers);
      expect(plan.env).toMatchObject({
        TMPDIR: join(runtimeTmp, runDir!, "tmp"),
        TEMP: join(runtimeTmp, runDir!, "tmp"),
        TMP: join(runtimeTmp, runDir!, "tmp"),
      });
      expect(readdirSync(cwd)).toEqual([]);
      expect(readdirSync(join(runtimeTmp, runDir!)).sort()).toEqual(["skills", "tmp"]);

      await expect(
        provider.buildLaunchPlan({
          runId: `run-${providerId}-skills`,
          cwd,
          prompt: "duplicate",
          env: { TMPDIR: runtimeTmp },
          skillManifest: [
            {
              skillId: "workspace/editor",
              slug: "workspace-editor",
              deliveryMode: "materialized-files",
              content: "# Duplicate",
            },
          ],
        }),
      ).rejects.toThrow("already prepared");

      for await (const _event of adapter.parseEvents((async function* () {})())) {
        // Drain the adapter stream to trigger provider-owned cleanup.
      }
      expect(readdirSync(runtimeTmp)).toEqual([]);
    });
  }

  it("cleans a failed Generic ACP skill preparation and permits adapter retry", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-acp-kit-acp-failure-"));
    tempDirs.push(scratch);
    const cwd = join(scratch, "workspace");
    const runtimeTmp = join(scratch, "runtime-tmp");
    mkdirSync(cwd, { recursive: true });
    const adapter = createKnownAcpProvider("opencode").createAdapter!();

    await expect(
      adapter.buildLaunchPlan({
        runId: "run-failed-skills",
        cwd,
        prompt: "fail",
        env: { TMPDIR: runtimeTmp },
        skillManifest: [
          {
            skillId: "duplicate/one",
            slug: "duplicate",
            deliveryMode: "materialized-files",
            content: "one",
          },
          {
            skillId: "duplicate/two",
            slug: "duplicate",
            deliveryMode: "materialized-files",
            content: "two",
          },
        ],
      }),
    ).rejects.toThrow("Duplicate skill materialization path");
    expect(readdirSync(runtimeTmp)).toEqual([]);

    await expect(
      adapter.buildLaunchPlan({
        runId: "run-retry-skills",
        cwd,
        prompt: "retry",
        env: { TMPDIR: runtimeTmp },
      }),
    ).resolves.toMatchObject({ runId: "run-retry-skills" });
  });

  it("cleans Generic ACP provider temp files after a complete transport run", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-acp-kit-acp-run-"));
    tempDirs.push(scratch);
    const cwd = join(scratch, "workspace");
    const runtimeTmp = join(scratch, "runtime-tmp");
    mkdirSync(cwd, { recursive: true });
    const provider = createGenericAcpProvider({
      args: [
        "-e",
        createFakeAcpPeerScript({
          updates: [{ type: "text_delta", text: "ACP_OK" }],
        }),
      ],
      command: process.execPath,
      displayName: "Lifecycle ACP",
      providerId: "lifecycle-acp",
    });
    const events = [];

    for await (const event of provider.run({
      runId: "run-lifecycle",
      cwd,
      prompt: "validate cleanup",
      env: { TMPDIR: runtimeTmp },
      skillManifest: [
        {
          skillId: "validation/response",
          slug: "validation-response",
          deliveryMode: "materialized-files",
          content: "# Validation response\n",
        },
      ],
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text_delta", text: "ACP_OK" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "done", status: "completed" }),
    );
    expect(readdirSync(runtimeTmp)).toEqual([]);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("runs every known ACP preset through the shared transport and cleanup lifecycle", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-acp-kit-known-acp-runs-"));
    tempDirs.push(scratch);
    const command = writeNodeCommand(
      scratch,
      "fake-acp-provider",
      createFakeAcpPeerScript({
        updates: [{ type: "text_delta", text: "PRESET_OK" }],
      }),
    );

    for (const spec of ACP_PROVIDER_SPECS) {
      const cwd = join(scratch, `workspace-${spec.id}`);
      const runtimeTmp = join(scratch, `runtime-${spec.id}`);
      mkdirSync(cwd, { recursive: true });
      const previousOverride = process.env[spec.binEnvKey];
      process.env[spec.binEnvKey] = command;
      try {
        const events = [];
        const provider = createKnownAcpProvider(spec.id);
        for await (const event of provider.run({
          runId: `run-${spec.id}`,
          cwd,
          prompt: "validate preset",
          env: { TMPDIR: runtimeTmp },
          skillManifest: [
            {
              skillId: "validation/preset",
              slug: "validation-preset",
              deliveryMode: "materialized-files",
              content: `# ${spec.displayName}\n`,
            },
          ],
        })) {
          events.push(event);
        }
        expect(events).toContainEqual({ type: "text_delta", text: "PRESET_OK" });
        expect(events).toContainEqual(
          expect.objectContaining({ type: "done", status: "completed" }),
        );
        expect(readdirSync(cwd)).toEqual([]);
        expect(readdirSync(runtimeTmp)).toEqual([]);
      } finally {
        if (previousOverride === undefined) {
          delete process.env[spec.binEnvKey];
        } else {
          process.env[spec.binEnvKey] = previousOverride;
        }
      }
    }
  });
});
