import type { DetectContext } from "../core/detection.js";
import type { DetectedProvider } from "../core/provider-plugin.js";
import type { AgentRunInput } from "../core/run-input.js";
import type {
  RuntimeAgentDescriptor,
  TuttiRuntimeDetector,
  TuttiRuntimeRunPreparer,
} from "../runtime/create-runtime.js";
import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import { loadTuttiAgentCatalog } from "./agent-catalog.js";
import { loadTuttiAgentComposerOptionsWithCatalog } from "./composer-options.js";
import type {
  TuttiAgentCatalog,
  TuttiAgentCatalogEntry,
  TuttiAgentComposerOptions,
} from "./contracts.js";
import {
  hasConfiguredTuttiCli,
  TuttiIntegrationError,
  type TuttiCliJsonRunner,
} from "./cli-json-runner.js";
import { createTuttiProviderResolver } from "./internal.js";

type IntegrationOptions = {
  runTuttiCli?: TuttiCliJsonRunner;
};

export function createTuttiRuntimeIntegration<
  TKind extends string,
  TProvider extends string,
>(
  options: IntegrationOptions = {},
): {
  detect: TuttiRuntimeDetector<TKind, TProvider>;
  prepareRun: TuttiRuntimeRunPreparer<TKind, TProvider>;
} {
  const catalogCache = new Map<string, Promise<TuttiAgentCatalog>>();
  const availabilityCache = new Map<string, Promise<TuttiAgentCatalogEntry>>();
  const composerCache = new Map<string, Promise<TuttiAgentComposerOptions>>();

  const clearScope = (scopeKey: string) => {
    catalogCache.delete(scopeKey);
    const prefix = `${scopeKey}\u0000`;
    for (const key of availabilityCache.keys()) {
      if (key.startsWith(prefix)) availabilityCache.delete(key);
    }
    for (const key of composerCache.keys()) {
      if (key.startsWith(prefix)) composerCache.delete(key);
    }
  };

  const loadCatalog = <
    TLocalKind extends string,
    TLocalProvider extends string,
  >(input: {
    scopeKey: string;
    context?: DetectContext;
    descriptors: RuntimeAgentDescriptor<TLocalKind, TLocalProvider>[];
    env: NodeJS.ProcessEnv;
  }) => {
    const existing = catalogCache.get(input.scopeKey);
    if (existing) return existing;
    const runtime = descriptorRuntime(input.descriptors);
    const request = loadTuttiAgentCatalog({
      runtime,
      cwd: input.context?.cwd,
      detectContext: input.context,
      env: input.env,
      ...(options.runTuttiCli ? { runTuttiCli: options.runTuttiCli } : {}),
    }).catch((error) => {
      catalogCache.delete(input.scopeKey);
      throw error;
    });
    catalogCache.set(input.scopeKey, request);
    return request;
  };

  const loadAvailability = <
    TLocalKind extends string,
    TLocalProvider extends string,
  >(input: {
    scopeKey: string;
    agentTargetId: string;
    context?: DetectContext;
    descriptors: RuntimeAgentDescriptor<TLocalKind, TLocalProvider>[];
    env: NodeJS.ProcessEnv;
  }) => {
    const key = `${input.scopeKey}\u0000${input.agentTargetId}`;
    const existing = availabilityCache.get(key);
    if (existing) return existing;
    const request = loadTuttiAgentCatalog({
      runtime: descriptorRuntime(input.descriptors),
      agentTargetId: input.agentTargetId,
      refreshAvailability: input.context?.refresh === true,
      cwd: input.context?.cwd,
      detectContext: input.context,
      env: input.env,
      timeoutMs: 60_000,
      ...(options.runTuttiCli ? { runTuttiCli: options.runTuttiCli } : {}),
    })
      .then((catalog) => {
        const agent = catalog.agents.find(
          (candidate) => candidate.agentTargetId === input.agentTargetId,
        );
        if (!agent) {
          throw new Error(
            `Agent Target ${input.agentTargetId} was not returned.`,
          );
        }
        return agent;
      })
      .catch((error) => {
        availabilityCache.delete(key);
        throw error;
      });
    availabilityCache.set(key, request);
    return request;
  };

  const loadComposer = <
    TLocalKind extends string,
    TLocalProvider extends string,
  >(input: {
    scopeKey: string;
    agentTargetId: string;
    context?: DetectContext;
    descriptors: RuntimeAgentDescriptor<TLocalKind, TLocalProvider>[];
    env: NodeJS.ProcessEnv;
    catalog: TuttiAgentCatalog;
  }) => {
    const key = `${input.scopeKey}\u0000${input.agentTargetId}`;
    const existing = composerCache.get(key);
    if (existing) return existing;
    const runtime = descriptorRuntime(input.descriptors);
    const request = loadTuttiAgentComposerOptionsWithCatalog(
      {
        runtime,
        agentTargetId: input.agentTargetId,
        cwd: input.context?.cwd,
        detectContext: input.context,
        env: input.env,
        ...(options.runTuttiCli ? { runTuttiCli: options.runTuttiCli } : {}),
      },
      input.catalog,
    ).catch((error) => {
      composerCache.delete(key);
      throw error;
    });
    composerCache.set(key, request);
    return request;
  };

  const detect: TuttiRuntimeDetector<TKind, TProvider> = async ({
    context,
    descriptors,
  }) => {
    const env = effectiveEnv(context);
    const cliInput = {
      env,
      ...(options.runTuttiCli ? { runTuttiCli: options.runTuttiCli } : {}),
    };
    if (!hasConfiguredTuttiCli(cliInput)) return undefined;

    const scopeKey = runtimeScopeKey(
      env,
      context?.cwd,
      Boolean(options.runTuttiCli),
    );
    if (context?.refresh) clearScope(scopeKey);
    try {
      const catalog = await loadCatalog({
        scopeKey,
        context,
        descriptors,
        env,
      });
      return await detectTuttiTargets({
        context,
        descriptors,
        catalog,
        loadAvailability: (agentTargetId) =>
          loadAvailability({
            scopeKey,
            agentTargetId,
            context,
            descriptors,
            env,
          }),
        loadComposer: (agentTargetId) =>
          loadComposer({
            scopeKey,
            agentTargetId,
            context,
            descriptors,
            env,
            catalog,
          }),
      });
    } catch {
      return [];
    }
  };

  const prepareRun: TuttiRuntimeRunPreparer<TKind, TProvider> = async ({
    run,
    env,
    descriptors,
  }) => {
    const cliInput = {
      env,
      ...(options.runTuttiCli ? { runTuttiCli: options.runTuttiCli } : {}),
    };
    if (!hasConfiguredTuttiCli(cliInput)) return run;
    if (!run.agentTargetId) {
      throw new Error("Tutti runtime runs require an exact agentTargetId.");
    }

    const context = { cwd: run.cwd, env };
    const scopeKey = runtimeScopeKey(
      env,
      run.cwd,
      Boolean(options.runTuttiCli),
    );
    // Runtime selection can change after detection. A run must resolve the
    // current target executable and composer settings instead of reusing an
    // unbounded discovery cache.
    clearScope(scopeKey);
    const { catalog, composer } = await retryTimedOutPreparation(async () => {
      const catalog = await loadCatalog({ scopeKey, context, descriptors, env });
      const composer = await waitForSharedRequest(
        loadComposer({
          scopeKey,
          agentTargetId: run.agentTargetId!,
          context,
          descriptors,
          env,
          catalog,
        }),
        run.signal,
      );
      return { catalog, composer };
    }, () => clearScope(scopeKey));
    const descriptor = descriptorForProvider(descriptors, composer.providerId);
    if (!descriptor || String(descriptor.id) !== String(run.provider)) {
      throw new Error(
        `Agent Target provider mismatch: ${run.agentTargetId} resolves to ${composer.providerId}, got ${String(run.provider)}.`,
      );
    }
    const agent = catalog.agents.find(
      (candidate) => candidate.agentTargetId === run.agentTargetId,
    );
    return applyComposerToRun(run, composer, agent?.executablePath);
  };

  return { detect, prepareRun };
}

async function retryTimedOutPreparation<T>(
  request: () => Promise<T>,
  reset: () => void,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof TuttiIntegrationError) || error.code !== "cli_timeout") {
      throw error;
    }
    reset();
    return await request();
  }
}

async function detectTuttiTargets<
  TKind extends string,
  TProvider extends string,
>(input: {
  context?: DetectContext;
  descriptors: RuntimeAgentDescriptor<TKind, TProvider>[];
  catalog: TuttiAgentCatalog;
  loadAvailability(agentTargetId: string): Promise<TuttiAgentCatalogEntry>;
  loadComposer(agentTargetId: string): Promise<TuttiAgentComposerOptions>;
}): Promise<Array<DetectedProvider<TProvider>>> {
  return await Promise.all(
    input.catalog.agents.map(
      async (catalogAgent): Promise<DetectedProvider<TProvider>> => {
        let agent = catalogAgent;
        if (agent.agentTargetId.startsWith("extension:")) {
          try {
            agent = await input.loadAvailability(agent.agentTargetId);
          } catch (error) {
            return {
              ...projectUnavailableTarget<TKind, TProvider>(
                agent,
                descriptorForProvider(input.descriptors, agent.providerId),
                input.catalog.defaultAgentTargetId,
              ),
              reason: `Agent availability could not be loaded: ${safeErrorMessage(error)}`,
            };
          }
        }
        const descriptor = descriptorForProvider(
          input.descriptors,
          agent.providerId,
        );
        if (!descriptor || !agent.runtimeSupported) {
          return projectUnavailableTarget<TKind, TProvider>(
            agent,
            undefined,
            input.catalog.defaultAgentTargetId,
          );
        }
        if (agent.availability.status !== "available") {
          return projectUnavailableTarget<TKind, TProvider>(
            agent,
            descriptor,
            input.catalog.defaultAgentTargetId,
          );
        }
        try {
          const composer = await input.loadComposer(agent.agentTargetId);
          return projectAvailableTarget<TKind, TProvider>(
            agent,
            descriptor,
            composer,
            input.catalog.defaultAgentTargetId,
          );
        } catch (error) {
          return {
            ...projectUnavailableTarget<TKind, TProvider>(
              agent,
              descriptor,
              input.catalog.defaultAgentTargetId,
            ),
            reason: `Agent composer options could not be loaded: ${safeErrorMessage(error)}`,
          };
        }
      },
    ),
  );
}

function descriptorRuntime<TKind extends string, TProvider extends string>(
  descriptors: RuntimeAgentDescriptor<TKind, TProvider>[],
): LocalAgentRuntime<string, string> {
  return {
    async cancel() {},
    listProviders: () =>
      descriptors.map((descriptor) => ({
        id: String(descriptor.id),
        ...(descriptor.aliases?.length
          ? { aliases: [...descriptor.aliases] }
          : {}),
        displayName: descriptor.displayName,
        kind: String(descriptor.kind),
        ...(descriptor.requiresKnownAuth ? { requiresKnownAuth: true } : {}),
      })),
    detect: async () => {
      throw new Error(
        "Tutti runtime integration must not fall back to standalone detection.",
      );
    },
    run: (() => {
      throw new Error("not used");
    }) as LocalAgentRuntime<string, string>["run"],
  };
}

function descriptorForProvider<TKind extends string, TProvider extends string>(
  descriptors: RuntimeAgentDescriptor<TKind, TProvider>[],
  providerId: string,
) {
  const runtimeProviderId = createTuttiProviderResolver(
    descriptors.map((descriptor) => ({
      id: String(descriptor.id),
      ...(descriptor.aliases?.length ? { aliases: descriptor.aliases.map(String) } : {}),
    })),
  ).resolve(providerId);
  return descriptors.find((descriptor) => String(descriptor.id) === runtimeProviderId);
}

function projectAvailableTarget<TKind extends string, TProvider extends string>(
  agent: TuttiAgentCatalogEntry,
  descriptor: RuntimeAgentDescriptor<TKind, TProvider>,
  composer: TuttiAgentComposerOptions,
  defaultAgentTargetId: string,
): DetectedProvider<TProvider> {
  const models = composer.modelConfig.options.map((option) => ({
    id: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
  const defaultModelId =
    composer.modelConfig.currentValue || composer.modelConfig.defaultValue;
  return {
    agentTargetId: agent.agentTargetId,
    ...(agent.executablePath ? { executablePath: agent.executablePath } : {}),
    provider: descriptor.id,
    displayName: agent.displayName,
    supported: true,
    authState: "ok",
    models,
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(agent.agentTargetId === defaultAgentTargetId
      ? { isDefault: true }
      : {}),
  };
}

function projectUnavailableTarget<
  TKind extends string,
  TProvider extends string,
>(
  agent: TuttiAgentCatalogEntry,
  descriptor: RuntimeAgentDescriptor<TKind, TProvider> | undefined,
  defaultAgentTargetId: string,
): DetectedProvider<TProvider> {
  return {
    agentTargetId: agent.agentTargetId,
    ...(agent.executablePath ? { executablePath: agent.executablePath } : {}),
    provider: (descriptor?.id ?? agent.providerId) as TProvider,
    displayName: agent.displayName,
    supported: false,
    authState: authStateFromReason(agent.availability.reasonCode),
    models: [],
    reason: agent.availability.detail || "Agent Target is unavailable.",
    ...(agent.agentTargetId === defaultAgentTargetId
      ? { isDefault: true }
      : {}),
  };
}

function applyComposerToRun<TKind extends string, TProvider extends string>(
  run: AgentRunInput<TKind, TProvider>,
  composer: TuttiAgentComposerOptions,
  executablePath?: string,
): AgentRunInput<TKind, TProvider> {
  const model =
    run.model ||
    composer.modelConfig.currentValue ||
    composer.modelConfig.defaultValue;
  const reasoning =
    run.reasoning ||
    composer.reasoningConfig.currentValue ||
    composer.reasoningConfig.defaultValue;
  return {
    ...run,
    ...(executablePath ? { executablePath } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    // Composer permission defaults are UI state. Execution permission comes
    // only from an explicit run selection or the autonomous runtime default.
  };
}

function effectiveEnv(context?: DetectContext): NodeJS.ProcessEnv {
  return { ...process.env, ...(context?.env ?? {}) };
}

function runtimeScopeKey(
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  customRunner: boolean,
) {
  const cli = env.TUTTI_CLI?.trim() || (customRunner ? "custom-runner" : "");
  const workspaceId =
    env.TUTTI_WORKSPACE_ID?.trim() || env.NEXTOP_WORKSPACE_ID?.trim();
  const scope = workspaceId
    ? `workspace:${workspaceId}`
    : `cwd:${cwd?.trim() ?? ""}`;
  return `${cli}\u0000${scope}`;
}

async function waitForSharedRequest<T>(
  request: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await request;
  if (signal.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function authStateFromReason(
  reasonCode: string,
): DetectedProvider["authState"] {
  if (reasonCode === "auth_required") return "missing";
  if (reasonCode === "auth_expired" || reasonCode === "session_expired")
    return "expired";
  return reasonCode ? "unknown" : "ok";
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "unknown error";
}
