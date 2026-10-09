import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import { assertPreparedModelRuntimeAdmissionCanWait } from "./prepared-model-runtime-admission.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import { ownPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedReplyDispatchLease,
  PreparedReplyDispatchRuntime,
} from "./prepared-model-runtime.types.js";

const EMPTY_REPLY_DISPATCH_PUBLICATION: readonly PreparedReplyDispatchRuntime[] = Object.freeze([]);

function createReplyDispatchRuntime(
  runtimeOwner: PreparedModelRuntimeOwner,
): PreparedReplyDispatchRuntime {
  const snapshot = runtimeOwner.snapshot!;
  const owner = resolvePublishedModelCatalogOwner(snapshot);
  const pluginGeneration = runtimeOwner.pluginGeneration;
  const inboundPluginRegistry = pluginGeneration?.inboundPluginRegistry;
  if (!pluginGeneration || !inboundPluginRegistry) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared inbound plugin registry was not published for ${snapshot.agentDir}`,
    );
  }
  return Object.freeze({
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    config: owner.config,
    modelCatalog: owner.modelCatalog,
    readFullModelCatalog: snapshot.readFullModelCatalog,
    inboundPluginRegistry,
    pluginGeneration,
  });
}

function buildReplyDispatchPublication(
  owners: Iterable<PreparedModelRuntimeOwner>,
): readonly PreparedReplyDispatchRuntime[] {
  const runtimes = [...owners]
    .filter((owner) => owner.provenance === "configured")
    .map((owner) => {
      if (!owner.snapshot || owner.needsRefresh || owner.pending) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared reply dispatch runtime owner was not published for ${owner.input.agentId ?? owner.input.agentDir}`,
        );
      }
      return createReplyDispatchRuntime(owner);
    })
    .toSorted((left, right) => left.agentId.localeCompare(right.agentId));
  if (new Set(runtimes.map((runtime) => runtime.agentId)).size !== runtimes.length) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      "prepared reply dispatch runtime publication contains duplicate configured agents",
    );
  }
  return Object.freeze(runtimes);
}

type PreparedReplyDispatchLoadParams = {
  agentId: string;
  abortSignal?: AbortSignal;
  demand?: "interactive" | "scheduled";
};

type PreparedReplyDispatchPublicationHost = Readonly<{
  isGatewayLifecycleActive: () => boolean;
  getConfiguredOwner: (agentId: string) => PreparedModelRuntimeOwner | undefined;
  getPendingReplacement: () => Promise<void> | undefined;
  ensureReady: (params: PreparedReplyDispatchLoadParams) => Promise<void>;
}>;

/** Reads an immutable dispatch generation after the lifecycle's demand preparation. */
export class PreparedReplyDispatchPublicationOwner {
  #publication = EMPTY_REPLY_DISPATCH_PUBLICATION;

  constructor(private readonly host: PreparedReplyDispatchPublicationHost) {}

  clear(): void {
    this.#publication = EMPTY_REPLY_DISPATCH_PUBLICATION;
  }

  advanceConfig(config: OpenClawConfig): void {
    this.#publication = Object.freeze(
      this.#publication.map((runtime) => Object.freeze({ ...runtime, config })),
    );
  }

  rebuild(owners: Iterable<PreparedModelRuntimeOwner>): void {
    this.#publication = this.host.isGatewayLifecycleActive()
      ? buildReplyDispatchPublication(owners)
      : EMPTY_REPLY_DISPATCH_PUBLICATION;
  }

  stage(owners: Iterable<PreparedModelRuntimeOwner>): () => void {
    const publication = this.host.isGatewayLifecycleActive()
      ? buildReplyDispatchPublication(owners)
      : EMPTY_REPLY_DISPATCH_PUBLICATION;
    return () => {
      this.#publication = publication;
    };
  }

  remove(agentIds: ReadonlySet<string>): void {
    if (agentIds.size > 0) {
      this.#publication = Object.freeze(
        this.#publication.filter((runtime) => !agentIds.has(runtime.agentId)),
      );
    }
  }

  replace(owners: readonly PreparedModelRuntimeOwner[]): void {
    const replacements = buildReplyDispatchPublication(owners);
    const agentIds = new Set(replacements.map((runtime) => runtime.agentId));
    this.#publication = Object.freeze(
      [
        ...this.#publication.filter((runtime) => !agentIds.has(runtime.agentId)),
        ...replacements,
      ].toSorted((left, right) => left.agentId.localeCompare(right.agentId)),
    );
  }

  /** Reads the published record for callers that take their own run lease immediately. */
  readonly load = (
    params: PreparedReplyDispatchLoadParams,
  ): Promise<PreparedReplyDispatchRuntime | undefined> => this.#admit(params, (runtime) => runtime);

  /**
   * Reads the published record and holds its generation in the same synchronous step, so a
   * publication committed before the turn's run lease cannot retire what dispatch admitted.
   */
  readonly acquire = (
    params: PreparedReplyDispatchLoadParams,
  ): Promise<PreparedReplyDispatchLease | undefined> =>
    this.#admit(params, (runtime) => this.#hold(runtime));

  // Custody keeps the generation's registries open without joining plugin replacement drains;
  // the run lease that borrows the snapshot retains plugin work as any turn lease does.
  #hold(runtime: PreparedReplyDispatchRuntime): PreparedReplyDispatchLease {
    const owner = this.host.getConfiguredOwner(runtime.agentId);
    const snapshot =
      owner?.pluginGeneration === runtime.pluginGeneration ? owner.snapshot : undefined;
    // An owner that already left this record's generation has nothing to hold; the turn's run
    // lease then fails closed exactly as it would for an unheld record.
    let release = snapshot
      ? ownPreparedPluginGeneration(runtime.pluginGeneration).retain()
      : undefined;
    return Object.freeze({
      runtime,
      borrowSnapshot: () => (release ? snapshot : undefined),
      [Symbol.asyncDispose]: async () => {
        const releaseCustody = release;
        release = undefined;
        await releaseCustody?.();
      },
    });
  }

  async #admit<T>(
    params: PreparedReplyDispatchLoadParams,
    onPublished: (runtime: PreparedReplyDispatchRuntime) => T,
  ): Promise<T | undefined> {
    const { agentId, abortSignal } = params;
    let demandPrepared = false;
    for (;;) {
      if (abortSignal?.aborted) {
        throw createAbortError("Prepared reply dispatch admission aborted", {
          cause: abortSignal.reason,
        });
      }
      if (!this.host.isGatewayLifecycleActive()) {
        return undefined;
      }
      const replacement = this.host.getPendingReplacement();
      const pendingOwner = replacement ? undefined : this.host.getConfiguredOwner(agentId);
      if (replacement) {
        assertPreparedModelRuntimeAdmissionCanWait();
      } else if (pendingOwner?.pending) {
        assertPreparedModelRuntimeAdmissionCanWait(pendingOwner);
      }
      if (!demandPrepared) {
        // Demand can join recovery, so preserve admission before that first wait.
        await this.host.ensureReady(params);
        demandPrepared = true;
        continue;
      }
      if (replacement) {
        await racePromiseWithAbortSignal(replacement, abortSignal);
        continue;
      }
      if (pendingOwner?.pending) {
        await racePromiseWithAbortSignal(pendingOwner.pending, abortSignal);
        continue;
      }
      const runtime = this.#publication.find((candidate) => candidate.agentId === agentId);
      if (!runtime) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared reply dispatch runtime owner was not published for ${agentId}`,
        );
      }
      return onPublished(runtime);
    }
  }
}
