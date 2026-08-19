import { describe, expect, it } from "vitest";

import { detectAcpModels } from "../../src/transports/acp/acp-models.js";
import {
  resolveAcpRequestTimeoutMs,
  runAcpTransport,
} from "../../src/transports/acp/acp-client.js";
import { createFakeAcpPeerScript } from "../../src/testing/index.js";

describe("resolveAcpRequestTimeoutMs", () => {
  it("uses lifecycle-specific defaults and preserves explicit overrides", () => {
    expect(resolveAcpRequestTimeoutMs("initialize")).toBe(15_000);
    expect(resolveAcpRequestTimeoutMs("session/new")).toBe(30_000);
    expect(resolveAcpRequestTimeoutMs("session/prompt")).toBe(3 * 60_000);
    expect(resolveAcpRequestTimeoutMs("session/new", 5_000, 10_000)).toBe(
      5_000,
    );
    expect(resolveAcpRequestTimeoutMs("session/new", undefined, 10_000)).toBe(
      10_000,
    );
  });
});

describe("runAcpTransport", () => {
  it("keeps successful ACP stderr diagnostic-only", async () => {
    const events = [];
    const script = createFakeAcpPeerScript({
      updates: [{ type: "text_delta", text: "ready" }],
    });

    for await (const event of runAcpTransport(
      {
        args: [
          "-e",
          `process.stderr.write("internal ACP diagnostic\\n");${script}`,
        ],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "hello",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        prompt: "hello",
        runId: "run_acp_stderr",
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "ready" },
      {
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "session_fake",
      },
    ]);
  });

  it("discovers ACP models from session/new", async () => {
    const script = createFakeAcpPeerScript({
      currentModelId: "kimi-k2",
      models: [
        { modelId: "kimi-k2", name: "Kimi K2" },
        { modelId: "kimi-k2-thinking" },
      ],
      updates: [],
    });

    await expect(
      detectAcpModels({
        args: ["-e", script],
        bin: process.execPath,
        cwd: process.cwd(),
      }),
    ).resolves.toEqual([
      { id: "default", label: "Default (CLI config)" },
      { id: "kimi-k2", label: "Kimi K2 (kimi-k2) (current)" },
      { id: "kimi-k2-thinking", label: "kimi-k2-thinking" },
    ]);
  });

  it("includes redacted stderr when ACP model discovery exits early", async () => {
    const secret = "acp-model-secret";

    await expect(
      detectAcpModels({
        args: [
          "-e",
          `process.stderr.write("model probe failed: ${secret}"); setTimeout(() => process.exit(7), 10);`,
        ],
        bin: process.execPath,
        cwd: process.cwd(),
        redactionSecrets: [secret],
      }),
    ).rejects.toThrow(
      "ACP model detection exited with code 7. stderr: model probe failed: [REDACTED]",
    );
  });

  it("maps ACP session updates into normalized agent events", async () => {
    const events = [];
    const script = createFakeAcpPeerScript({
      updates: [
        {
          sessionUpdate: "text_delta",
          content: { type: "text", text: "hello" },
        },
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thought" },
        },
        {
          sessionUpdate: "reasoning_delta",
          content: { type: "text", text: "thinking" },
        },
        {
          type: "tool_call",
          id: "tool_1",
          name: "generate_image",
          input: { prompt: "x" },
        },
        {
          type: "tool_result",
          id: "tool_1",
          name: "generate_image",
          output: { imageUrl: "https://example.com/image.png" },
        },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      ],
    });

    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "make image",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        prompt: "make image",
        runId: "run_acp",
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "thinking", text: "thought" },
      { type: "thinking_delta", text: "thinking" },
      {
        type: "tool_call",
        id: "tool_1",
        name: "generate_image",
        input: { prompt: "x" },
      },
      {
        type: "tool_result",
        id: "tool_1",
        name: "generate_image",
        status: "completed",
        output: { imageUrl: "https://example.com/image.png" },
      },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      {
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "session_fake",
      },
    ]);
  });

  it("coalesces standard ACP tool_call updates into one call and one result", async () => {
    const events = [];
    const script = createFakeAcpPeerScript({
      updates: [
        {
          sessionUpdate: "tool_call",
          toolCallId: "call_read_1",
          title: "Read /tmp/SKILL.md",
          kind: "read",
          status: "pending",
          rawInput: {},
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_read_1",
          status: "in_progress",
          rawInput: { filePath: "/tmp/SKILL.md" },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_read_1",
          title: "/tmp/SKILL.md",
          status: "completed",
          rawOutput: { output: "# Skill" },
        },
      ],
    });

    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "read skill",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        prompt: "read skill",
        runId: "run_acp_standard_tool",
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_read_1",
        name: "read",
        input: {},
      },
      {
        type: "tool_result",
        id: "call_read_1",
        name: "read",
        status: "completed",
        output: { output: "# Skill" },
      },
      {
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "session_fake",
      },
    ]);
  });

  it("uses an MCP tool title instead of the generic ACP other kind", async () => {
    const events = [];
    const script = createFakeAcpPeerScript({
      updates: [
        {
          sessionUpdate: "tool_call",
          toolCallId: "call_mcp_1",
          title: "validation_echo",
          kind: "other",
          status: "pending",
          rawInput: { value: "probe" },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_mcp_1",
          status: "completed",
          rawOutput: { output: "echo:probe" },
        },
      ],
    });

    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "call MCP",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        prompt: "call MCP",
        runId: "run_acp_mcp_title",
      },
    ))
      events.push(event);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          id: "call_mcp_1",
          name: "validation_echo",
        }),
        expect.objectContaining({
          type: "tool_result",
          id: "call_mcp_1",
          name: "validation_echo",
          status: "completed",
        }),
      ]),
    );
  });

  it("forwards MCP servers through session/new and reclaims a long-lived ACP peer", async () => {
    const script = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(143));
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ id: message.id, result: { ok: true } });
    } else if (message.method === "session/new") {
      const servers = message.params?.mcpServers;
      if (servers?.[0]?.type !== "stdio" ||
          servers[0]?.name !== "validation" ||
          servers[0]?.command !== "node" ||
          servers[0]?.args?.[0] !== "server.mjs" ||
          servers[0]?.env?.[0]?.name !== "TOKEN" ||
          servers[0]?.env?.[0]?.value !== "secret") {
        send({ id: message.id, error: { code: -32000, message: "invalid MCP forwarding" } });
        continue;
      }
      send({ id: message.id, result: { sessionId: "session-mcp" } });
    } else if (message.method === "session/prompt") {
      send({ method: "session/update", params: { sessionUpdate: "text_delta", content: { text: "MCP ready" } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
    const startedAt = Date.now();
    const events = [];
    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "call MCP",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        mcpServers: [
          {
            name: "validation",
            command: "node",
            args: ["server.mjs"],
            env: { TOKEN: "secret" },
          },
        ],
        prompt: "call MCP",
        runId: "run_acp_mcp_forwarding",
      },
    ))
      events.push(event);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(events).toEqual([
      { type: "text_delta", text: "MCP ready" },
      {
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "session-mcp",
      },
    ]);
  });

  it("waits for lifecycle acknowledgements and sets model before prompt", async () => {
    const events = [];
    const script = createFakeAcpPeerScript({
      expectedMethods: [
        "initialize",
        "session/new",
        "session/set_config_option",
        "session/prompt",
      ],
      sessionId: "session_model",
      updates: [{ type: "text_delta", text: "model ready" }],
    });

    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "make image",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        model: "kimi-k2",
        prompt: "make image",
        runId: "run_acp_model",
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "model ready" },
      {
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "session_model",
      },
    ]);
  });

  it("uses ACP capabilities, model fallback, prompt content, and permission result shape", async () => {
    const script = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
let promptRequestId;
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}
function fail(message) {
  send({ method: "session/update", params: { type: "error", error: message } });
  process.exit(2);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (message.params?.clientCapabilities?.fs?.readTextFile !== false ||
          message.params?.clientCapabilities?._meta?.terminal_output !== true) {
        fail("invalid client capabilities");
        return;
      }
      send({ id: message.id, result: { ok: true } });
    } else if (message.method === "session/new") {
      send({ id: message.id, result: { sessionId: "session-fallback" } });
    } else if (message.method === "session/set_config_option") {
      send({ id: message.id, error: { code: -32601, message: "unsupported" } });
    } else if (message.method === "session/set_model") {
      if (message.params?.modelId !== "model-x") {
        fail("missing modelId");
        return;
      }
      send({ id: message.id, result: { ok: true } });
    } else if (message.method === "session/prompt") {
      if (!Array.isArray(message.params?.prompt) || message.params.prompt[0]?.text !== "hello") {
        fail("prompt is not ACP content");
        return;
      }
      promptRequestId = message.id;
      send({
        id: 99,
        method: "session/request_permission",
        params: { options: [{ optionId: "allow" }] },
      });
    } else if (message.id === 99) {
      if (message.result?.outcome?.outcome !== "selected" ||
          message.result?.outcome?.optionId !== "allow") {
        fail("invalid permission response");
        return;
      }
      send({ method: "session/update", params: { sessionUpdate: "text_delta", content: { text: "ok" } } });
      send({ id: promptRequestId, result: { stopReason: "end_turn" } });
      setTimeout(() => process.exit(0), 5);
    }
  }
});
`;
    const events = [];
    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "hello",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        model: "model-x",
        permission: { semantic: "full-access" },
        prompt: "hello",
        runId: "run_acp_fallback",
      },
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      {
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "session-fallback",
      },
    ]);
  });

  it("rejects a malformed ACP session/new response before model selection", async () => {
    const script = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
setInterval(() => {}, 1000);
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ id: message.id, result: { ok: true } });
    } else if (message.method === "session/new") {
      send({ id: message.id, result: { ok: true } });
    }
  }
});
`;
    const events = [];
    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "hello",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        model: "model-x",
        prompt: "hello",
        runId: "run_acp_missing_session",
      },
    ))
      events.push(event);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          code: "acp_lifecycle_failed",
          message: "ACP session/new did not return a sessionId.",
        }),
        expect.objectContaining({ type: "done", status: "failed" }),
      ]),
    );
  });

  it("reports signal termination after prompt acknowledgement as canceled", async () => {
    const script = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
setInterval(() => {}, 1000);
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { ok: true } });
    if (message.method === "session/new") send({ id: message.id, result: { sessionId: "cancel-me" } });
    if (message.method === "session/prompt") {
      send({ id: message.id, result: { stopReason: "end_turn" } });
      send({ method: "session/update", params: { type: "text_delta", text: "abort-ready" } });
    }
  }
});
`;
    const controller = new AbortController();
    const events = [];
    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "hello",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        prompt: "hello",
        runId: "run_acp_abort_after_ack",
        signal: controller.signal,
      },
    )) {
      events.push(event);
      if (event.type === "text_delta" && event.text === "abort-ready") {
        controller.abort();
      }
    }

    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "canceled",
      reason: "cancelled",
      sessionId: "cancel-me",
    });
  });

  it("fails lifecycle requests promptly when the ACP peer exits before acknowledgement", async () => {
    const events = [];

    for await (const event of runAcpTransport(
      {
        args: ["-e", "process.exit(1)"],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "make image",
        promptInput: "stdin",
        timeoutMs: 5_000,
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        prompt: "make image",
        runId: "run_acp_exit",
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          code: "acp_lifecycle_failed",
        }),
        expect.objectContaining({
          type: "done",
          status: "failed",
        }),
      ]),
    );
  });
});
