import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config, SendConfig } from "../config.js";
import type { ChannelKind, DiscordApi } from "../discord/types.js";

export type SendCheck =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Decide whether a tool call may actually put a message on Discord.
 *
 * The default is `off`, so an agent that decides to reply has to be enabled
 * deliberately. That keeps the first runs observable instead of chatty, and it
 * is the only guard between a model and your real account.
 */
export function checkSend(
  send: SendConfig,
  target: { channelId: string; channelKind: ChannelKind; recipientIds: string[] },
): SendCheck {
  if (send.dmOnly && !["dm", "group_dm", "thread"].includes(target.channelKind)) {
    return { allowed: false, reason: `dmOnly is set and channel ${target.channelId} is a ${target.channelKind}` };
  }
  if (send.mode === "all") return { allowed: true };
  if (send.mode === "off") {
    return { allowed: false, reason: "send mode is off; the call was not sent" };
  }
  const ids = new Set([target.channelId, ...target.recipientIds]);
  const allowed = send.allowlist.some((entry) => ids.has(entry));
  return allowed
    ? { allowed: true }
    : { allowed: false, reason: `channel ${target.channelId} is not in the send allowlist` };
}

const channelKind = z.enum(["dm", "group_dm", "guild_text", "thread", "other"]);

export type ServerDeps = {
  api: DiscordApi;
  config: Config;
};

export function createMcpServer({ api, config }: ServerDeps): McpServer {
  const server = new McpServer(
    { name: "rakazo-discord-selfbot", version: "0.1.0" },
    {
      instructions: [
        "These tools act as the account owner on Discord, not as a bot.",
        "Read tools are always safe. Sending is gated by the bridge's send mode:",
        config.send.mode === "off"
          ? "sending is currently OFF, so a send returns a preview and posts nothing."
          : config.send.mode === "allowlist"
            ? `sending is limited to: ${config.send.allowlist.join(", ") || "nothing (empty allowlist)"}.`
            : "sending is allowed everywhere.",
        "Channel and user ids are snowflakes (long digit strings). Resolve a name with discord_list_conversations first.",
        "Messages you send are attributed to the account owner.",
      ].join(" "),
    },
  );

  server.registerTool(
    "discord_whoami",
    {
      description: "The Discord account these tools act as, plus the bridge's send policy.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const self = api.self();
      return json({
        account: self,
        send: config.send,
        triggers: config.triggers,
      });
    },
  );

  server.registerTool(
    "discord_list_conversations",
    {
      description:
        "List the account's DMs and group DMs, newest activity first. Pass `kinds` to include server channels and threads. Use this to turn a person's name into an id.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(25).describe("How many conversations to return"),
        kinds: z
          .array(channelKind)
          .optional()
          .describe("Channel kinds to include. Defaults to DMs and group DMs."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, kinds }) => {
      const conversations = await api.listConversations({
        limit,
        ...(kinds ? { kinds } : {}),
      });
      return json({ conversations });
    },
  );

  server.registerTool(
    "discord_read_messages",
    {
      description:
        "Read recent messages from a channel, newest first. Page backwards by passing the oldest id you have as `before`.",
      inputSchema: {
        channelId: z.string().min(1).describe("Channel, DM or group DM id"),
        limit: z.number().int().min(1).max(100).default(25).describe("Messages to return"),
        before: z.string().optional().describe("Return messages older than this message id"),
        after: z.string().optional().describe("Return messages newer than this message id"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ channelId, limit, before, after }) => {
      const messages = await api.readMessages({
        channelId,
        limit,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      });
      return json({ channelId, count: messages.length, messages });
    },
  );

  server.registerTool(
    "discord_search_messages",
    {
      description:
        "Search message history. Passing a server channel searches that whole server; passing a DM searches that DM.",
      inputSchema: {
        channelId: z.string().min(1).describe("Any channel or DM id to search in scope of"),
        content: z.string().optional().describe("Text to look for"),
        authorIds: z.array(z.string()).optional().describe("Only messages from these user ids"),
        limit: z.number().int().min(1).max(25).default(10).describe("Results to return"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ channelId, content, authorIds, limit }) => {
      if (!content && !authorIds?.length) {
        return text("Give `content`, `authorIds`, or both; Discord cannot search for everything.");
      }
      const result = await api.searchMessages({
        channelId,
        limit,
        ...(content ? { content } : {}),
        ...(authorIds?.length ? { authorIds } : {}),
      });
      return json({ channelId, total: result.total, messages: result.messages });
    },
  );

  server.registerTool(
    "discord_get_profile",
    {
      description:
        "A user's profile as the account owner sees it: bio, pronouns, mutual servers, mutual friends, connected accounts and, inside a server, their nickname and roles.",
      inputSchema: {
        userId: z.string().min(1).describe("User id"),
        guildId: z.string().optional().describe("Read the profile as seen in this server"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ userId, guildId }) => {
      const profile = await api.getProfile({ userId, ...(guildId ? { guildId } : {}) });
      return json(profile);
    },
  );

  server.registerTool(
    "discord_list_guilds",
    {
      description: "Servers the account is in.",
      annotations: { readOnlyHint: true },
    },
    async () => json({ guilds: await api.listGuilds() }),
  );

  server.registerTool(
    "discord_send_message",
    {
      description:
        "Send a message as the account owner. When sending is off, this returns the exact text it would have sent instead of posting.",
      inputSchema: {
        channelId: z.string().min(1).describe("Channel, DM or group DM id"),
        text: z.string().min(1).max(2000).describe("Message text"),
        replyTo: z.string().optional().describe("Message id to reply to"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ channelId, text: body, replyTo }) => {
      const channel = await api.getChannel(channelId);
      if (!channel) return text(`Unknown channel ${channelId}.`);

      const check = checkSend(config.send, {
        channelId,
        channelKind: channel.kind,
        recipientIds: channel.recipientIds,
      });
      if (!check.allowed) {
        return json({
          sent: false,
          reason: check.reason,
          preview: { channelId, channelKind: channel.kind, text: body, replyTo: replyTo ?? null },
        });
      }

      const sent = await api.sendMessage({
        channelId,
        text: body,
        ...(replyTo ? { replyTo } : {}),
      });
      return json({ sent: true, message: sent });
    },
  );

  return server;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}
