import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import { MessageReferenceType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Message } from "../internal/discord.js";
import { createInternalTestClient } from "../internal/test-builders.test-support.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import type { DiscordHistoryEntry } from "./message-handler.history.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  DEFAULT_PREFLIGHT_CFG,
} from "./message-handler.preflight.test-helpers.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

vi.mock("openclaw/plugin-sdk/media-runtime", { spy: true });

const CHANNEL_ID = "channel-media-policy";
const GUILD_ID = "guild-media-policy";
const AUTHOR = { id: "user-1", bot: false, username: "alice" };
const ATTACHMENT = {
  id: "image-1",
  url: "https://cdn.discordapp.com/attachments/1/image.png",
  filename: "image.png",
  content_type: "image/png",
};
const CFG: OpenClawConfig = {
  ...DEFAULT_PREFLIGHT_CFG,
  browser: {
    cdpPolicy: {
      dangerouslyAllowPrivateNetwork: true,
      allowedHostnames: ["metadata.google.internal"],
      blockedHostnames: ["cdn.discordapp.com"],
    },
  },
  channels: { discord: { contextVisibility: "all" } },
};
const CDN_POLICY = {
  hostnameAllowlist: [
    "cdn.discordapp.com",
    "media.discordapp.net",
    "*.discordapp.com",
    "*.discordapp.net",
  ],
  allowRfc2544BenchmarkRange: true,
};

beforeEach(() => {
  vi.mocked(saveRemoteMedia).mockReset();
  vi.mocked(saveRemoteMedia).mockResolvedValue({
    id: "saved-image",
    path: "/tmp/discord-media-policy/image.png",
    size: 5,
    contentType: "image/png",
  });
});

describe("Discord caller media policy", () => {
  it.each(["attachment", "forwarded snapshot"] as const)(
    "prepares an admitted %s using Discord CDN policy",
    async (kind) => {
      const original = createDiscordMessage({
        id: "admitted-image",
        channelId: CHANNEL_ID,
        content: "look at this",
        author: AUTHOR,
        attachments: [ATTACHMENT],
      });
      const message =
        kind === "attachment"
          ? original
          : new Message(createInternalTestClient(), {
              ...original.rawData,
              attachments: [],
              message_reference: { type: MessageReferenceType.Forward, channel_id: CHANNEL_ID },
              message_snapshots: [{ message: original.rawData }],
            });
      const result = await preflightDiscordMessage({
        ...createDiscordPreflightArgs({
          cfg: CFG,
          discordConfig: {},
          data: createGuildEvent({
            channelId: CHANNEL_ID,
            guildId: GUILD_ID,
            author: message.author,
            message,
          }),
          client: createGuildTextClient(CHANNEL_ID),
        }),
        guildEntries: {
          [GUILD_ID]: { channels: { [CHANNEL_ID]: { enabled: true, requireMention: false } } },
        },
      });

      expect(saveRemoteMedia).toHaveBeenCalledTimes(1);
      expect(vi.mocked(saveRemoteMedia).mock.calls[0]?.[0].ssrfPolicy).toEqual(CDN_POLICY);
      expect(result?.preparedMedia).toEqual([
        {
          path: "/tmp/discord-media-policy/image.png",
          contentType: "image/png",
          fileName: "image.png",
        },
      ]);
    },
  );

  it("records unmentioned history media using Discord CDN policy", async () => {
    const message = createDiscordMessage({
      id: "history-image",
      channelId: CHANNEL_ID,
      content: "",
      author: AUTHOR,
      attachments: [ATTACHMENT],
    });
    const guildHistories = new Map<string, DiscordHistoryEntry[]>();
    const result = await preflightDiscordMessage({
      ...createDiscordPreflightArgs({
        cfg: CFG,
        discordConfig: {},
        data: createGuildEvent({
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          author: message.author,
          message,
        }),
        client: createGuildTextClient(CHANNEL_ID),
      }),
      guildHistories,
      historyLimit: 4,
      guildEntries: {
        [GUILD_ID]: { channels: { [CHANNEL_ID]: { enabled: true, requireMention: true } } },
      },
    });

    expect(result).toBeNull();
    expect(saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveRemoteMedia).mock.calls[0]?.[0].ssrfPolicy).toEqual(CDN_POLICY);
    expect(guildHistories.get(CHANNEL_ID)?.[0]?.media).toEqual([
      {
        path: "/tmp/discord-media-policy/image.png",
        contentType: "image/png",
        kind: "image",
        messageId: "history-image",
      },
    ]);
  });

  it("exposes referenced reply media using Discord CDN policy", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const referencedMessage = createDiscordMessage({
        id: "referenced-image",
        channelId: CHANNEL_ID,
        content: "the original image",
        author: AUTHOR,
        attachments: [ATTACHMENT],
      });
      const message = createDiscordMessage({
        id: "reply-image",
        channelId: CHANNEL_ID,
        content: "describe this",
        author: AUTHOR,
        messageReference: {
          type: MessageReferenceType.Default,
          channel_id: CHANNEL_ID,
          message_id: referencedMessage.id,
        },
        referencedMessage,
      });
      const threadBindings = createNoopThreadBindingManager("default");
      onTestFinished(() => threadBindings.stop());
      const ctx = await createBaseDiscordMessageContext({
        cfg: { ...CFG, session: { store: state.path("sessions.json") } },
        message,
        messageChannelId: CHANNEL_ID,
        replyToMode: "all",
        threadBindings,
      });
      const result = await buildDiscordMessageProcessContext({
        ctx,
        text: message.content,
        mediaList: [],
      });

      expect(saveRemoteMedia).toHaveBeenCalledTimes(1);
      expect(vi.mocked(saveRemoteMedia).mock.calls[0]?.[0].ssrfPolicy).toEqual(CDN_POLICY);
      expect(result?.ctxPayload.media).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/tmp/discord-media-policy/image.png",
            messageId: "referenced-image",
          }),
        ]),
      );
    });
  });
});
