import { randomUUID } from "node:crypto";
import {
  createPluginExecutionFrame,
  getPluginExecutionFrame,
  runWithPluginExecutionFrame,
} from "./plugin-instance-invocation.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRegistryVersion } from "./runtime-state.js";

/** Bounded wire facts share the inspection contract; no independent diagnostic DTO. */
export type PluginRetentionSnapshot = NonNullable<
  import("../../packages/gateway-protocol/src/index.js").PluginsInspectResult["runtimeRetention"]
>;
export type PluginRetainedReference = Omit<PluginRetentionSnapshot["references"][number], "ageMs">;
/** Host-authored correlation only, never invocation or authorization authority. */
export type PluginRetentionOwner = Readonly<Exclude<PluginRetainedReference["owner"], "unknown">>;
export type PluginRetentionReason = PluginRetainedReference["reason"];
type PluginRetentionCleanupState = PluginRetainedReference["cleanupState"];
export type PluginWorkRelease = (() => void) & {
  /** Updates observation only; never releases or revokes a hold. */
  setCleanupState?: (state: PluginRetentionCleanupState) => void;
};

// Diagnostic data must not retain request objects or copy arbitrary caller properties.
function copyOwner(owner: PluginRetentionOwner | undefined): PluginRetentionOwner | undefined {
  if (!owner) {
    return undefined;
  }
  const bounded = (value: string | undefined) => value?.slice(0, 256);
  const result = {
    agentId: bounded(owner.agentId),
    sessionKey: bounded(owner.sessionKey),
    runId: bounded(owner.runId),
    serviceId: bounded(owner.serviceId),
  };
  return Object.values(result).some(Boolean) ? Object.freeze(result) : undefined;
}

/** Bind a scalar acquisition owner through the existing plugin execution frame. */
export function withPluginRetentionOwner<T>(owner: PluginRetentionOwner, run: () => T): T {
  const current = getPluginExecutionFrame();
  return runWithPluginExecutionFrame(
    createPluginExecutionFrame({ ...current, retentionOwner: copyOwner(owner) }, current),
    run,
  );
}

/** Capture only host-selected identity fields at acquisition, not at inspection time. */
function createPluginRetainedReference(
  referenceId: string,
  kind: PluginRetainedReference["kind"],
  reason: PluginRetentionReason,
  parent?: PluginRetainedReference,
  owner = getPluginExecutionFrame()?.retentionOwner,
): PluginRetainedReference {
  return {
    referenceId,
    kind,
    reason,
    acquiredAtMs: Date.now(),
    owner: copyOwner(owner) ?? parent?.owner ?? "unknown",
    ...(parent ? { parentReferenceId: parent.referenceId } : {}),
    cleanupState: kind === "cleanup" ? "pending" : "active",
  };
}

/** Return bounded copies of live facts; inspection cannot mutate retention ownership. */
function snapshotPluginRetainedReferences(
  references: Iterable<PluginRetainedReference>,
  limit = 64,
  includeOwners = true,
): Pick<PluginRetentionSnapshot, "references" | "total" | "omitted"> {
  const rows: PluginRetentionSnapshot["references"] = [];
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.min(64, Math.floor(limit))) : 64;
  const now = Date.now();
  let total = 0;
  for (const reference of references) {
    total++;
    if (rows.length < maximum) {
      rows.push({
        ...reference,
        owner: includeOwners ? reference.owner : "unknown",
        ageMs: Math.max(0, now - reference.acquiredAtMs),
      });
    }
  }
  return { references: rows, total, omitted: total - rows.length };
}

/** Instance-local observations; only the lifetime owner decides which tokens are live. */
export class PluginReferenceDiagnostics {
  private readonly instanceId = randomUUID();
  private sequence = 0;
  private readonly references = new WeakMap<object, PluginRetainedReference>();

  /** Record an acquisition without retaining its lifetime token or invocation payload. */
  record(
    token: object,
    parentToken: object | undefined,
    kind: PluginRetainedReference["kind"],
    reason: PluginRetentionReason,
    owner?: PluginRetentionOwner,
  ): PluginRetainedReference {
    const reference = createPluginRetainedReference(
      `${this.instanceId}:${++this.sequence}`,
      kind,
      reason,
      parentToken ? this.references.get(parentToken) : undefined,
      owner,
    );
    this.references.set(token, reference);
    return reference;
  }

  /** Decorate the existing release with observational cleanup state only. */
  workRelease(
    token: object,
    parentToken: object | undefined,
    reason: PluginRetentionReason,
    release: () => void,
  ): PluginWorkRelease {
    const reference = this.record(token, parentToken, "work", reason);
    return Object.assign(release, {
      setCleanupState: (state: PluginRetentionCleanupState) => {
        reference.cleanupState = state;
      },
    });
  }

  /** Project the owner's current token sets, deduplicating timed-out calls. */
  snapshot(
    instance: Pick<
      PluginRetentionSnapshot,
      "pluginId" | "acceptingCalls" | "replacementPending" | "disposing"
    >,
    registry: PluginRegistry | undefined,
    tokenSets: Iterable<object>[],
    options: { limit?: number; includeOwners?: boolean },
  ): PluginRetentionSnapshot {
    const tokens = new Set(tokenSets.flatMap((set) => [...set]));
    const diagnostics = this.references;
    function* references() {
      for (const token of tokens) {
        const reference = diagnostics.get(token);
        if (reference) {
          yield reference;
        }
      }
    }
    return {
      instanceId: this.instanceId,
      pluginId: instance.pluginId,
      generation: getPluginRegistryVersion(registry ?? null),
      acceptingCalls: instance.acceptingCalls,
      replacementPending: instance.replacementPending,
      disposing: instance.disposing,
      ...snapshotPluginRetainedReferences(references(), options.limit, options.includeOwners),
    };
  }
}
