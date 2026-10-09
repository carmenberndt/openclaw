import {
  GatewayChatStreamProjection,
  type EventFrame,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";

type RequestClient = {
  request<T>(method: string, params?: unknown, options?: GatewayProtocolRequestOptions): Promise<T>;
};

/** One browser connection reconstructs wire text before its local listeners share it. */
export class GatewayChatEvents {
  private readonly stream = new GatewayChatStreamProjection();
  private readonly projectedEvents = new WeakMap<EventFrame, readonly EventFrame[]>();
  private generation = 0;

  constructor(private readonly reconnect: (reason: string) => void) {}

  clear(): void {
    this.generation += 1;
    this.stream.clear();
  }

  async request<T>(
    client: RequestClient,
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    const generation = this.generation;
    const result = await client.request<T>(method, params, options);
    if (method === "sessions.messages.unsubscribe" && generation === this.generation) {
      const key = asNullableRecord(result)?.key;
      const request = asNullableRecord(params);
      const agentId =
        (typeof key === "string" ? parseAgentSessionKeyParts(key)?.agentId : undefined) ??
        request?.agentId ??
        (key === "global" && typeof request?.key === "string"
          ? parseAgentSessionKeyParts(request.key)?.agentId
          : undefined);
      this.stream.retire((stream) => {
        const streamAgentId =
          stream.agentId ?? parseAgentSessionKeyParts(stream.sessionKey)?.agentId;
        return stream.sessionKey === key && streamAgentId === agentId;
      });
    }
    return result;
  }

  dispatch(event: EventFrame, listener?: (event: EventFrame) => void): void {
    for (const projected of this.project(event)) {
      listener?.(projected);
    }
  }

  private project(event: EventFrame): readonly EventFrame[] {
    if (this.projectedEvents.has(event)) {
      return this.projectedEvents.get(event) ?? [];
    }
    if (event.event === "session.message") {
      const payload = asNullableRecord(event.payload);
      const chatStream = asNullableRecord(payload?.chatStream);
      const owner = (scope: Record<string, unknown> | null) =>
        scope?.agentId ??
        (typeof scope?.sessionKey === "string"
          ? parseAgentSessionKeyParts(scope.sessionKey)?.agentId
          : undefined);
      if (
        chatStream?.state === "delta" &&
        chatStream.replace === true &&
        typeof chatStream.deltaText === "string" &&
        typeof chatStream.runId === "string" &&
        chatStream.runId.length > 0 &&
        typeof chatStream.sessionKey === "string" &&
        chatStream.sessionKey === payload?.sessionKey &&
        owner(chatStream) === owner(payload)
      ) {
        const replacement = this.stream.project({ ...event, event: "chat", payload: chatStream });
        const projected = [replacement.event, event];
        this.projectedEvents.set(event, projected);
        return projected;
      }
    }
    if (event.event !== "chat") {
      return [event];
    }
    const result = this.stream.project(event);
    const projected = result.missingBaseline ? [] : [result.event];
    if (result.missingBaseline) {
      this.reconnect("chat stream baseline missing");
    }
    // The protocol owns listener dispatch; each listener sees the same reconstruction.
    this.projectedEvents.set(event, projected);
    return projected;
  }
}
