import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWindowsBatchCommand } from "../../src/process/windows-batch.js";

describe("resolveWindowsBatchCommand", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("resolves an absolute extensionless npm launcher to its cmd shim", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-batch-"));
    tempDirs.push(dir);
    const launcher = join(dir, "claude");
    const node = join(dir, "node.exe");
    const cliPath = join(dir, "cli.js");
    writeFileSync(node, "");
    writeFileSync(cliPath, "");
    writeFileSync(`${launcher}.cmd`, `@"${node}" "${cliPath}" %*\r\n`);
    chmodSync(`${launcher}.cmd`, 0o755);

    expect(
      resolveWindowsBatchCommand(launcher, ["--version"], "win32"),
    ).toMatchObject({
      command: node,
      args: [cliPath, "--version"],
    });
  });

  it("rejects a conditional command line instead of treating its probe as argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-batch-conditional-"));
    tempDirs.push(dir);
    const shim = join(dir, "unsafe.cmd");
    const node = join(dir, "node.exe");
    const cliPath = join(dir, "cli.js");
    writeFileSync(node, "");
    writeFileSync(cliPath, "");
    writeFileSync(shim, `IF EXIST "${node}" ("${node}" "${cliPath}" %*)\r\n`);

    expect(() =>
      resolveWindowsBatchCommand(shim, ["--version"], "win32"),
    ).toThrow("Unsupported Windows batch shim");
  });

  it("resolves the canonical npm shim through its colocated node executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent acp kit npm shim "));
    tempDirs.push(dir);
    const shim = join(dir, "codex.cmd");
    const node = join(dir, "node.exe");
    const cliPath = join(dir, "node_modules", "codex", "cli.js");
    mkdirSync(dirname(cliPath), { recursive: true });
    writeFileSync(node, "");
    writeFileSync(cliPath, "");
    writeFileSync(
      shim,
      `@ECHO off\r\nSETLOCAL\r\nSET "_prog=%~dp0\\node.exe"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "${cliPath}" %*\r\n`,
    );

    expect(
      resolveWindowsBatchCommand(shim, ["--version"], "win32"),
    ).toMatchObject({
      command: node,
      args: [cliPath, "--version"],
    });
  });

  it("resolves a strict Tutti-managed batch forwarder without invoking cmd.exe", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-tutti-forwarder-"));
    tempDirs.push(dir);
    const managedDir = join(dir, "managed runtime");
    mkdirSync(managedDir, { recursive: true });
    const forwarder = join(dir, "claude.cmd");
    const targetShim = join(managedDir, "claude.cmd");
    const node = join(managedDir, "node.exe");
    const cliPath = join(managedDir, "cli.js");
    writeFileSync(node, "");
    writeFileSync(cliPath, "");
    writeFileSync(targetShim, `@"${node}" "${cliPath}" %*\r\n`);
    writeFileSync(
      forwarder,
      `@echo off\r\nrem Tutti managed agent command v1\r\ncall "${targetShim}" %*\r\nexit /b %errorlevel%\r\n`,
    );

    expect(
      resolveWindowsBatchCommand(forwarder, ["--version"], "win32"),
    ).toMatchObject({
      command: node,
      args: [cliPath, "--version"],
    });
  });

  it("rejects recursive and compound batch forwarders", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-batch-forwarder-unsafe-"));
    tempDirs.push(dir);
    const recursive = join(dir, "recursive.cmd");
    const compound = join(dir, "compound.cmd");
    writeFileSync(recursive, `call "${recursive}" %*\r\n`);
    writeFileSync(compound, `call "${recursive}" %* & echo unsafe\r\n`);

    expect(() =>
      resolveWindowsBatchCommand(recursive, [], "win32"),
    ).toThrow("Unsupported Windows batch shim");
    expect(() => resolveWindowsBatchCommand(compound, [], "win32")).toThrow(
      "Unsupported Windows batch shim",
    );
  });

  it("rejects PowerShell command-string launchers", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-powershell-command-"));
    tempDirs.push(dir);
    const powershell = join(dir, "powershell.exe");
    const shim = join(dir, "unsafe.cmd");
    writeFileSync(powershell, "");
    writeFileSync(
      shim,
      `"${powershell}" -NoProfile -Command "& { run-agent @args }" %*\r\n`,
    );

    expect(() =>
      resolveWindowsBatchCommand(shim, ["a&b"], "win32"),
    ).toThrow("Unsupported Windows batch shim");
  });

  it.each([
    ["cmd.exe", "/c run-agent"],
    ["pwsh.exe", '-NoProfile -Command "run-agent"'],
  ])("rejects shell-interpreter launchers through %s", (shellName, prefix) => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-shell-command-"));
    tempDirs.push(dir);
    const shell = join(dir, shellName);
    const shim = join(dir, "unsafe.cmd");
    writeFileSync(shell, "");
    writeFileSync(shim, `"${shell}" ${prefix} %*\r\n`);

    expect(() =>
      resolveWindowsBatchCommand(shim, ["a&b"], "win32"),
    ).toThrow("Unsupported Windows batch shim");
  });

  it.runIf(process.platform === "win32")(
    "resolves a PowerShell file launcher without invoking cmd.exe",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-powershell-shim-"));
      tempDirs.push(dir);
      const systemRoot = join(dir, "Windows");
      const powershell = join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const shim = join(dir, "cursor-agent.cmd");
      const script = join(dir, "cursor-agent.ps1");
      mkdirSync(dirname(powershell), { recursive: true });
      writeFileSync(powershell, "");
      writeFileSync(script, "");
      writeFileSync(
        shim,
        `@echo off\r\nset "CURSOR_INVOKED_AS=%~nx0"\r\nset "SCRIPT_DIR=%~dp0"\r\n%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*\r\n`,
      );

      expect(
        resolveWindowsBatchCommand(shim, ["--version"], "win32", {
          env: { SystemRoot: systemRoot },
        }),
      ).toMatchObject({
        command: powershell,
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "--version",
        ],
        env: { CURSOR_INVOKED_AS: "cursor-agent.cmd" },
      });
    },
  );
});
