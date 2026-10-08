import { existsSync } from "node:fs";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import type { ChatSendInternalOptions } from "../../server-methods/chat-send-options.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { createGatewayRequestContext } from "../../server-request-context.js";
import { makeContextParams } from "../../server-request-context.test-support.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { talkClientHandlers } from "./client.js";

const chat = vi.hoisted(() => ({ current: true, dispatched: vi.fn() }));
vi.mock("../../server-methods/chat-send-handler.js", () => ({
  handleTrustedInternalChatSend: async (
    request: GatewayRequestHandlerOptions,
    _onAdmissionOwned: unknown,
    options: ChatSendInternalOptions,
  ) => {
    const assertWorkAdmissionCurrent = () => {
      if (!chat.current) {
        throw new Error("Accepted chat was cancelled during registration");
      }
    };
    const assertCurrent = () => {
      assertWorkAdmissionCurrent();
      request.sessionMutationCommitGuard?.();
    };
    let release: void | (() => void) = undefined;
    try {
      assertCurrent();
      release = await options.beforeDispatch?.({
        runId: "queued-consult",
        assertCurrent,
        assertWorkAdmissionCurrent,
      });
      assertCurrent();
      chat.dispatched();
      request.respond(true, { runId: "queued-consult", status: "started" });
    } catch (error) {
      release?.();
      request.respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
    }
  },
}));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const scope = { agentId: "main", sessionKey: "agent:main:consult-authority" };
const voiceSessionId = "consult-authority-voice";
let tempDir: string;
let inWorkerGrant = false;
let workerGrantReads: string[] = [];
let sqlReads: ReturnType<typeof observeSqliteReadSql> | undefined;

describe("voice consult registration authority", () => {
  const tempDirs = useAutoCleanupTempDirTracker((remove) =>
    afterEach(async () => {
      clientVoiceSessionTesting.reset();
      try {
        await cleanupSessionStateForTest({ stateDir: tempDir });
      } finally {
        sqlReads?.restore();
        vi.restoreAllMocks();
        envSnapshot.restore();
        remove();
      }
    }),
  );

  beforeEach(async () => {
    vi.clearAllMocks();
    chat.current = true;
    inWorkerGrant = false;
    workerGrantReads = [];
    tempDir = tempDirs.make("openclaw-consult-authority-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    await replaceSessionEntry(scope, { sessionId: "original-consult-session", updatedAt: 1 });
    await voiceSessions.createOrResumeClientVoiceSession({
      ...scope,
      voiceSessionId,
      origin: "client",
    });
    const reads = observeSqliteReadSql(StatementSync.prototype);
    sqlReads = reads;
    const admit = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (authorize, attachment) =>
        admit((request, grant) => {
          const start = reads.queries.length;
          inWorkerGrant = true;
          try {
            authorize(request, grant);
          } finally {
            inWorkerGrant = false;
            workerGrantReads.push(...reads.queries.slice(start));
          }
        }, attachment),
    );
  });

  it.for(["current", "worker-current", "sdk", "session", "chat"] as const)(
    "publishes only a currently authorized queued consult (%s)",
    async (revoked, { signal }) => {
      const config = { agents: { defaults: { workspace: path.join(tempDir, "workspace") } } };
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = () => config;
      context.getCommittedRuntimeConfig = () => config;
      const params = {
        sessionKey: scope.sessionKey,
        voiceSessionId,
        callId: "queued-consult-call",
        name: "openclaw_agent_consult",
        args: { question: "Report the fixture status" },
      };
      const authorized = resolveSessionMutationAuthorization({
        method: "talk.client.toolCall",
        requestParams: params,
        context,
        client: null,
      });
      expect(authorized.error).toBeNull();
      const queued = createDeferred();
      const entered = createDeferred();
      const releaseQueue = createDeferred();
      let sdkCurrent = true;
      let nativeSdkCommitObserved = false;
      let blocker: Promise<void> | undefined;
      const register = voiceSessions.registerClientVoiceConsultRun;
      vi.spyOn(voiceSessions, "registerClientVoiceConsultRun").mockImplementation(async (input) => {
        blocker = runOpenClawAgentWriteAdmission(scope, async () => {
          entered.resolve();
          await releaseQueue.promise;
        });
        await entered.promise;
        const pending = register(input);
        queued.resolve();
        return await pending;
      });
      const respond = vi.fn();
      const running = talkClientHandlers["talk.client.toolCall"]!({
        req: { type: "req", id: "consult-authority", method: "talk.client.toolCall" },
        params,
        context,
        client: null,
        respond,
        sessionMutationAuthorization: authorized.authorization,
        ...(revoked === "sdk" || revoked === "current"
          ? {
              sessionMutationCommitGuard: () => {
                expect(inWorkerGrant).toBe(false);
                expect(loadSessionEntry(scope)?.sessionId).toBe("original-consult-session");
                nativeSdkCommitObserved ||=
                  getOpenClawAgentDatabaseIfOpen(scope)?.db.isTransaction === true;
                if (!sdkCurrent) {
                  throw new Error("SDK consult authority was revoked");
                }
              },
            }
          : {}),
      } as never);
      try {
        await withinTest(
          Promise.race([
            queued.promise,
            Promise.resolve(running).then(() => {
              throw new Error("Consult ended before real registration was queued");
            }),
          ]),
          signal,
        );
        expect(chat.dispatched).not.toHaveBeenCalled();
        if (revoked === "sdk") {
          sdkCurrent = false;
        } else if (revoked === "session") {
          replaceSessionEntrySync(scope, { sessionId: "revoked-consult-session", updatedAt: 2 });
        } else if (revoked === "chat") {
          chat.current = false;
        }
        releaseQueue.resolve();
        await running;
        await blocker;
        const record = clientVoiceSessionTesting.readRecord(scope.agentId, voiceSessionId);
        expect(record).toBeDefined();
        if (revoked === "worker-current" || revoked === "session" || revoked === "chat") {
          // Same-store authority must consume the mutation's supplied row facts.
          expect(workerGrantReads.filter(isSessionEntryDataSql)).toEqual([]);
        }
        if (revoked === "current" || revoked === "worker-current") {
          expect(record?.consultRunIds).toEqual(["queued-consult"]);
          expect(voiceSessions.resolveClientVoiceRunBinding("queued-consult")).toBeDefined();
          expect(chat.dispatched).toHaveBeenCalledOnce();
          expect(respond.mock.lastCall?.[0]).toBe(true);
          expect(nativeSdkCommitObserved).toBe(revoked === "current");
        } else {
          expect(record?.consultRunIds).toEqual([]);
          expect(voiceSessions.resolveClientVoiceRunBinding("queued-consult")).toBeUndefined();
          expect(chat.dispatched).not.toHaveBeenCalled();
          expect(respond.mock.lastCall?.[0]).toBe(false);
        }
      } finally {
        releaseQueue.resolve();
        await running;
        await blocker;
      }
    },
  );

  it("checks a process-held source inside the durable native voice transaction", async () => {
    const sessionKey = "agent:main:dashboard:incognito-native-voice";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey },
      { sessionId: "native-voice-source", updatedAt: 1, incognito: true },
    );
    const authorization = resolveSessionMutationAuthorization({
      method: "talk.client.create",
      requestParams: { sessionKey },
      context: { getRuntimeConfig: () => ({}) } as GatewayRequestHandlerOptions["context"],
      client: null,
    });
    expect(authorization.error).toBeNull();
    const target = authorization.authorization?.talkSessionTarget;
    if (!target) {
      throw new Error("Expected a prepared incognito Talk source");
    }
    const source = retainOpenClawAgentDatabaseReadOnly({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    if (!source.found) {
      throw new Error("Expected the process-held source to remain open");
    }
    let nativeAuthorityObserved = false;
    const reads = trackSqliteStatementExecutions(source.database.db, ["source"], (sql) => {
      if (!isSessionEntryDataSql(sql)) {
        return null;
      }
      return "source";
    });
    try {
      await voiceSessions.createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId: "native-source-voice",
        origin: "client",
        source: {
          storePath: target.storePath,
          assertCurrent: composeSessionSourceAssertion(
            [authorization.authorization!.assertCurrent],
            (assertSource) => {
              assertSource();
              nativeAuthorityObserved ||=
                getOpenClawAgentDatabaseIfOpen({ agentId: "main" })?.db.isTransaction === true;
            },
          ),
        },
      });
      expect(reads.counts.source).toBeGreaterThan(0);
      expect(nativeAuthorityObserved).toBe(true);
      expect(clientVoiceSessionTesting.readRecord("main", "native-source-voice")).toMatchObject({
        sessionKey,
        status: "open",
      });
    } finally {
      reads.restore();
      source.claim.release();
    }
  });

  it.each(["foreign", "incognito"] as const)(
    "prepares a cold native target for a %s requester without caller-thread schema work",
    async (kind) => {
      const sourceKey =
        kind === "incognito" ? "agent:main:dashboard:incognito-cold-native" : scope.sessionKey;
      if (kind === "incognito") {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: sourceKey },
          { sessionId: "cold-native-source", updatedAt: 1, incognito: true },
        );
      }
      const authorized = resolveSessionMutationAuthorization({
        method: "talk.client.create",
        requestParams: { sessionKey: sourceKey },
        context: { getRuntimeConfig: () => ({}) } as GatewayRequestHandlerOptions["context"],
        client: null,
      });
      expect(authorized.error).toBeNull();
      const source =
        kind === "incognito"
          ? retainOpenClawAgentDatabaseReadOnly({
              agentId: "main",
              path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
            })
          : undefined;
      if (source && !source.found) {
        throw new Error("Expected the process-held source to remain open");
      }
      const target = {
        agentId: `cold-native-${kind}`,
        sessionKey: `agent:cold-native-${kind}:main`,
      };
      const targetPath = resolveOpenClawAgentSqlitePath(target);
      const targetPaths = new Set([
        targetPath,
        readDatabasePathIdentitySync(targetPath).canonicalPath,
      ]);
      expect(existsSync(targetPath)).toBe(false);
      let nativeAuthorityObserved = false;
      const schemaSql: string[] = [];
      sqlReads?.restore();
      sqlReads = undefined;
      const sql = observeHostDataSql((query, database) => {
        if (
          database &&
          targetPaths.has(database.location() ?? "") &&
          /\b(?:create\s+(?:(?:unique|virtual)\s+)?(?:table|index|trigger|view)|alter\s+table|drop\s+(?:table|index|trigger|view)|quick_check|integrity_check)\b/i.test(
            query,
          )
        ) {
          schemaSql.push(query);
        }
      });
      try {
        await voiceSessions.createOrResumeClientVoiceSession({
          ...target,
          voiceSessionId: "cold-native-voice",
          origin: "client",
          requester: composeSessionSourceAssertion(
            [authorized.authorization!.assertCurrent],
            (assertSource) => {
              expect(inWorkerGrant).toBe(false);
              assertSource();
              nativeAuthorityObserved ||=
                getOpenClawAgentDatabaseIfOpen(target)?.db.isTransaction === true;
            },
          ),
        });
        expect(schemaSql).toEqual([]);
        expect(nativeAuthorityObserved).toBe(true);
        expect(
          clientVoiceSessionTesting.readRecord(target.agentId, "cold-native-voice"),
        ).toMatchObject({
          sessionKey: target.sessionKey,
          status: "open",
        });
      } finally {
        sql.restore();
        source?.claim.release();
      }
    },
  );
});
