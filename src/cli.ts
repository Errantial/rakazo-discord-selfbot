import { Client } from "discord.js-selfbot-v13";
import { loadConfig } from "./config.js";
import { SelfbotDiscordApi } from "./discord/selfbot.js";
import { checkSend } from "./mcp/server.js";

/**
 * Try the bridge without an agent: `npm run cli -- list`, `read <channelId>`,
 * `whoami`, or `send <channelId> <text>`. Sending still honours the send mode.
 */
const USAGE = [
  "Usage: cli <command>",
  "  whoami",
  "  list [limit]",
  "  read <channelId> [limit]",
  "  profile <userId> [guildId]",
  "  guilds",
  "  send <channelId> <text>",
].join("\n");

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.log(USAGE);
    return;
  }
  const config = await loadConfig();
  const client = new Client({ ...(config.totpKey ? { TOTPKey: config.totpKey } : {}) });

  await client.login(config.discordToken);
  const api = new SelfbotDiscordApi(client);

  try {
    switch (command) {
      case "whoami": {
        console.log(JSON.stringify({ account: api.self(), send: config.send }, null, 2));
        break;
      }
      case "list": {
        const limit = Number(args[0] ?? 25);
        const conversations = await api.listConversations({ limit });
        for (const conversation of conversations) {
          const name =
            conversation.kind === "guild_text" || conversation.kind === "thread"
              ? `${conversation.guildName ?? "?"} / ${conversation.name ?? conversation.id}`
              : (conversation.name ?? conversation.id);
          console.log(
            `${conversation.id}  ${conversation.kind.padEnd(10)}  ${name}  ${conversation.lastMessageAt ?? ""}`,
          );
        }
        break;
      }
      case "read": {
        const channelId = args[0];
        if (!channelId) throw new Error("Usage: cli read <channelId> [limit]");
        const messages = await api.readMessages({ channelId, limit: Number(args[1] ?? 20) });
        for (const message of messages) {
          const who = message.author.globalName ?? message.author.username;
          console.log(`${message.createdAt} ${who}: ${message.content || `[${message.attachments.length} attachment(s)]`}`);
        }
        break;
      }
      case "profile": {
        const userId = args[0];
        if (!userId) throw new Error("Usage: cli profile <userId> [guildId]");
        console.log(JSON.stringify(await api.getProfile({ userId, ...(args[1] ? { guildId: args[1] } : {}) }), null, 2));
        break;
      }
      case "guilds": {
        console.log(JSON.stringify(await api.listGuilds(), null, 2));
        break;
      }
      case "send": {
        const [channelId, ...rest] = args;
        const body = rest.join(" ");
        if (!channelId || !body) throw new Error("Usage: cli send <channelId> <text>");
        const channel = await api.getChannel(channelId);
        if (!channel) throw new Error(`Unknown channel ${channelId}`);
        const check = checkSend(config.send, {
          channelId,
          channelKind: channel.kind,
          recipientIds: channel.recipientIds,
        });
        if (!check.allowed) {
          console.log(`not sent: ${check.reason}`);
          break;
        }
        const sent = await api.sendMessage({ channelId, text: body });
        console.log(`sent ${sent.id}`);
        break;
      }
      default:
        console.log(USAGE);
    }
  } finally {
    client.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
