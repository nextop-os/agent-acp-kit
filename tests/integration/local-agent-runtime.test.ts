import { describe, expect, it, vi } from "vitest";

import {
  createFakeProvider,
  createLocalAgentRuntime,
  type AgentEvent,
  type AgentRunParams,
  type LocalAgentProviderPlugin,
  type RawAgentStream,
  type Transport,
} from "../../src/index.js";

describe("createLocalAgentRuntime", () => {
  it("accepts provider aliases only at input and lists canonical ids", async () => {
    const permissions: AgentRunParams["permission"][] = [];
    const provider: LocalAgentProviderPlugin<"local-agent", "canonical"> = {
      id: "canonical",
      aliases: ["legacy"],
      displayName: "Canonical",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "canonical", version: "1" };
      },
      capabilities() {
        return { cancel: true, nativeResume: false };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run(params) {
        permissions.push(params.permission);
        yield { type: "done", status: "completed", sessionId: String(params.runtimeProvider) };
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [provider] });
    expect(runtime.listProviders()).toEqual([
      { id: "canonical", displayName: "Canonical", kind: "local-agent" },
    ]);

    const events: AgentEvent[] = [];
    for await (const event of runtime.run({
      runId: "alias-run",
      provider: "legacy" as "canonical",
      cwd: process.cwd(),
      prompt: "hello",
    })) {
      events.push(event);
    }
    expect(events[0]).toMatchObject({ type: "done", sessionId: "canonical" });
    expect(permissions).toEqual([{ semantic: "full-access" }]);
  });

  it("rejects duplicate provider ids and aliases during construction", () => {
    const base = createFakeProvider();
    expect(() => createLocalAgentRuntime({ providers: [base, base] })).toThrow(
      "Duplicate local agent provider id: fake",
    );
    expect(() =>
      createLocalAgentRuntime({
        providers: [
          { ...base, id: "one", aliases: ["shared"] },
          { ...base, id: "two", aliases: ["shared"] },
        ],
      }),
    ).toThrow("Duplicate local agent provider alias shared");
  });

  it("detects registered providers and streams normalized agent events", async () => {
    const runtime = createLocalAgentRuntime({
      providers: [
        createFakeProvider({
          events: [
            { type: "status", status: "running" },
            { type: "text_delta", text: "hello" },
            { type: "done", status: "completed" },
          ],
        }),
      ],
    });

    await expect(runtime.detect()).resolves.toMatchObject([
      {
        provider: "fake",
        displayName: "Fake Local Agent",
        authState: "ok",
        supported: true,
      },
    ]);

    const events: AgentEvent[] = [];
    for await (const event of runtime.run({
      runId: "run_1",
      provider: "fake",
      cwd: process.cwd(),
      prompt: "Say hello",
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "text_delta", text: "hello" },
      { type: "done", status: "completed", reason: "completed" },
    ]);
  });

  it("lets the default-runtime integration replace standalone detection", async () => {
    const provider = createFakeProvider();
    const providerDetect = vi.spyOn(provider, "detect");
    const runtime = createLocalAgentRuntime({
      providers: [provider],
      detectTuttiTargets: async () => [
        {
          agentTargetId: "team:fake",
          provider: "fake",
          displayName: "Team Fake",
          supported: true,
          authState: "ok",
          models: [{ id: "team-model", label: "Team Model" }],
          isDefault: true,
        },
      ],
    });

    await expect(runtime.detect()).resolves.toMatchObject([
      { agentTargetId: "team:fake", models: [{ id: "team-model" }] },
    ]);
    expect(providerDetect).not.toHaveBeenCalled();
  });

  it("resolves the autonomous permission default after Tutti preparation and preserves explicit permissions", async () => {
    const permissions: AgentRunParams["permission"][] = [];
    const provider: LocalAgentProviderPlugin<"local-agent", "fake"> = {
      ...createFakeProvider(),
      createAdapter: undefined,
      async *run(params) {
        permissions.push(params.permission);
        yield { type: "done", status: "completed" };
      },
    };
    const runtime = createLocalAgentRuntime({
      providers: [provider],
      prepareTuttiRun: async ({ run }) => ({ ...run, model: "managed-model" }),
    });

    for (const input of [
      {
        runId: "managed-default-permission",
        provider: "fake" as const,
        cwd: process.cwd(),
        prompt: "use the autonomous default",
      },
      {
        runId: "managed-explicit-permission",
        provider: "fake" as const,
        cwd: process.cwd(),
        prompt: "stay locked down",
        permission: { semantic: "locked-down" as const, modeId: "read-only" },
      },
    ]) {
      for await (const _event of runtime.run(input)) {
        // Drain the provider stream.
      }
    }

    expect(permissions).toEqual([
      { semantic: "full-access" },
      { semantic: "locked-down", modeId: "read-only" },
    ]);
  });

  it("cancels a run while Tutti composer preparation is still active", async () => {
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    let preparationSignal: AbortSignal | undefined;
    const provider = createFakeProvider();
    const providerRun = vi.spyOn(provider, "run");
    const runtime = createLocalAgentRuntime({
      providers: [provider],
      prepareTuttiRun: async ({ run }) => {
        preparationSignal = run.signal;
        preparationStarted();
        await new Promise<never>((_resolve, reject) => {
          run.signal?.addEventListener(
            "abort",
            () => reject(run.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const event of runtime.run({
        runId: "preparation-cancel",
        provider: "fake",
        cwd: process.cwd(),
        prompt: "wait",
      })) {
        events.push(event);
      }
    })();

    await started;
    await runtime.cancel("preparation-cancel");
    await consume;

    expect(preparationSignal?.aborted).toBe(true);
    expect(providerRun).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "done", status: "canceled", reason: "cancelled" }]);
  });

  it("passes direct cwd and the VM source Codex home to the provider", async () => {
    let received: AgentRunParams<"local-agent", "codex"> | undefined;
    const provider: LocalAgentProviderPlugin<"local-agent", "codex"> = {
      id: "codex",
      displayName: "Codex",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "codex", version: "1" };
      },
      capabilities() {
        return { cancel: true, nativeResume: true };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run(params) {
        received = params;
        yield { type: "done", status: "completed" };
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [provider] });

    for await (const _event of runtime.run({
      runId: "direct-run",
      provider: "codex",
      cwd: "/workspace/project",
      prompt: "hello",
      env: {
        CODEX_HOME: "/home/tsh-runtime/.codex",
        TMPDIR: "/workspace/.tsh/apps/runtimes/runtime-1/tmp",
      },
    })) {
      // Drain the provider stream.
    }

    expect(received).toMatchObject({
      cwd: "/workspace/project",
      env: {
        CODEX_HOME: "/home/tsh-runtime/.codex",
        TMPDIR: "/workspace/.tsh/apps/runtimes/runtime-1/tmp",
      },
    });
  });

  it("forwards cancellation to the active provider", async () => {
    let release: (() => void) | undefined;
    const cancel = vi.fn();
    const provider: LocalAgentProviderPlugin<"local-agent", "cancelable"> = {
      id: "cancelable",
      displayName: "Cancelable",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "cancelable", version: "1" };
      },
      capabilities() {
        return { cancel: true, nativeResume: false };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      cancel,
      async *run() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { type: "done", status: "completed" };
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [provider] });
    const consume = (async () => {
      for await (const _event of runtime.run({
        runId: "cancel-run",
        provider: "cancelable",
        cwd: process.cwd(),
        prompt: "wait",
      })) {
        // Drain.
      }
    })();

    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await runtime.cancel("cancel-run");
    release?.();
    await consume;
    expect(cancel).toHaveBeenCalledWith("cancel-run");
  });

  it("forwards cancellation to the active transport handle", async () => {
    const cancel = vi.fn();
    let transportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      transportStarted = resolve;
    });
    const provider: LocalAgentProviderPlugin<"local-agent", "transport-cancel"> = {
      id: "transport-cancel",
      displayName: "Transport Cancel Provider",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "transport-cancel", version: "1.0.0" };
      },
      capabilities() {
        return { cancel: true, nativeResume: false };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      createAdapter() {
        return {
          async buildLaunchPlan(params) {
            return {
              args: [],
              command: "transport-cancel",
              cwd: params.cwd,
              prompt: params.prompt,
              promptInput: "stdin",
              transport: "plain",
            };
          },
          capabilities: () => provider.capabilities(),
          parseEvents: async function* (stream: RawAgentStream) {
            for await (const item of stream) yield item as AgentEvent;
          },
        };
      },
      async *run() {
        throw new Error("not used");
      },
    };
    const transport: Transport = {
      kind: "plain",
      run() {
        transportStarted();
        return Object.assign(
          (async function* () {
            await new Promise((resolve) => setTimeout(resolve, 50));
            yield { type: "done", status: "completed" };
          })(),
          { cancel },
        );
      },
    };

    const runtime = createLocalAgentRuntime({ providers: [provider], transports: [transport] });
    const first = runtime
      .run({
        runId: "run_transport_cancel",
        provider: "transport-cancel",
        cwd: process.cwd(),
        prompt: "wait",
      })
      .next();

    await started;
    await runtime.cancel("run_transport_cancel");
    await first.catch(() => undefined);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("isolates provider detection failures and caches successful results", async () => {
    const detectOk = vi.fn(async () => ({
      authState: "ok" as const,
      executablePath: "ok",
      version: "1.0.0",
    }));
    const okProvider: LocalAgentProviderPlugin<"local-agent", "ok"> = {
      id: "ok",
      displayName: "OK Provider",
      kind: "local-agent",
      detect: detectOk,
      capabilities() {
        return { cancel: true, nativeResume: false };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run() {
        throw new Error("not used");
      },
    };
    const badProvider: LocalAgentProviderPlugin<"local-agent", "bad"> = {
      ...okProvider,
      id: "bad",
      displayName: "Bad Provider",
      async detect() {
        throw new Error("boom");
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [okProvider, badProvider] });

    await expect(runtime.detect()).resolves.toMatchObject([
      { provider: "ok", authState: "ok", supported: true },
      { provider: "bad", authState: "unknown", supported: false },
    ]);
    await runtime.detect();
    expect(detectOk).toHaveBeenCalledTimes(1);
    await runtime.detect({ refresh: true });
    expect(detectOk).toHaveBeenCalledTimes(2);
  });

  it("runs provider adapters through the transport pipeline", async () => {
    let adapterParams: AgentRunParams<"local-agent", "pipe"> | undefined;
    let transportPlan: Parameters<Transport["run"]>[0] | undefined;
    const provider: LocalAgentProviderPlugin<"local-agent", "pipe"> = {
      id: "pipe",
      displayName: "Pipeline",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "pipe", version: "1" };
      },
      capabilities() {
        return { cancel: true, nativeResume: false };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      createAdapter() {
        return {
          async buildLaunchPlan(params) {
            adapterParams = params;
            return {
              args: [],
              command: "pipe",
              cwd: params.cwd,
              prompt: params.prompt,
              promptInput: "stdin",
              transport: "plain",
            };
          },
          capabilities: () => provider.capabilities(),
          parseEvents: async function* (stream: RawAgentStream) {
            for await (const item of stream) yield item as AgentEvent;
          },
        };
      },
      async *run() {
        throw new Error("not used");
      },
    };
    const runtime = createLocalAgentRuntime({
      providers: [provider],
      transports: [
        {
          kind: "plain",
          async *run(plan) {
            transportPlan = plan;
            yield { type: "done", status: "completed" };
          },
        },
      ],
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run({
      runId: "pipeline-run",
      provider: "pipe",
      cwd: "/workspace/project",
      prompt: "hello",
    })) {
      events.push(event);
    }
    expect(adapterParams?.cwd).toBe("/workspace/project");
    expect(transportPlan?.cwd).toBe("/workspace/project");
    expect(events).toEqual([{ type: "done", status: "completed", reason: "completed" }]);
  });

  it("disposes an adapter when transport setup throws", async () => {
    const dispose = vi.fn(async () => undefined);
    const provider: LocalAgentProviderPlugin<"local-agent", "dispose-setup"> = {
      id: "dispose-setup",
      displayName: "Dispose Setup",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "dispose-setup", version: "1" };
      },
      capabilities: () => ({ cancel: true, nativeResume: false }),
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      createAdapter() {
        return {
          async buildLaunchPlan(params) {
            return {
              args: [],
              command: "dispose-setup",
              cwd: params.cwd,
              prompt: params.prompt,
              promptInput: "stdin",
              transport: "missing" as "plain",
            };
          },
          capabilities: () => provider.capabilities(),
          parseEvents: async function* () {},
          dispose,
        };
      },
      async *run() {
        throw new Error("not used");
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [provider] });

    await expect(
      (async () => {
        for await (const _event of runtime.run({
          runId: "dispose-setup-run",
          provider: "dispose-setup",
          cwd: process.cwd(),
          prompt: "hello",
        })) {
          // Drain.
        }
      })(),
    ).rejects.toThrow("No local agent transport registered for missing");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes an adapter when the consumer stops early", async () => {
    const dispose = vi.fn(async () => undefined);
    const provider: LocalAgentProviderPlugin<"local-agent", "dispose-early"> = {
      id: "dispose-early",
      displayName: "Dispose Early",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "dispose-early", version: "1" };
      },
      capabilities: () => ({ cancel: true, nativeResume: false }),
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      createAdapter() {
        return {
          async buildLaunchPlan(params) {
            return {
              args: [],
              command: "dispose-early",
              cwd: params.cwd,
              prompt: params.prompt,
              promptInput: "stdin",
              transport: "plain",
            };
          },
          capabilities: () => provider.capabilities(),
          parseEvents: async function* (stream) {
            for await (const item of stream) yield item as AgentEvent;
          },
          dispose,
        };
      },
      async *run() {
        throw new Error("not used");
      },
    };
    const transport: Transport = {
      kind: "plain",
      async *run() {
        yield { type: "text_delta", text: "first" };
        yield { type: "done", status: "completed" };
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [provider], transports: [transport] });
    const stream = runtime.run({
      runId: "dispose-early-run",
      provider: "dispose-early",
      cwd: process.cwd(),
      prompt: "hello",
    });

    await expect(stream.next()).resolves.toMatchObject({ value: { type: "text_delta" } });
    await stream.return(undefined);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("emits opt-in provider preparation and execution timing diagnostics", async () => {
    const provider = createFakeProvider({
      events: [
        { type: "text_delta", text: "hello" },
        { type: "tool_call", id: "tool-1", name: "read" },
        { type: "done", status: "completed" },
      ],
    });
    const runtime = createLocalAgentRuntime({ providers: [provider] });
    const events: AgentEvent[] = [];

    for await (const event of runtime.run({
      runId: "timed-run",
      provider: "fake",
      cwd: process.cwd(),
      prompt: "hello",
      metadata: { timingDiagnostics: true },
    })) events.push(event);

    const diagnostics = events.flatMap((event) =>
      event.type === "status" && event.diagnostic ? [event.diagnostic] : [],
    );
    expect(diagnostics.map((diagnostic) => diagnostic.stage)).toEqual([
      "process_env",
      "tutti_run_context",
      "provider_plan",
      "transport_started",
      "provider_first_event",
      "provider_first_text",
      "provider_first_tool",
      "provider_done",
    ]);
    expect(diagnostics.every((diagnostic) => diagnostic.elapsedMs >= 0)).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.totalElapsedMs >= 0)).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain(process.cwd());
  });
});
