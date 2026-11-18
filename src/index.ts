import { appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Client, type Message } from "discord.js-selfbot-v13";
import { loadConfig, type Config } from "./config.js";
import { DiscordBridge, describe, type BridgeEvent } from "./bridge.js";
import { messageFromEvent, mentionedIds, SelfbotDiscordApi } from "./discord/selfbot.js";
import type { DiscordMessage } from "./discord/types.js";
import { startMcpHttpServer } from "./mcp/http.js";

/**
 * Entrypoint: one process holds the Discord gateway connection, the wake
 * listener and the MCP HTTP server, because both need the same logged-in client.
 */
export async function main(): Promise<void> {
  const config = await loadConfig();
  const token = config.mcp.token ?? randomBytes(24).toString("base64url");

  if (config.mcp.token === null) {
    console.log(
      [
        "",
        "No DISCORD_MCP_TOKEN set, so this run generated one:",
        "",
        `  ${token}`,
        "",
        "Use it as the Access token when you add this server in Rakazo.",
        "Set DISCORD_MCP_TOKEN to keep it stable across restarts.",
        "",
      ].join("\n"),
    );
  }
  if (!config.rakazo) {
    console.log("No RAKAZO_WEBHOOK_URL: messages are matched but nothing is woken. Tools still work.");
  }

  const client = new Client({
    ...(config.totpKey ? { TOTPKey: config.totpKey } : {}),
  });

  const api = new SelfbotDiscordApi(client);
  const bridge = new DiscordBridge({
    api,
    config,
    log: (line) => console.log(`[wake] ${line}`),
    ...(config.logFile
      ? { onEvent: (event: BridgeEvent) => void writeLog(config, event) }
      : {}),
  });

  client.on("messageCreate", (message: Message) => {
    void handleEvent(message);
  });
  client.on("messageUpdate", (_old, updated) => {
    // An edit can turn a plain message into a mention; the dedupe keeps it to one run.
    if (updated) void handleEvent(updated as Message);
  });

  async function handleEvent(message: Message): Promise<void> {
    if (!message?.author) return;
    try {
      const mapped: DiscordMessage = messageFromEvent(message);
      await bridge.handleMessage(mapped, mentionedIds(message));
    } catch (error) {
      console.error("[wake] handler error", error);
    }
  }

  const mcp = await startMcpHttpServer({ api, config, mcp: config.mcp, token });
  console.log(`[mcp] ${mcp.url} (bearer token required)`);
  console.log("[mcp] Rakazo needs a public HTTPS URL; tunnel this port and add /mcp as an MCP server.");

  const shutdown = async (signal: string) => {
    console.log(`[main] ${signal}, shutting down`);
    await mcp.close().catch(() => undefined);
    client.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  client.on("ready", () => {
    const self = client.user;
    console.log(`[discord] connected as ${self?.username ?? "unknown"} (${self?.id ?? "?"})`);
  });
  // The gateway drops often; the library reconnects, so a drop is not fatal.
  client.on("shardDisconnect", () => console.warn("[discord] gateway disconnected, reconnecting"));
  client.on("error", (error: Error) => console.error("[discord] error", error));

  await client.login(config.discordToken);
}

async function writeLog(config: Config, event: BridgeEvent): Promise<void> {
  if (!config.logFile) return;
  const line = `${new Date().toISOString()} ${describe(event)}\n`;
  await appendFile(config.logFile, line).catch(() => undefined);
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
