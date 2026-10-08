// Focused public test helpers for plugin runtime, registry, and setup fixtures.

import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";

type AgentHarnessHostTestAttempt = Omit<
  Parameters<
    typeof import("../agents/harness/host-capability.js").createAgentHarnessHostCapabilities
  >[0]["attempt"],
  "admittedRunContext" | "hostCapabilities" | "disableToolSearch" | "sessionReadScopeKey"
>;

type PluginHarnessTestOperatorSource = Pick<
  AdmittedRunOperatorAuthority,
  "profileId" | "scopes" | "assertCurrent" | "modelPolicy" | "onModelPolicyChanged"
>;

// Admits one plugin-harness run the way core does before it hands an attempt to a plugin.
async function admitPluginHarnessRunForTest(params: {
  attempt: Pick<AgentHarnessHostTestAttempt, "config" | "runId" | "agentId">;
  pluginId: string;
  operatorSource?: PluginHarnessTestOperatorSource;
}) {
  const {
    createAdmittedRunOperatorAuthority,
    createOperationalRunInstanceRef,
    prepareAgentRunAdmission,
  } = await import("../agents/admitted-run-context.js");
  const admission = prepareAgentRunAdmission({
    cfg: params.attempt.config ?? {},
    operatorAuthority: params.operatorSource
      ? createAdmittedRunOperatorAuthority(params.operatorSource)
      : undefined,
    facts: {
      runId: params.attempt.runId,
      agentId: params.attempt.agentId ?? "main",
      ingress: { kind: "system", boundary: "plugin-test-runtime", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(params.attempt.runId),
  });
  return {
    admittedRunContext: await admission.admit("plugin-harness", params.pluginId),
    close: () => admission.close(),
  };
}

/** Builds the production admitted-run host boundary for plugin integration tests. */
export async function createAgentHarnessHostCapabilitiesForTest(params: {
  attempt: AgentHarnessHostTestAttempt;
  pluginId: string;
  nativeModelPolicySupport?: "exact";
  operatorSource?: PluginHarnessTestOperatorSource;
}) {
  const { createAgentHarnessHostCapabilities } =
    await import("../agents/harness/host-capability.js");
  const admission = await admitPluginHarnessRunForTest(params);
  const admittedRunContext = admission.admittedRunContext;
  const host = createAgentHarnessHostCapabilities({
    attempt: { ...params.attempt, admittedRunContext },
    pluginId: params.pluginId,
    nativeModelPolicySupport: params.nativeModelPolicySupport,
  });
  return {
    capabilities: host.capabilities,
    close: () => {
      host.close();
      admission.close();
    },
  };
}

/**
 * Admits one session turn through the production session-controller mailbox,
 * so a native harness attempt registers under the same turn owner it has in a Gateway run.
 */
export async function withAdmittedSessionTurnForTest<T>(
  params: { sessionKey: string; sessionId: string; agentId?: string },
  run: (operation: ReplyOperation) => Promise<T>,
): Promise<T> {
  const { withSessionTurn } = await import("../sessions/session-controller.admission.js");
  return await withSessionTurn(params, async (operation) => {
    if (!operation) {
      throw new Error(`Session turn admission did not materialize ${params.sessionKey}`);
    }
    return await run(operation);
  });
}

/**
 * Runs a harness attempt the way core invokes it: inside the session's admitted
 * controller turn, with that operation as `replyOperation`. Attempts without a
 * session key, or that already carry an operation, run unchanged. The operation is
 * set on the caller's attempt object for the run, so fixtures that adjust params
 * mid-run keep their identity, and is removed once the turn settles.
 */
export async function runInAdmittedSessionTurnForTest<
  T,
  Attempt extends {
    sessionKey?: string;
    sessionId: string;
    agentId?: string;
    replyOperation?: ReplyOperation;
  },
>(attempt: Attempt, run: (attempt: Attempt) => Promise<T>): Promise<T> {
  const sessionKey = attempt.sessionKey?.trim();
  if (!sessionKey || attempt.replyOperation) {
    return await run(attempt);
  }
  return await withAdmittedSessionTurnForTest(
    { sessionKey, sessionId: attempt.sessionId, agentId: attempt.agentId },
    async (replyOperation) => {
      attempt.replyOperation = replyOperation;
      try {
        return await run(attempt);
      } finally {
        if (attempt.replyOperation === replyOperation) {
          delete attempt.replyOperation;
        }
      }
    },
  );
}

type HarnessToolAuthorityBoundary = Parameters<
  typeof import("../agents/harness/tool-authority.runtime.js").withPreparedEmbeddedRunToolAuthority
>;
type HarnessToolAuthorityTestAttempt = HarnessToolAuthorityBoundary[1] & {
  replyOperation?: ReplyOperation;
  trigger?: HarnessToolAuthorityBoundary[0]["trigger"];
};

/**
 * Runs a harness attempt inside the admitted session turn and the tool-authority
 * boundary core wraps around every Gateway harness attempt. That boundary derives
 * the turn's real tool-authority fingerprint and binds native registration to the
 * turn watchdog, so runtime-owned liveness behaves as in production. Fixtures that
 * supply their own `toolAuthorityFingerprint` keep `runInAdmittedSessionTurnForTest`.
 */
export async function runInHarnessToolAuthorityForTest<
  T,
  Attempt extends HarnessToolAuthorityTestAttempt,
>(
  attempt: Attempt,
  pluginId: string,
  run: (attempt: Attempt & { toolAuthorityFingerprint?: string }) => Promise<T>,
): Promise<T> {
  if (attempt.toolAuthorityFingerprint) {
    throw new Error("The tool-authority boundary derives its own fingerprint");
  }
  const { withPreparedEmbeddedRunToolAuthority } =
    await import("../agents/harness/tool-authority.runtime.js");
  const { resolveAgentIdFromSessionKey } = await import("../routing/session-key.js");
  // Core always hands a harness its resolved agent; the session key owns that identity.
  const agentId = attempt.agentId ?? resolveAgentIdFromSessionKey(attempt.sessionKey);
  const admission = await admitPluginHarnessRunForTest({ attempt, pluginId });
  try {
    return await runInAdmittedSessionTurnForTest({ ...attempt, agentId }, (admitted) =>
      withPreparedEmbeddedRunToolAuthority(
        {
          admittedRunContext: admission.admittedRunContext,
          replyOperation: admitted.replyOperation,
          trigger: admitted.trigger,
        },
        admitted,
        undefined,
        run,
      ),
    );
  } finally {
    admission.close();
  }
}

export { setDefaultChannelPluginRegistryForTests } from "../commands/channel-test-registry.js";
export {
  createEmptyPluginRegistry,
  createPluginRegistry,
  type PluginRecord,
} from "../plugins/registry.js";
export {
  providerContractLoadError,
  pluginRegistrationContractRegistry,
  resolveProviderContractProvidersForPluginIds,
  resolveWebFetchProviderContractEntriesForPluginId,
  resolveWebSearchProviderContractEntriesForPluginId,
} from "../plugins/contracts/registry.js";
export { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
export {
  emitDiagnosticEventWithTrustedTraceContext,
  emitInternalDiagnosticEvent as emitInternalDiagnosticEventForTest,
  emitTrustedSecurityEvent,
} from "../infra/diagnostic-events.js";
export { registerDiagnosticTracePropagationBridge } from "../infra/diagnostic-trace-propagation.js";
export { runWithDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
export { prepareSystemRunMutableFileApproval } from "../infra/system-run-approval-binding.js";
export { logMessageDispatchStarted, logMessageProcessed } from "../logging/diagnostic.js";
export { resolveBundledExplicitProviderContractsFromPublicArtifacts } from "../plugins/provider-contract-public-artifacts.js";
export {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
export { addTestHook } from "../plugins/hooks.test-helpers.js";
export { createPluginRecord } from "../plugins/status.test-helpers.js";
export { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
export { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
export { useProviderCatalogMetadata } from "./test-helpers/provider-catalog.js";
export { useProviderToolSchemaRuntimeForTest } from "./test-helpers/provider-tool-schemas.test-support.js";
export { useBundledProviderPolicyArtifactsForTest } from "./test-helpers/provider-policy-artifacts.test-support.js";
export { mockPublishedModelRuntimeForTest } from "./test-helpers/published-model-runtime.js";
export {
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "../plugins/web-provider-public-artifacts.explicit.js";
export {
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
export {
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
export { capturePluginRegistration } from "../plugins/captured-registration.js";
export { clearHealthChecksForTest } from "../flows/health-check-registry.js";
export { runProviderCatalog } from "../plugins/provider-discovery.js";
export { onTrustedInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
export {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  setProviderWizardProvidersResolverForTest,
} from "../plugins/provider-wizard.js";
export { resolveProviderPluginChoice } from "../plugins/provider-auth-choice.runtime.js";
export {
  clearEmbeddingProviders,
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  registerEmbeddingProvider,
  restoreRegisteredEmbeddingProviders,
  type RegisteredEmbeddingProvider,
} from "../plugins/embedding-providers.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { PluginHookRegistration } from "../plugins/hook-types.js";
export type { RuntimeEnv } from "../runtime.js";
export type { MockFn } from "../test-utils/vitest-mock-fn.js";
export { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
export { readQueuedEntries as readQueuedDeliveryEntriesForTest } from "../infra/outbound/delivery-queue.test-helpers.js";
export {
  registerProviderPlugin,
  registerProviderPlugins,
  registerSingleProviderPlugin,
  requireRegisteredProvider,
  type RegisteredProviderCollections,
} from "../test-utils/plugin-registration.js";
export { createNonExitingRuntimeEnv, createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
export {
  createPluginSetupWizardAdapter,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createQueuedWizardPrompter,
  createSetupWizardAdapter,
  createTestWizardPrompter,
  promptSetupWizardAllowFrom,
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
  type WizardPrompter,
} from "../test-utils/plugin-setup-wizard.js";
export { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
type AdmittedHostCapabilityTestFixtureFactory =
  typeof import("../agents/harness/host-capability.test-support.js").createAdmittedHostCapabilityTestFixture;

// Keep unrelated consumers of this test barrel out of the host capability runtime.
export async function createAdmittedHostCapabilityTestFixture(
  ...args: Parameters<AdmittedHostCapabilityTestFixtureFactory>
): ReturnType<AdmittedHostCapabilityTestFixtureFactory> {
  const fixture = await import("../agents/harness/host-capability.test-support.js");
  return fixture.createAdmittedHostCapabilityTestFixture(...args);
}
export async function loadWebFetchToolFactoryForTest() {
  return (await import("../agents/tools/web-fetch.js")).createWebFetchTool;
}
export async function loadUserTurnTranscriptRecorderFactoryForTest() {
  return (await import("../sessions/user-turn-transcript.js")).createUserTurnTranscriptRecorder;
}
export { buildPluginApi } from "../plugins/api-builder.js";
export {
  createCapturedPluginRegistration,
  type CapturedPluginRegistration,
} from "../plugins/captured-registration.js";
export {
  createPluginRuntimeMediaMock,
  createPluginRuntimeMock,
  type PluginRuntimeMediaMock,
} from "./test-helpers/plugin-runtime-mock.js";

export { createHookRunner } from "../plugins/hooks.js";
