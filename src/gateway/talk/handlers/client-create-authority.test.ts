import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeSqliteReadSql,
} from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target-paths.js";
import * as sqliteSnapshotSource from "../../../infra/sqlite-snapshot-source.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { closeCachedOpenClawAgentDatabase } from "../../../state/openclaw-agent-db-lifecycle.js";
import * as readonlyOpen from "../../../state/openclaw-agent-db-readonly-open.js";
import { closeIdleOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly-scope.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../../state/openclaw-agent-db.js";
import { resetClientVoiceConfirmationStateForTest } from "../../../talk/client-voice-confirmation.test-support.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { cleanupTalkConnection } from "../session-registry.js";
import {
  completeTalkVoiceChange,
  readTalkVoiceSelection,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "../voice-selection.js";
import { createTalkClient } from "./client-create.js";
import {
  browserSession,
  createDelegatedBrowserProviderFixture,
  type BrowserRequest,
} from "./client-fixtures.test-support.js";
import { talkClientHandlers } from "./client.js";
import { talkVoiceHandlers } from "./voice.js";

const voiceMocks = vi.hoisted(() => ({ resolveConfiguredRealtimeVoiceProvider: vi.fn() }));
vi.mock("../../../talk/provider-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-resolver.js")>()),
  resolveConfiguredRealtimeVoiceProvider: voiceMocks.resolveConfiguredRealtimeVoiceProvider,
}));
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const sessionKey = "agent:main:main";
const sessionId = "voice-transcript-session";
let tempDir: string;
let ownedVoiceSessionId: string | undefined;
let ownedVoiceSessionKey = sessionKey;
let forbiddenSnapshotStacks: string[] = [];
let observeAdmission:
  | ((request: operationAdmission.SqliteWorkerAdmissionRequest, run: () => void) => void)
  | undefined;
function configureDelegatedBrowserProvider(
  createBrowserSession: (request: BrowserRequest) => Promise<typeof browserSession>,
) {
  const fixture = createDelegatedBrowserProviderFixture(createBrowserSession, tempDir);
  voiceMocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
    provider: fixture.provider,
    providerConfig: {},
    capabilities: fixture.provider.capabilities,
  });
  return fixture;
}
async function invokeCreate(options: GatewayRequestHandlerOptions) {
  const admission = resolveSessionMutationAuthorization({
    method: "talk.client.create",
    requestParams: options.params,
    context: options.context,
    client: options.client,
  });
  if (admission.error) {
    options.respond(false, undefined, admission.error);
    return;
  }
  await createTalkClient({ ...options, sessionMutationAuthorization: admission.authorization });
}
async function invokeClose(params: Record<string, unknown>) {
  const respond = vi.fn();
  await talkClientHandlers["talk.client.close"]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
    client: { connId: "conn-close" },
  } as never);
  return respond;
}

describe("voice creation authority", () => {
  const tempDirs = useAutoCleanupTempDirTracker((remove) =>
    afterEach(async () => {
      if (ownedVoiceSessionId) {
        await closeTalkClientGatewayControlSession({
          voiceSessionId: ownedVoiceSessionId,
          sessionKey: ownedVoiceSessionKey,
          connId: "conn-close",
        });
      }
      cleanupTalkConnection("conn-close", { warn: vi.fn() });
      clientVoiceSessionTesting.reset();
      resetClientVoiceConfirmationStateForTest();
      try {
        await cleanupSessionStateForTest({ stateDir: tempDir });
      } finally {
        envSnapshot.restore();
        remove();
        vi.restoreAllMocks();
      }
      expect(forbiddenSnapshotStacks).toEqual([]);
    }),
  );
  beforeEach(async () => {
    vi.clearAllMocks();
    forbiddenSnapshotStacks = [];
    observeAdmission = undefined;
    let inWorkerGrant = false;
    const admitOperation = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        admitOperation((request, grant) => {
          const run = () => {
            const previous = inWorkerGrant;
            inWorkerGrant = true;
            try {
              admit(request, grant);
            } finally {
              inWorkerGrant = previous;
            }
          };
          if (observeAdmission) {
            observeAdmission(request, run);
          } else {
            run();
          }
        }, attachment),
    );
    const snapshot = sqliteSnapshotSource.prepareSqliteReadOnlyLocationSync;
    vi.spyOn(sqliteSnapshotSource, "prepareSqliteReadOnlyLocationSync").mockImplementation(
      (...args) => {
        if (inWorkerGrant) {
          const error = new Error("Synchronous SQLite snapshot requested inside a worker grant");
          forbiddenSnapshotStacks.push(error.stack ?? error.message);
          throw error;
        }
        return snapshot(...args);
      },
    );
    ownedVoiceSessionId = undefined;
    ownedVoiceSessionKey = sessionKey;
    tempDir = tempDirs.make("openclaw-voice-authority-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
  });
  it("replaces a voice on the same chat only after both the browser and provider are ready", async () => {
    const createBrowserSession = vi.fn(async (request: BrowserRequest) => ({
      ...browserSession,
      model: request.model,
      voice: request.voice ?? "cove",
    }));
    const fixture = configureDelegatedBrowserProvider(createBrowserSession);
    Object.assign(fixture.provider, { voices: ["cove", "ember"] });
    const respond = vi.fn();
    const create = (params: Record<string, unknown>) =>
      invokeCreate({
        params: { sessionKey, capabilities: ["voice-selection"], ...params },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never);
    await create({ provider: "openai", model: "gpt-live-1-codex" });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ model: "gpt-live-1-codex", voice: "cove" }),
      undefined,
    );
    const originalId = respond.mock.calls.at(-1)?.[1].voiceSessionId as string;
    ownedVoiceSessionId = originalId;
    createBrowserSession.mock.calls[0]?.[0].gatewayControl?.onReady?.();
    const original = resolveTalkVoiceSession({
      kind: "client",
      connId: fixture.client.connId,
      voiceSessionId: originalId,
    });
    expect(readTalkVoiceSelection(original)).toMatchObject({
      sessionKey,
      voice: "cove",
      voices: ["cove", "ember"],
      canChange: true,
    });
    const send = vi.fn();
    const changing = requestTalkVoiceChange({
      session: original,
      voice: "ember",
      requesterConnId: fixture.client.connId,
      assertCurrent: () => {},
      send,
    });
    void changing.catch(() => {});
    const changeId = send.mock.calls[0]?.[0].changeId as string;
    await create({ voiceChangeId: changeId, voiceSessionId: originalId });
    expect(respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "A voice replacement requires a fresh voice session id" }),
    );
    expect(createBrowserSession).toHaveBeenCalledOnce();
    expect(await invokeClose({ sessionKey, voiceSessionId: originalId })).toHaveBeenCalledWith(
      true,
      { ok: true },
      undefined,
    );
    await create({ voiceChangeId: changeId, model: "gpt-realtime-2.1", voice: "cove" });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ model: "gpt-live-1-codex", voice: "ember" }),
      undefined,
    );
    const replacementId = respond.mock.calls.at(-1)?.[1].voiceSessionId as string;
    ownedVoiceSessionId = replacementId;
    expect(replacementId).not.toBe(originalId);
    const replacementRequest = createBrowserSession.mock.calls[1]?.[0];
    expect(replacementRequest).toMatchObject({ model: "gpt-live-1-codex", voice: "ember" });
    let applied = false;
    void changing.then(
      () => {
        applied = true;
      },
      () => {},
    );
    const completed = completeTalkVoiceChange({
      changeId,
      connId: fixture.client.connId,
      voiceSessionId: replacementId,
      outcome: "ready",
    });
    void completed.catch(() => {});
    await Promise.resolve();
    expect(applied).toBe(false);
    replacementRequest?.gatewayControl?.onReady?.();
    await completed;
    await expect(changing).resolves.toMatchObject({
      status: "applied",
      voiceSessionId: replacementId,
      sessionKey,
      voice: "ember",
    });
    expect(clientVoiceSessionTesting.readRecord("main", originalId)?.status).toBe("closed");
    expect(clientVoiceSessionTesting.readRecord("main", replacementId)?.status).toBe("open");
  });

  it.each(
    ["same-store", "custom-store", "incognito"].flatMap((kind) =>
      [false, true].map((revoked) => ({ kind, revoked })),
    ),
  )(
    "creates a $kind replacement without cold reads in write grants (revoked=$revoked)",
    async ({ kind, revoked }) => {
      const createBrowserSession = vi.fn(async (request: BrowserRequest) => ({
        ...browserSession,
        voice: request.voice ?? "cove",
      }));
      const fixture = configureDelegatedBrowserProvider(createBrowserSession);
      Object.assign(fixture.provider, { voices: ["cove", "ember"] });
      const config = {
        ...fixture.context.getRuntimeConfig(),
        ...(kind === "custom-store"
          ? { session: { store: path.join(tempDir, "custom.sqlite") } }
          : {}),
      };
      fixture.context.getRuntimeConfig = () => config;
      const key = kind === "incognito" ? "agent:main:dashboard:incognito-voice-source" : sessionKey;
      ownedVoiceSessionKey = key;
      const scope = { agentId: "main", sessionKey: key, storePath: config.session?.store };
      await replaceSessionEntry(scope, {
        sessionId,
        updatedAt: Date.now(),
        ...(kind === "incognito" ? { incognito: true } : {}),
      });
      const respond = vi.fn();
      const create = (voiceChangeId?: string) =>
        invokeCreate({
          params: { sessionKey: key, capabilities: ["voice-selection"], voiceChangeId },
          respond,
          context: fixture.context,
          client: fixture.client,
        } as never);
      await create();
      expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(true);
      ownedVoiceSessionId = respond.mock.lastCall?.[1].voiceSessionId;
      createBrowserSession.mock.calls[0]?.[0].gatewayControl?.onReady?.();
      const original = resolveTalkVoiceSession({
        kind: "client",
        connId: fixture.client.connId,
        voiceSessionId: ownedVoiceSessionId,
      });
      const sourcePath = resolveUnsuffixedSqliteTargetFromSessionStorePath(
        original.sessionTarget.storePath,
      ).path;
      const changed = vi.fn();
      const change = Promise.resolve(
        talkVoiceHandlers["talk.voice.set"]!({
          req: { type: "req", id: "change", method: "talk.voice.set", params: {} },
          params: { voiceSessionId: ownedVoiceSessionId, voice: "ember" },
          respond: changed,
          context: fixture.context,
          client: fixture.client,
          isWebchatConnect: () => false,
        } as never),
      );
      const changeId = fixture.context.broadcastToConnIds.mock.calls.find(
        ([event]) => event === "talk.voice.change",
      )?.[1]?.changeId;
      expect(changeId).toBeTypeOf("string");
      let creatingVoice = false;
      let admittedReplacementId: string | undefined;
      let resetSource = false;
      let inGrant = false;
      let coldOpenAttempts = 0;
      const reads = observeSqliteReadSql(StatementSync.prototype);
      const grantQueries: string[] = [];
      observeAdmission = (request, run) => {
        if (creatingVoice) {
          if (revoked && !resetSource && request.stage === "prepare") {
            replaceSessionEntrySync(scope, {
              sessionId: "reset-voice-source",
              updatedAt: Date.now(),
              ...(kind === "incognito" ? { incognito: true } : {}),
            });
            resetSource = true;
          }
          closeIdleOpenClawAgentDatabaseReadOnly(sourcePath);
        }
        const start = reads.queries.length;
        inGrant = creatingVoice;
        try {
          run();
        } finally {
          inGrant = false;
          if (creatingVoice) {
            grantQueries.push(...reads.queries.slice(start));
          }
        }
      };
      const open = readonlyOpen.openOpenClawAgentDatabaseReadOnly;
      const openSpy = vi
        .spyOn(readonlyOpen, "openOpenClawAgentDatabaseReadOnly")
        .mockImplementation((...args) => {
          if (inGrant) {
            coldOpenAttempts += 1;
            throw new Error("Cold source admission ran inside the voice worker grant");
          }
          return open(...args);
        });
      const createVoice = voiceSessions.createOrResumeClientVoiceSession;
      const createSpy = vi
        .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
        .mockImplementation(async (params) => {
          if (kind !== "incognito") {
            const database = getOpenClawAgentDatabaseIfOpen({
              agentId: "main",
              path: sourcePath,
            });
            if (database) {
              closeCachedOpenClawAgentDatabase(database, { eviction: true });
            }
          }
          creatingVoice = true;
          try {
            return (admittedReplacementId = await createVoice(params));
          } finally {
            creatingVoice = false;
          }
        });
      try {
        await create(changeId);
        expect(coldOpenAttempts).toBe(0);
        if (revoked) {
          expect(resetSource).toBe(true);
          expect(admittedReplacementId).toBeUndefined();
          expect(respond.mock.lastCall?.[0]).toBe(false);
          expect(respond.mock.lastCall?.[2]?.message).not.toContain("Cold source admission");
        } else {
          expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(true);
          ownedVoiceSessionId = respond.mock.lastCall?.[1].voiceSessionId;
          expect(clientVoiceSessionTesting.readRecord("main", ownedVoiceSessionId!)?.status).toBe(
            "open",
          );
        }
        if (kind === "same-store") {
          expect(grantQueries.filter(isSessionEntryDataSql)).toEqual([]);
        }
      } finally {
        createSpy.mockRestore();
        openSpy.mockRestore();
        observeAdmission = undefined;
        reads.restore();
        cleanupTalkConnection(fixture.client.connId, fixture.context.logGateway);
        await change;
      }
    },
  );

  it.each(["missing", "idless"])(
    "publishes the ensured %s chat before preparing voice authority",
    async (kind) => {
      const key = `agent:main:voice-${kind}`;
      ownedVoiceSessionKey = key;
      if (kind === "idless") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: key },
          { sessionId: "", updatedAt: 1 },
        );
      }
      const fixture = configureDelegatedBrowserProvider(async () => browserSession);
      const respond = vi.fn();
      await invokeCreate({
        params: { sessionKey: key, provider: "openai" },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never);
      expect(respond.mock.lastCall?.[0]).toBe(true);
      ownedVoiceSessionId = respond.mock.lastCall?.[1].voiceSessionId;
      expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.sessionId).toBeTruthy();
      expect(clientVoiceSessionTesting.readRecord("main", ownedVoiceSessionId!)).toMatchObject({
        sessionKey: key,
        status: "open",
      });
    },
  );

  it("refuses ordinary voice creation when its session changes during worker preparation", async () => {
    const fixture = configureDelegatedBrowserProvider(async () => browserSession);
    const voiceSessionId = "voice-revoked-before-commit";
    let creatingVoice = false;
    let revoked = false;
    const create = voiceSessions.createOrResumeClientVoiceSession;
    const createSpy = vi
      .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
      .mockImplementation(async (...args) => {
        creatingVoice = true;
        try {
          return await create(...args);
        } finally {
          creatingVoice = false;
        }
      });
    observeAdmission = (request, run) => {
      if (creatingVoice && !revoked && request.stage === "prepare") {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { sessionId: "replacement", updatedAt: Date.now() },
        );
        revoked = true;
      }
      run();
    };
    const respond = vi.fn();
    try {
      await invokeCreate({
        params: { sessionKey, provider: "openai", voiceSessionId },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never);
      expect(revoked).toBe(true);
      expect(respond.mock.lastCall?.[0]).toBe(false);
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toBeUndefined();
      expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
    } finally {
      createSpy.mockRestore();
      observeAdmission = undefined;
    }
  });

  it.each([false, true])(
    "retains a replacement source SDK guard at native commit (revoked=%s)",
    async (revoked) => {
      const createBrowserSession = vi.fn(async (request: BrowserRequest) => ({
        ...browserSession,
        voice: request.voice ?? "cove",
      }));
      const fixture = configureDelegatedBrowserProvider(createBrowserSession);
      Object.assign(fixture.provider, { voices: ["cove", "ember"] });
      const respond = vi.fn();
      const create = (params: Record<string, unknown>) =>
        invokeCreate({
          params: { sessionKey, capabilities: ["voice-selection"], ...params },
          respond,
          context: fixture.context,
          client: fixture.client,
        } as never);
      await create({});
      expect(respond.mock.lastCall?.[0]).toBe(true);
      ownedVoiceSessionId = respond.mock.lastCall?.[1].voiceSessionId;
      createBrowserSession.mock.calls[0]?.[0].gatewayControl?.onReady?.();
      let replacementId: string | undefined;
      const createVoice = voiceSessions.createOrResumeClientVoiceSession;
      const createSpy = vi
        .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
        .mockImplementation(async (...args) => {
          replacementId = args[0].voiceSessionId;
          return createVoice(...args);
        });
      let nativeCommitGuard = false;
      const change = Promise.resolve(
        talkVoiceHandlers["talk.voice.set"]!({
          req: { type: "req", id: "sdk-change", method: "talk.voice.set", params: {} },
          params: { voiceSessionId: ownedVoiceSessionId, voice: "ember" },
          respond: vi.fn(),
          context: fixture.context,
          client: fixture.client,
          isWebchatConnect: () => false,
          sessionMutationCommitGuard: () => {
            expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sessionId);
            if (
              replacementId &&
              getOpenClawAgentDatabaseIfOpen({ agentId: "main" })?.db.isTransaction &&
              clientVoiceSessionTesting.readRecord("main", replacementId)
            ) {
              nativeCommitGuard = true;
              if (revoked) {
                throw new Error("Replacement SDK authority revoked");
              }
            }
          },
        } as never),
      );
      const changeId = fixture.context.broadcastToConnIds.mock.calls.find(
        ([event]) => event === "talk.voice.change",
      )?.[1]?.changeId;
      expect(changeId).toBeTypeOf("string");
      try {
        await create({ voiceChangeId: changeId });
        expect(nativeCommitGuard, respond.mock.lastCall?.[2]?.message).toBe(true);
        if (!replacementId) {
          throw new Error("Voice metadata creation was not reached");
        }
        expect(respond.mock.lastCall?.[0]).toBe(!revoked);
        if (revoked) {
          expect(respond.mock.lastCall?.[2]?.message).toContain(
            "Replacement SDK authority revoked",
          );
          expect(clientVoiceSessionTesting.readRecord("main", replacementId)).toBeUndefined();
          expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
        } else {
          ownedVoiceSessionId = replacementId;
          expect(clientVoiceSessionTesting.readRecord("main", replacementId)?.status).toBe("open");
        }
      } finally {
        createSpy.mockRestore();
        cleanupTalkConnection(fixture.client.connId, fixture.context.logGateway);
        await change;
      }
    },
  );

  it("retains a released SDK's SQLite-reading guard inside the native voice commit", async () => {
    const fixture = configureDelegatedBrowserProvider(async () => browserSession);
    const voiceSessionId = "voice-sdk-guard";
    let committedGuard = false;
    const respond = vi.fn();
    await invokeCreate({
      params: { sessionKey, provider: "openai", voiceSessionId },
      respond,
      context: fixture.context,
      client: fixture.client,
      sessionMutationCommitGuard: () => {
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sessionId);
        if (
          getOpenClawAgentDatabaseIfOpen({ agentId: "main" })?.db.isTransaction &&
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)
        ) {
          committedGuard = true;
        }
      },
    } as never);
    ownedVoiceSessionId = voiceSessionId;
    expect(respond.mock.lastCall?.[0]).toBe(true);
    expect(committedGuard).toBe(true);
  });
});
