import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { resolveTempDir } from "../process/env.js";
import { cleanupPaths } from "../skills/cleanup.js";

type ProviderRunWorkspace = {
  getRoot(): Promise<string>;
  onCleanup(callback: () => Promise<void> | void): void;
  track(path: string): void;
};

function safePrefix(value: string) {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return normalized || "provider";
}

/**
 * Owns provider-generated, run-scoped files without changing the application
 * cwd or the provider's authentication home. Roots are lazy so prompt-only
 * providers do not pay for filesystem preparation.
 */
export function createProviderRunWorkspaceManager(
  providerId: string,
  options: { rootKind?: string } = {},
) {
  const preparingRunIds = new Set<string>();
  const cleanupByRunId = new Map<
    string,
    { callbacks: Array<() => Promise<void> | void>; targets: string[] }
  >();
  const prefix = `agent-acp-kit-${safePrefix(providerId)}-${safePrefix(options.rootKind ?? "run")}-`;

  async function prepare<T>(
    runId: string,
    env: Record<string, string> | undefined,
    prepareRun: (workspace: ProviderRunWorkspace) => Promise<T>,
  ): Promise<T> {
    if (preparingRunIds.has(runId) || cleanupByRunId.has(runId)) {
      throw new Error(`Provider run ${runId} is already prepared.`);
    }
    preparingRunIds.add(runId);

    const cleanupCallbacks: Array<() => Promise<void> | void> = [];
    const cleanupTargets: string[] = [];
    let rootPromise: Promise<string> | undefined;
    const workspace: ProviderRunWorkspace = {
      getRoot() {
        rootPromise ??= (async () => {
          const tempRoot = resolveTempDir(env);
          await mkdir(tempRoot, { recursive: true });
          const root = await mkdtemp(join(tempRoot, prefix));
          cleanupTargets.push(root);
          return root;
        })();
        return rootPromise;
      },
      onCleanup(callback) {
        cleanupCallbacks.push(callback);
      },
      track(path) {
        if (!cleanupTargets.includes(path)) cleanupTargets.push(path);
      },
    };

    try {
      const result = await prepareRun(workspace);
      if (cleanupCallbacks.length > 0 || cleanupTargets.length > 0) {
        cleanupByRunId.set(runId, {
          callbacks: [...cleanupCallbacks],
          targets: [...cleanupTargets],
        });
      }
      return result;
    } catch (error) {
      await Promise.allSettled(rootPromise ? [rootPromise] : []);
      try {
        for (const callback of cleanupCallbacks) await callback();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Provider run ${runId} preparation and cleanup both failed; run files were preserved.`,
        );
      }
      await cleanupPaths(cleanupTargets);
      throw error;
    } finally {
      preparingRunIds.delete(runId);
    }
  }

  async function cleanup(runId: string) {
    const cleanupState = cleanupByRunId.get(runId);
    if (!cleanupState) return;
    for (const callback of cleanupState.callbacks) await callback();
    await cleanupPaths(cleanupState.targets);
    cleanupByRunId.delete(runId);
  }

  return { cleanup, prepare };
}
