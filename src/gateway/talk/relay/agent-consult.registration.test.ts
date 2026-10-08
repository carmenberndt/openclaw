import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { createGatewayRequestContext } from "../../server-request-context.js";
import { makeContextParams } from "../../server-request-context.test-support.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createIdleRelayProvider } from "./index.test-support.js";
import { registerTalkRealtimeRelayAgentRun } from "./operations.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";
import { relaySessions } from "./state.js";

const activeRelaySessions = new Map<string, string>();
usePersistentRelayTestState(activeRelaySessions);

describe("relay consult registration authority", () => {
  it.for(["current", "caller", "relay"] as const)(
    "fences delegated voice registration while queued (%s)",
    async (revoked, { signal }) => {
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = () => ({});
      const session = createTalkRealtimeRelaySession({
        context,
        connId: "conn-1",
        cfg: {},
        provider: createIdleRelayProvider(),
        providerConfig: {},
        instructions: "brief",
        tools: [],
        controlSource: "transcript",
        sessionTarget: prepareTalkSessionTarget({}, "main"),
      });
      const voiceSessionId = session.relaySessionId;
      activeRelaySessions.set(voiceSessionId, "conn-1");
      const relay = relaySessions.get(voiceSessionId);
      if (!relay) {
        throw new Error("Expected the created relay owner");
      }
      const sessionKey = relay.sessionTarget.sessionKey;
      const queued = createDeferred();
      const entered = createDeferred();
      const releaseQueue = createDeferred();
      let callerCurrent = true;
      let blocker: Promise<void> | undefined;
      let release: (() => void) | undefined;
      const registerVoice = vi.fn(async (assertCurrent: () => void) => {
        blocker = runOpenClawAgentWriteAdmission({ agentId: "main" }, async () => {
          entered.resolve();
          await releaseQueue.promise;
        });
        await entered.promise;
        const pending = voiceSessions.registerClientVoiceConsultRun({
          agentId: "main",
          sessionKey,
          voiceSessionId,
          runId: "run-1",
          assertCurrent,
        });
        queued.resolve();
        return await pending;
      });
      const pending = registerTalkRealtimeRelayAgentRun({
        relaySessionId: voiceSessionId,
        connId: "conn-1",
        sessionKey,
        runId: "run-1",
        callId: "call-1",
        assertCurrent: () => {
          if (!callerCurrent) {
            throw new Error("Accepted caller was cancelled");
          }
        },
        registerVoice,
      });
      const settled = pending.then(
        (registered) => {
          release = registered;
          return undefined;
        },
        (error: unknown) => error,
      );
      try {
        await withinTest(
          Promise.race([
            queued.promise,
            settled.then(() => {
              throw new Error("Relay completed before registration queued");
            }),
          ]),
          signal,
        );
        if (revoked === "caller") {
          callerCurrent = false;
        } else if (revoked === "relay") {
          relay.toolCalls.markCancelled(["call-1"], "cancelled-turn");
        }
        releaseQueue.resolve();
        const error = await settled;
        await blocker;
        expect(registerVoice).toHaveBeenCalledOnce();
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.consultRunIds).toEqual(
          revoked === "current" ? ["run-1"] : [],
        );
        if (revoked === "current") {
          expect(error).toBeUndefined();
          expect(voiceSessions.resolveClientVoiceRunBinding("run-1")).toBeDefined();
          expect(relay.activeAgentRuns.size).toBe(1);
          release?.();
        } else {
          expect(error).toMatchObject({
            message:
              revoked === "caller"
                ? "Accepted caller was cancelled"
                : "Realtime provider cancelled the tool call before run registration",
          });
          expect(voiceSessions.resolveClientVoiceRunBinding("run-1")).toBeUndefined();
        }
        expect(relay.activeAgentRuns.size).toBe(0);
        expect(relay.activeAgentToolCalls.size).toBe(0);
      } finally {
        releaseQueue.resolve();
        await settled;
        await blocker;
        release?.();
      }
    },
  );
});
