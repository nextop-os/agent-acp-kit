import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectCodex } from "../../src/providers/codex/detect.js";
import { writeNodeCommand } from "../helpers/node-command.js";

describe("detectCodex", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("does not read ambient home variables when an isolated env is supplied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-isolated-env-"));
    tempDirs.push(dir);
    vi.stubEnv("CODEX_HOME", join(dir, "ambient-codex-home"));

    const detection = await detectCodex({ env: { PATH: dir } });

    expect(detection.configDir).toBe(join(homedir(), ".codex"));
  });

  it("reports unsupported when the Codex CLI is not installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-missing-"));
    tempDirs.push(dir);

    const detection = await detectCodex({
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex-home") },
    });

    expect(detection).toMatchObject({
      authState: "missing",
      executablePath: "codex",
      supported: false,
      version: "not-installed",
    });
    expect(detection.unsupportedReason).toContain("Executable not found");
    expect(detection.models).toEqual([
      { id: "default", label: "Default (CLI config)" },
    ]);
  });

  it("returns config and skills directories from CODEX_HOME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-detect-"));
    tempDirs.push(dir);
    const codexBin = writeNodeCommand(
      dir,
      "codex",
      `if (process.argv[2] === "--version") { console.log("codex 1.2.3"); process.exit(0); }
process.exit(1);`,
    );

    const detection = await detectCodex({
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex-home") },
    });

    expect(detection).toMatchObject({
      executablePath: codexBin,
      version: "codex 1.2.3",
      configDir: join(dir, ".codex-home"),
      skillsDir: join(dir, ".codex-home", "skills"),
      supported: true,
    });
  });

  it("supports the Tutti Agent command and TUTTI_AGENT_HOME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-tutti-agent-detect-"));
    tempDirs.push(dir);
    const tuttiAgentBin = writeNodeCommand(
      dir,
      "tutti-agent",
      `if (process.argv[2] === "--version") { console.log("tutti-agent 0.0.1"); process.exit(0); }
if (process.argv[2] === "login" && process.argv[3] === "status") { console.log("Not logged in"); process.exit(1); }
process.exit(1);`,
    );

    const home = join(dir, ".tutti-agent-home");
    const detection = await detectCodex({
      command: "tutti-agent",
      defaultHomeDirName: ".tutti-agent",
      env: { PATH: dir, TUTTI_AGENT_HOME: home },
      homeEnvKey: "TUTTI_AGENT_HOME",
      probeAuthStatus: true,
    });

    expect(detection).toMatchObject({
      executablePath: tuttiAgentBin,
      version: "tutti-agent 0.0.1",
      configDir: home,
      skillsDir: join(home, "skills"),
      supported: true,
      authState: "missing",
    });
  });

  it("bounds Tutti Agent authentication probes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-tutti-auth-timeout-"));
    tempDirs.push(dir);
    const tuttiAgentBin = writeNodeCommand(
      dir,
      "tutti-agent",
      `if (process.argv[2] === "--version") { console.log("tutti-agent 0.0.1"); process.exit(0); }
if (process.argv[2] === "login") { setTimeout(() => {}, 10_000); } else { process.exit(1); }`,
    );

    const startedAt = Date.now();
    const detection = await detectCodex({
      authStatusTimeoutMs: 50,
      command: "tutti-agent",
      defaultHomeDirName: ".tutti-agent",
      env: { PATH: dir },
      homeEnvKey: "TUTTI_AGENT_HOME",
      probeAuthStatus: true,
    });

    expect(detection.authState).toBe("unknown");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("passes cwd and env through version and model discovery subprocesses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-direct-"));
    const cwd = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-direct-cwd-"));
    tempDirs.push(dir, cwd);
    const marker = "direct-detect-marker";
    const codexBin = writeNodeCommand(
      dir,
      "codex",
      `
const fs = require("node:fs");
const expectedCwd = fs.realpathSync(${JSON.stringify(cwd)});
const expectedMarker = ${JSON.stringify(marker)};
function ok() {
  return fs.realpathSync(process.cwd()) === expectedCwd &&
    process.env.APP_TEST_MARKER === expectedMarker;
}
if (process.argv[2] === "--version") {
  if (!ok()) process.exit(9);
  console.log("codex 1.2.3");
  process.exit(0);
}
if (process.argv[2] === "app-server") {
  if (!ok()) process.exit(9);
  process.exit(1);
}
if (process.argv[2] === "debug" && process.argv[3] === "models") {
  if (!ok()) process.exit(9);
  console.log(JSON.stringify({ models: [{ slug: "direct-model", display_name: "Direct Model" }] }));
  process.exit(0);
}
process.exit(1);
`,
    );

    const detection = await detectCodex({
      cwd,
      env: {
        PATH: dir,
        CODEX_HOME: join(dir, ".codex-home"),
        APP_TEST_MARKER: marker,
      },
    });

    expect(detection).toMatchObject({
      executablePath: codexBin,
      supported: true,
      version: "codex 1.2.3",
    });
    expect(detection.models).toEqual([
      { id: "default", label: "Default (CLI config)" },
      { id: "direct-model", label: "Direct Model" },
    ]);
  });

  it("redacts configured secrets from version failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-redact-"));
    tempDirs.push(dir);
    const secret = "configured-redact-secret";
    const codexBin = writeNodeCommand(
      dir,
      "codex",
      `
if (process.argv[2] === "--version") {
  process.stderr.write("failed with " + process.env.APP_TEST_SECRET);
  process.exit(9);
}
process.exit(1);
`,
    );

    const detection = await detectCodex({
      env: {
        PATH: dir,
        CODEX_HOME: join(dir, ".codex-home"),
        APP_TEST_SECRET: secret,
      },
      redactionSecrets: [secret],
    });

    expect(detection).toMatchObject({
      supported: false,
      version: "unknown",
    });
    expect(detection.unsupportedReason).toContain("[REDACTED]");
    expect(detection.unsupportedReason).not.toContain(secret);
  });

  it("discovers Codex models from the debug catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-models-"));
    tempDirs.push(dir);
    const codexBin = writeNodeCommand(
      dir,
      "codex",
      `if (process.argv[2] === "--version") { console.log("codex 1.2.3"); process.exit(0); }
if (process.argv[2] === "debug" && process.argv[3] === "models") {
  console.log(JSON.stringify({ models: [
    { slug: "gpt-live", display_name: "GPT Live", visibility: "list" },
    { slug: "codex-hidden", display_name: "Hidden", visibility: "hide" },
  ] }));
  process.exit(0);
}
process.exit(1);
`,
    );

    const detection = await detectCodex({
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex-home") },
    });

    expect(detection.models).toEqual([
      { id: "default", label: "Default (CLI config)" },
      { id: "gpt-live", label: "GPT Live" },
    ]);
  });

  it("prefers Codex app-server model/list over the debug catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-app-server-"));
    tempDirs.push(dir);
    const codexBin = writeNodeCommand(
      dir,
      "codex",
      `
const readline = require("node:readline");
if (process.argv[2] === "--version") {
  console.log("codex 1.2.3");
  process.exit(0);
}
if (process.argv[2] === "app-server") {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      console.log(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === "model/list") {
      console.log(JSON.stringify({
        id: message.id,
        result: {
          data: [
            {
              id: "gpt-5.3-codex",
              displayName: "gpt-5.3-codex",
              description: "Coding-optimized model.",
              hidden: false,
              isDefault: true,
              upgrade: "gpt-5.4"
            },
            { id: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier", hidden: false },
            {
              id: "gpt-5.2",
              displayName: "gpt-5.2",
              description: "Optimized for professional work and long-running agents.",
              hidden: false,
              upgrade: "gpt-5.4"
            },
            { id: "gpt-5.4", displayName: "GPT-5.4", hidden: false, upgrade: "gpt-5.5" },
            { id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", hidden: false },
            { id: "hidden", displayName: "Hidden", hidden: true }
          ]
        }
      }));
      process.exit(0);
    }
  });
} else if (process.argv[2] === "debug" && process.argv[3] === "models") {
  console.log(JSON.stringify({ models: [{ slug: "debug-only", display_name: "Debug Only" }] }));
} else {
  process.exit(1);
}
`,
    );

    const detection = await detectCodex({
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex-home") },
    });

    expect(detection.models).toEqual([
      { id: "default", label: "Default (CLI config)" },
      { id: "gpt-5.5", label: "GPT-5.5", description: "Frontier" },
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    ]);
  });

  it("does not expose bundled Codex catalog entries when refreshed discovery fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-bundled-models-"));
    tempDirs.push(dir);
    const codexBin = writeNodeCommand(
      dir,
      "codex",
      `if (process.argv[2] === "--version") { console.log("codex 1.2.3"); process.exit(0); }
if (process.argv[2] === "debug" && process.argv[3] === "models" && process.argv[4] === "--bundled") {
  console.log(JSON.stringify({ models: [{ slug: "gpt-bundled", display_name: "GPT Bundled", visibility: "list" }] }));
  process.exit(0);
}
process.exit(1);
`,
    );

    const detection = await detectCodex({
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex-home") },
    });

    expect(detection.models).toEqual([
      { id: "default", label: "Default (CLI config)" },
    ]);
  });
});
