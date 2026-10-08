import { copyFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { captureGatewayToolReceiptAssertion } from "../../../agents/tools/gateway-caller-context.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target-paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as sqliteReadScope from "../../../infra/sqlite-schema-facts.js";
import * as sqliteSnapshotSource from "../../../infra/sqlite-snapshot-source.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import {
  findOpenClawAgentDatabaseIdentity,
  readOpenClawAgentDatabaseIdentity,
} from "../../../state/openclaw-agent-db-identity.js";
import {
  closeCachedOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
} from "../../../state/openclaw-agent-db-lifecycle.js";
import * as readonlyOpen from "../../../state/openclaw-agent-db-readonly-open.js";
import { closeIdleOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly-scope.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { resetClientVoiceConfirmationStateForTest } from "../../../talk/client-voice-confirmation.test-support.js";
import { readVoiceSessionRecordInTransaction } from "../../../talk/client-voice-session-store.js";
import * as voiceWriters from "../../../talk/client-voice-session-write.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "../../session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { roleClient, rolePolicyConfig } from "../../session-sharing.test-utils.js";
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
  it.each([
    { mixed: false, grant: false, revoked: undefined },
    { mixed: false, grant: false, revoked: "foreign" },
    { mixed: true, grant: false, revoked: undefined },
    { mixed: true, grant: false, revoked: "foreign" },
    { mixed: true, grant: false, revoked: "local" },
    { mixed: false, grant: true, revoked: undefined },
    { mixed: false, grant: true, revoked: "local" },
  ])(
    "validates cross-store voice authority atomically (mixed=$mixed, grant=$grant, revoked=$revoked)",
    async ({ mixed, grant, revoked }) => {
      const local = { agentId: "main", sessionKey };
      const foreign = { agentId: "source", sessionKey: "agent:source:main" };
      const foreignEntry = { sessionId: "foreign-source", updatedAt: 1 };
      // The injected foreign commit must not compete with automatic fixture reclamation.
      await applySessionEntryOperation(
        foreign,
        { kind: "fields", patch: foreignEntry },
        { fallbackEntry: foreignEntry, replaceEntry: true, skipMaintenance: true },
      );
      const config: OpenClawConfig = {
        ...rolePolicyConfig(),
        agents: { entries: { main: {}, source: {} } },
      };
      const client = roleClient("write", "cross-store-voice");
      const prepare = (scope: typeof local, method = "sessions.patch") => {
        const result = resolveSessionMutationAuthorization({
          method,
          requestParams:
            method === "talk.client.create"
              ? { sessionKey: scope.sessionKey }
              : { key: scope.sessionKey, agentId: scope.agentId },
          context: { getRuntimeConfig: () => config } as GatewayRequestHandlerOptions["context"],
          client,
        });
        expect(result.error).toBeNull();
        return result.authorization!;
      };
      openOpenClawAgentDatabase(local);
      const localReader = retainOpenClawAgentDatabaseReadOnly(local);
      if (!localReader.found) {
        throw new Error("Expected the authorization owner's native reader");
      }
      const localReads = trackSqliteStatementExecutions(localReader.database.db, ["data"], (sql) =>
        isSessionEntryDataSql(sql) || /\bcache_entries\b/i.test(sql) ? "data" : null,
      );
      const foreignAuthority = prepare(foreign).assertCurrent;
      const localAuthority = mixed ? prepare(local).assertCurrent : undefined;
      const transactionAuthority = grant ? prepare(local, "talk.client.create") : undefined;
      if (mixed) {
        expect(localReads.counts.data).toBeGreaterThan(0);
      }
      let grantLocalReads = 0;
      let revokedSource = false;
      let inGrant = false;
      const voiceSessionId = "cross-store-voice";
      const foreignDatabase = openOpenClawAgentDatabase(foreign);
      const foreignIdentity = readOpenClawAgentDatabaseIdentity(foreignDatabase);
      let checkedBeforeWrite = false;
      let checkedAfterWrite = false;
      let sdkSawCommittedVoice = false;
      let sdkMutation: Promise<void> | undefined;
      const observeForeignRead = () => {
        if (localReader.database.db.isTransaction) {
          const written = readVoiceSessionRecordInTransaction(localReader.database, voiceSessionId);
          checkedBeforeWrite ||= !written;
          checkedAfterWrite ||= Boolean(written);
          if (revoked && written && !revokedSource) {
            revokedSource = true;
            const database = revoked === "local" ? localReader.database : foreignDatabase;
            database.db
              .prepare(
                "UPDATE session_nodes SET current_session_id = 'revoked-source', entry_json = json_set(entry_json, '$.sessionId', 'revoked-source') WHERE session_key = ?",
              )
              .run(revoked === "local" ? local.sessionKey : foreign.sessionKey);
          } else if (!revoked && !sdkMutation) {
            sdkMutation = Promise.resolve().then(() => {
              sdkSawCommittedVoice =
                !localReader.database.db.isTransaction &&
                readVoiceSessionRecordInTransaction(localReader.database, voiceSessionId)
                  ?.status === "open";
              replaceSessionEntrySync(foreign, { sessionId: "sdk-successor", updatedAt: 2 });
            });
            void sdkMutation.catch(() => {});
          }
        }
      };
      const freshRead = sqliteReadScope.runSqliteReadOperationSync;
      const foreignReads = vi
        .spyOn(sqliteReadScope, "runSqliteReadOperationSync")
        .mockImplementation((database, operation, mode) => {
          if (
            mode === "fresh" &&
            findOpenClawAgentDatabaseIdentity({ db: database })?.identity ===
              foreignIdentity.identity
          ) {
            observeForeignRead();
          }
          return freshRead(database, operation, mode);
        });
      const open = readonlyOpen.openOpenClawAgentDatabaseReadOnly;
      const openSpy = vi
        .spyOn(readonlyOpen, "openOpenClawAgentDatabaseReadOnly")
        .mockImplementation((...args) => {
          if (inGrant) {
            throw new Error("Cold source admission ran inside the voice worker grant");
          }
          return open(...args);
        });
      observeAdmission = (_request, run) => {
        const start = localReads.counts.data;
        inGrant = true;
        try {
          run();
        } finally {
          inGrant = false;
          grantLocalReads += localReads.counts.data - start;
        }
      };
      try {
        const creating = voiceSessions.createOrResumeClientVoiceSession({
          ...local,
          voiceSessionId,
          origin: "client",
          ...(transactionAuthority
            ? {
                requester: foreignAuthority,
                source: {
                  storePath: resolveOpenClawAgentSqlitePath(local),
                  assertCurrent: transactionAuthority.assertCurrent,
                  prepareWorkerGrant: transactionAuthority.prepareWorkerGrant,
                },
              }
            : mixed
              ? {
                  source: {
                    storePath: resolveOpenClawAgentSqlitePath(foreign),
                    assertCurrent: composeSessionSourceAssertion([
                      localAuthority,
                      foreignAuthority,
                    ]),
                  },
                }
              : { requester: foreignAuthority }),
        });
        if (revoked) {
          await expect(creating).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
          await expect(creating).rejects.toThrow(
            `session changed before ${grant ? "talk.client.create" : "sessions.patch"}; retry the request`,
          );
          expect(revokedSource).toBe(true);
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toBeUndefined();
        } else {
          await expect(creating).resolves.toBe(voiceSessionId);
          await sdkMutation;
          expect(sdkSawCommittedVoice).toBe(true);
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
        }
        expect(checkedBeforeWrite).toBe(true);
        expect(checkedAfterWrite).toBe(true);
        expect(grantLocalReads).toBe(0);
      } finally {
        observeAdmission = undefined;
        await sdkMutation;
        foreignReads.mockRestore();
        openSpy.mockRestore();
        localReads.restore();
        localReader.claim.release();
      }
    },
  );
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
            return (admittedReplacementId = await createVoice({
              ...params,
              assertCurrent: () => {
                params.assertCurrent?.();
                if (kind !== "same-store" && revoked && !resetSource) {
                  replaceSessionEntrySync(scope, {
                    sessionId: "reset-voice-source",
                    updatedAt: Date.now(),
                    ...(kind === "incognito" ? { incognito: true } : {}),
                  });
                  resetSource = true;
                }
              },
            }));
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

  it.each(["identity", "label"] as const)(
    "checks final foreign %s before acknowledging a committed voice session",
    async (change) => {
      const fixture = configureDelegatedBrowserProvider(async () => browserSession);
      const voiceSessionId = "voice-final-foreign";
      const createVoice = voiceSessions.createOrResumeClientVoiceSession;
      let changed = false;
      const createSpy = vi
        .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
        .mockImplementation(async (...args) => {
          const result = await createVoice(...args);
          const peer = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
          try {
            peer
              .prepare(
                change === "identity"
                  ? "UPDATE session_nodes SET current_session_id = 'foreign-successor', entry_json = json_set(entry_json, '$.sessionId', 'foreign-successor') WHERE session_key = ?"
                  : "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'foreign-label') WHERE session_key = ?",
              )
              .run(sessionKey);
            changed = true;
          } finally {
            peer.close();
          }
          return result;
        });
      const reads = observeSqliteReadSql(StatementSync.prototype);
      const grantQueries: string[] = [];
      observeAdmission = (_request, run) => {
        const start = reads.queries.length;
        try {
          run();
        } finally {
          grantQueries.push(...reads.queries.slice(start));
        }
      };
      const respond = vi.fn();
      try {
        await invokeCreate({
          params: { sessionKey, provider: "openai", voiceSessionId },
          respond,
          context: fixture.context,
          client: fixture.client,
        } as never);
        expect(changed).toBe(true);
        expect(createSpy).toHaveBeenCalledOnce();
        expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(
          change === "label",
        );
        expect(grantQueries.filter(isSessionEntryDataSql)).toEqual([]);
        if (change === "identity") {
          expect(respond.mock.lastCall?.[2]?.message).toContain(
            "session changed before talk.client.create",
          );
          expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe(
            "closed",
          );
        } else {
          ownedVoiceSessionId = voiceSessionId;
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
        }
      } finally {
        observeAdmission = undefined;
        reads.restore();
        createSpy.mockRestore();
      }
    },
  );

  it.each(["missing", "idless"] as const)(
    "keeps the acknowledged %s creation bound to its original physical source",
    async (kind) => {
      const key = `agent:main:created-source-${kind}`;
      ownedVoiceSessionKey = key;
      if (kind === "idless") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: key },
          { sessionId: "", updatedAt: 1 },
        );
      }
      const fixture = configureDelegatedBrowserProvider(async () => browserSession);
      const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const displacedPath = `${sourcePath}.committed`;
      const ensure = voiceWriters.ensureClientVoiceAgentSessionEntry;
      let replaced = false;
      let successorBytes: Buffer | undefined;
      const ensureSpy = vi
        .spyOn(voiceWriters, "ensureClientVoiceAgentSessionEntry")
        .mockImplementationOnce(async (params) => {
          const ensuredId = await ensure(params);
          await closeOpenClawAgentDatabasesAsync(tempDir);
          renameSync(sourcePath, displacedPath);
          copyFileSync(displacedPath, sourcePath);
          successorBytes = readFileSync(sourcePath);
          replaced = true;
          return ensuredId;
        });
      const respond = vi.fn();
      try {
        await invokeCreate({
          params: { sessionKey: key, provider: "openai", voiceSessionId: "created-source-voice" },
          respond,
          context: fixture.context,
          client: fixture.client,
        } as never);
        expect(replaced).toBe(true);
        expect(ensureSpy).toHaveBeenCalledOnce();
        expect(respond.mock.lastCall?.[0]).toBe(false);
        expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
        await closeOpenClawAgentDatabasesAsync(tempDir);
        expect(readFileSync(sourcePath)).toEqual(successorBytes);
      } finally {
        ensureSpy.mockRestore();
        await closeOpenClawAgentDatabasesAsync(tempDir);
        if (replaced) {
          unlinkSync(sourcePath);
          renameSync(displacedPath, sourcePath);
        }
      }
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

  it.each(
    [false, true].flatMap((receipt) => [false, true].map((revoked) => ({ receipt, revoked }))),
  )(
    "retains a replacement source SDK guard at native commit (revoked=$revoked, receipt=$receipt)",
    async ({ revoked, receipt }) => {
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
      const assertSdkCurrent = () => {
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
      };
      const change = Promise.resolve(
        talkVoiceHandlers["talk.voice.set"]!({
          req: { type: "req", id: "sdk-change", method: "talk.voice.set", params: {} },
          params: { voiceSessionId: ownedVoiceSessionId, voice: "ember" },
          respond: vi.fn(),
          context: fixture.context,
          client: fixture.client,
          isWebchatConnect: () => false,
          sessionMutationCommitGuard: receipt
            ? captureGatewayToolReceiptAssertion(
                composeSessionSourceAssertion([
                  captureExternalSessionCommitGuard(assertSdkCurrent),
                ]),
              )
            : assertSdkCurrent,
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
