// Gateway channel lifecycle options and read-only runtime snapshot types.
import type { ChannelId, ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRuntimeChannel } from "../plugins/runtime/types-channel.js";
import type { RuntimeEnv } from "../runtime.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

export type ChannelRuntimeSnapshotOptions = {
  channelId?: ChannelId;
  /** Controls read recorded state without invoking fallible diagnostic inspectors. */
  inspectAccounts?: boolean;
};

/** Snapshot of channel runtime state keyed by channel and account id. */
export type ChannelRuntimeSnapshot = {
  /** Host admission is paused; status must use captured facts without invoking plugin callbacks. */
  reloadingChannels?: ReadonlyMap<ChannelId, string | undefined>;
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};

/** The lifecycle owner's decision for one requested account start, separate from connectivity. */
export type ChannelAccountStartOutcome =
  | { status: "handed-off" }
  | { status: "retry"; reason: "stop-in-flight" | "task-owned" }
  | {
      status: "skipped";
      reason:
        | "unsupported"
        | "autostart-suppressed"
        | "ambient-suppressed"
        | "disabled"
        | "unconfigured"
        | "secret-unavailable"
        | "unlinked"
        | "manual-stop";
    };

export type StartChannelOptions = {
  preserveRestartAttempts?: boolean;
  preserveManualStop?: boolean;
  /** Reload leaves snapshot-cold accounts stopped without bypassing credential-file reinspection. */
  skipUnavailableAccounts?: boolean;
  deferAccountStartUntil?: Promise<void>;
  manual?: boolean;
};

export type StopChannelOptions = {
  manual?: boolean;
  routeHandoff?: boolean;
  /** Report unfinished cleanup to the caller after the bounded stop attempt. */
  strict?: boolean;
};

export type ChannelManagerOptions = {
  scheduler: GatewayScheduler;
  getRuntimeConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry;
  resolveGatewayContext?: GatewayContextResolver;
  channelLogs: Partial<Record<ChannelId, SubsystemLogger>>;
  channelRuntimeEnvs: Partial<Record<ChannelId, RuntimeEnv>>;
  /** Supply the complete createPluginRuntime().channel surface; partial stubs are unsupported. */
  channelRuntime?: PluginRuntimeChannel;
  /** Resolve the same complete surface only when a channel account starts. */
  resolveChannelRuntime?: () => PluginRuntimeChannel | Promise<PluginRuntimeChannel>;
  startupTrace?: { measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T> };
  deferStartupAccountStartsUntil?: Promise<void>;
  getNativeApprovalRuntime?: () => GatewayNativeApprovalRuntime | undefined;
  ambientAutostartSuppressedChannelIds?: ReadonlySet<string>;
  tryRecoverAutostartSuppression?: () => boolean;
  isClosing?: () => boolean;
};
