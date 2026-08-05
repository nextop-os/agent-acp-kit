import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCodexProvider,
  createLocalAgentRuntime,
  type AgentEvent,
} from "../../src/index.js";
import { writeNodeCommand } from "../helpers/node-command.js";

async function createFakeCodexBin() {
  const binDir = await mkdtemp(join(tmpdir(), "agent-acp-kit-fake-codex-"));
  const codexBin = writeNodeCommand(
    binDir,
    "codex",
    `
const fs = require("node:fs");
const path = require("node:path");

if (process.argv[2] === "--version") {
  console.log("codex 1.2.3");
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const codexHome = process.env.CODEX_HOME;
  const logPath = process.env.FAKE_CODEX_LOG;
  if (!codexHome || !logPath) {
    process.stderr.write("missing fake codex env\\n");
    process.exit(2);
  }

  const sessionsRoot = path.join(codexHome, "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ args, codexHome, prompt: input }) + "\\n");

  const isResume = args[0] === "exec" && args[1] === "resume";
  if (isResume) {
    const resumeId = args[args.length - 2];
    const sessionPath = path.join(sessionsRoot, resumeId + ".jsonl");
    if (!fs.existsSync(sessionPath)) {
      process.stderr.write("No session found with id " + resumeId + "\\n");
      process.exit(1);
    }
    fs.appendFileSync(sessionPath, "resumed\\n");
    console.log(JSON.stringify({ type: "thread.started", thread: { id: resumeId } }));
    if (process.env.FAKE_CODEX_FAIL_AFTER_STARTED === "1") {
      process.stderr.write("resume failed after thread started\\n");
      process.exit(1);
    }
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "resumed:" + resumeId } }));
    process.exit(0);
  }

  if (args[0] !== "exec") {
    process.stderr.write("unexpected codex args: " + args.join(" ") + "\\n");
    process.exit(2);
  }

  const sessionId = process.env.FAKE_CODEX_SESSION_ID || "fresh-session";
  fs.writeFileSync(path.join(sessionsRoot, sessionId + ".jsonl"), "fresh\\n");
  console.log(JSON.stringify({ type: "thread.started", thread: { id: sessionId } }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fresh:" + sessionId } }));
  process.exit(0);
});
`,
  );
  return { binDir, codexBin };
}

async function createCodexHome() {
  const sourceHome = await mkdtemp(join(tmpdir(), "agent-acp-kit-codex-home-"));
  await writeFile(
    join(sourceHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "test-key" }),
    "utf8",
  );
  return sourceHome;
}

async function readJsonl(path: string) {
  const data = await readFile(path, "utf8");
  return data
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; codexHome: string; prompt: string });
}

describe("Codex runtime native resume", () => {
  it("runs fresh with history and persists the new Codex session under the source home", async () => {
    const { binDir } = await createFakeCodexBin();
    const sourceHome = await createCodexHome();
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-codex-cwd-"));
    const logPath = join(sourceHome, "calls.jsonl");

    try {
      const runtime = createLocalAgentRuntime({ providers: [createCodexProvider()] });
      const events: AgentEvent[] = [];
      for await (const event of runtime.run({
        runId: "codex-fresh",
        provider: "codex",
        cwd,
        prompt: "continue fresh",
        history: [
          { role: "user", content: "previous user message" },
          { role: "assistant", content: "previous assistant answer" },
        ],
        env: {
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          CODEX_HOME: sourceHome,
          FAKE_CODEX_LOG: logPath,
          FAKE_CODEX_SESSION_ID: "fresh-1",
        },
      })) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: "text_delta", text: "fresh:fresh-1" });
      expect(events).toContainEqual({
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "fresh-1",
      });
      await expect(readFile(join(sourceHome, "sessions", "fresh-1.jsonl"), "utf8")).resolves.toBe(
        "fresh\n",
      );

      const calls = await readJsonl(logPath);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args.slice(0, 2)).toEqual(["exec", "--json"]);
      expect(calls[0]!.args).not.toContain("resume");
      expect(calls[0]!.prompt).toContain("Conversation history:");
      expect(calls[0]!.prompt).toContain("User:\nprevious user message");
      expect(calls[0]!.prompt).toContain("Assistant:\nprevious assistant answer");
      expect(calls[0]!.prompt).toContain("Current request:\n\ncontinue fresh");
    } finally {
      await rm(binDir, { recursive: true, force: true });
      await rm(sourceHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses native resume with history when the Codex session exists in the source home", async () => {
    const { binDir } = await createFakeCodexBin();
    const sourceHome = await createCodexHome();
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-codex-cwd-"));
    const logPath = join(sourceHome, "calls.jsonl");

    try {
      await mkdir(join(sourceHome, "sessions"), { recursive: true });
      await writeFile(join(sourceHome, "sessions", "resume-1.jsonl"), "seed\n", "utf8");

      const runtime = createLocalAgentRuntime({ providers: [createCodexProvider()] });
      const events: AgentEvent[] = [];
      for await (const event of runtime.run({
        runId: "codex-resume",
        provider: "codex",
        cwd,
        prompt: "continue native resume",
        history: [{ role: "user", content: "message passed to resumed turn" }],
        resume: { mode: "provider", providerSessionId: "resume-1" },
        env: {
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          CODEX_HOME: sourceHome,
          FAKE_CODEX_LOG: logPath,
        },
      })) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: "text_delta", text: "resumed:resume-1" });
      expect(events).toContainEqual({
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "resume-1",
      });
      await expect(readFile(join(sourceHome, "sessions", "resume-1.jsonl"), "utf8")).resolves.toBe(
        "seed\nresumed\n",
      );

      const calls = await readJsonl(logPath);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
      expect(calls[0]!.args).toContain("resume-1");
      expect(calls[0]!.prompt).toContain("User:\nmessage passed to resumed turn");
      expect(calls[0]!.prompt).toContain("Current request:\n\ncontinue native resume");
    } finally {
      await rm(binDir, { recursive: true, force: true });
      await rm(sourceHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to a fresh Codex run when the requested native session is missing", async () => {
    const { binDir } = await createFakeCodexBin();
    const sourceHome = await createCodexHome();
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-codex-cwd-"));
    const logPath = join(sourceHome, "calls.jsonl");

    try {
      const runtime = createLocalAgentRuntime({ providers: [createCodexProvider()] });
      const events: AgentEvent[] = [];
      for await (const event of runtime.run({
        runId: "codex-resume-missing",
        provider: "codex",
        cwd,
        prompt: "continue after missing session",
        history: [{ role: "user", content: "history survives retry" }],
        resume: { mode: "provider", providerSessionId: "missing-session" },
        env: {
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          CODEX_HOME: sourceHome,
          FAKE_CODEX_LOG: logPath,
          FAKE_CODEX_SESSION_ID: "fresh-after-missing",
        },
      })) {
        events.push(event);
      }

      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "error", code: "process_exit_nonzero" }),
      );
      expect(events).toContainEqual({ type: "text_delta", text: "fresh:fresh-after-missing" });
      expect(events).toContainEqual({
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "fresh-after-missing",
      });
      await expect(
        readFile(join(sourceHome, "sessions", "fresh-after-missing.jsonl"), "utf8"),
      ).resolves.toBe("fresh\n");

      const calls = await readJsonl(logPath);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
      expect(calls[0]!.args).toContain("missing-session");
      expect(calls[1]!.args.slice(0, 2)).toEqual(["exec", "--json"]);
      expect(calls[1]!.args).toContain("-C");
      expect(calls[1]!.prompt).toContain("User:\nhistory survives retry");
      expect(calls[1]!.prompt).toContain("Current request:\n\ncontinue after missing session");
    } finally {
      await rm(binDir, { recursive: true, force: true });
      await rm(sourceHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not fresh fallback after a resumed Codex thread has already started", async () => {
    const { binDir } = await createFakeCodexBin();
    const sourceHome = await createCodexHome();
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-codex-cwd-"));
    const logPath = join(sourceHome, "calls.jsonl");

    try {
      await mkdir(join(sourceHome, "sessions"), { recursive: true });
      await writeFile(join(sourceHome, "sessions", "started-then-failed.jsonl"), "seed\n", "utf8");

      const runtime = createLocalAgentRuntime({ providers: [createCodexProvider()] });
      const events: AgentEvent[] = [];
      for await (const event of runtime.run({
        runId: "codex-resume-started-then-failed",
        provider: "codex",
        cwd,
        prompt: "continue native resume",
        history: [{ role: "user", content: "do not retry after start" }],
        resume: { mode: "provider", providerSessionId: "started-then-failed" },
        env: {
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          CODEX_HOME: sourceHome,
          FAKE_CODEX_LOG: logPath,
          FAKE_CODEX_FAIL_AFTER_STARTED: "1",
          FAKE_CODEX_SESSION_ID: "should-not-be-created",
        },
      })) {
        events.push(event);
      }

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "error",
          code: "process_exit_nonzero",
        }),
      );
      expect(events).toContainEqual({
        type: "done",
        status: "failed",
        reason: "error",
        exitCode: 1,
        sessionId: "started-then-failed",
      });
      await expect(
        readFile(join(sourceHome, "sessions", "should-not-be-created.jsonl"), "utf8"),
      ).rejects.toThrow();

      const calls = await readJsonl(logPath);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
      expect(calls[0]!.args).toContain("started-then-failed");
    } finally {
      await rm(binDir, { recursive: true, force: true });
      await rm(sourceHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
