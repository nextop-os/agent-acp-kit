import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getAgentProviderInstallStatus,
  installAgentProvider,
  type AgentProviderInstallCommandResult,
} from "../../src/providers/install.js";
import { writeNodeCommand } from "../helpers/node-command.js";

describe("agent provider install", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function tempPath(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function writeExecutable(
    dir: string,
    name: string,
    body = "process.exit(0);",
  ) {
    return writeNodeCommand(dir, name, body);
  }

  const commandResolver = (dir: string) => async (binary: string) => {
    const filePath = join(
      dir,
      process.platform === "win32" ? `${binary}.cmd` : binary,
    );
    return existsSync(filePath) ? filePath : undefined;
  };

  function successfulRunner(
    onCommand?: (command: string) => void,
  ): Parameters<typeof installAgentProvider>[1]["commandRunner"] {
    return async (command): Promise<AgentProviderInstallCommandResult> => {
      onCommand?.(command);
      return {
        command,
        code: 0,
        signal: null,
        stdout: "installed",
        stderr: "",
        timedOut: false,
        canceled: false,
      };
    };
  }

  it("selects the full Codex install command when the CLI is missing", async () => {
    const dir = tempPath("agent-acp-kit-install-codex-missing-");
    const commands: string[] = [];

    const result = await installAgentProvider("codex", {
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex") },
      commandResolver: commandResolver(dir),
      commandRunner: successfulRunner((command) => {
        commands.push(command);
        writeExecutable(dir, "codex");
        mkdirSync(join(dir, ".codex"), { recursive: true });
        writeFileSync(join(dir, ".codex", "auth.json"), "{}");
      }),
    });

    expect(commands).toEqual(["npm install -g @openai/codex"]);
    expect(result).toMatchObject({
      provider: "codex",
      status: "succeeded",
      before: {
        availability: "not_installed",
        reason: "cli_not_found",
      },
      after: {
        cli: { installed: true },
        adapter: { installed: false },
      },
    });
  });

  it("treats an authenticated Claude CLI as ready without claude-agent-acp", async () => {
    const dir = tempPath("agent-acp-kit-install-claude-ready-");
    writeExecutable(
      dir,
      "claude",
      'if (process.argv[2] === "auth" && process.argv[3] === "status") console.log(JSON.stringify({ loggedIn: true }));\nprocess.exit(0);',
    );

    const result = await installAgentProvider("claude", {
      env: { PATH: dir },
      commandResolver: commandResolver(dir),
      commandRunner: async () => {
        throw new Error("should not run");
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.command).toBeNull();
    expect(result.before.availability).toBe("ready");
    expect(result.before.adapter.installed).toBe(false);
  });

  it("selects the Claude Code install command when the CLI is missing", async () => {
    const dir = tempPath("agent-acp-kit-install-claude-missing-");
    const commands: string[] = [];

    const result = await installAgentProvider("claude", {
      env: { PATH: dir },
      commandResolver: commandResolver(dir),
      commandRunner: successfulRunner((command) => {
        commands.push(command);
        writeExecutable(
          dir,
          "claude",
          'if (process.argv[2] === "auth" && process.argv[3] === "status") console.log(JSON.stringify({ loggedIn: true }));\nprocess.exit(0);',
        );
      }),
    });

    expect(commands).toEqual(["npm install -g @anthropic-ai/claude-code"]);
    expect(result.status).toBe("succeeded");
    expect(result.after.availability).toBe("ready");
    expect(result.after.adapter.installed).toBe(false);
  });

  it("reports auth_required when both binaries exist but auth is missing", async () => {
    const dir = tempPath("agent-acp-kit-install-auth-required-");
    writeExecutable(dir, "codex");

    await expect(
      getAgentProviderInstallStatus("codex", {
        env: { PATH: dir, CODEX_HOME: join(dir, ".codex") },
        commandResolver: commandResolver(dir),
      }),
    ).resolves.toMatchObject({
      availability: "auth_required",
      reason: "auth_required",
      cli: { installed: true },
      adapter: { installed: false },
    });
  });

  it("does not treat a zero-exit logged-out Claude status as ready", async () => {
    const dir = tempPath("agent-acp-kit-install-claude-logged-out-");
    writeExecutable(
      dir,
      "claude",
      'if (process.argv[2] === "auth" && process.argv[3] === "status") console.log(JSON.stringify({ loggedIn: false }));\nprocess.exit(0);',
    );

    await expect(
      getAgentProviderInstallStatus("claude", {
        env: { PATH: dir },
        commandResolver: commandResolver(dir),
      }),
    ).resolves.toMatchObject({
      availability: "auth_required",
      reason: "auth_required",
      auth: { ok: false, required: true },
    });
  });
});
