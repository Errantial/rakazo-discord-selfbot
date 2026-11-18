import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { checkSend, createMcpServer } from "../src/mcp/server.js";
import { FakeDiscordApi, message } from "./fake-api.js";

function config(overrides: Partial<Config["send"]> = {}): Config {
  return {
    discordToken: "token",
    totpKey: null,
    triggers: {
      dms: true,
      messageRequests: false,
      mentions: true,
      channelIds: [],
      keywords: [],
      fromUserIds: [],
      ignoreUserIds: [],
      ignoreBots: true,
      ignoreSelf: true,
    },
    send: { mode: "off", allowlist: [], dmOnly: false, ...overrides },
    rakazo: null,
    mcp: { port: 8787, host: "127.0.0.1", path: "/mcp", token: null },
    verbose: false,
    logFile: null,
  };
}

async function connect(api: FakeDiscordApi, cfg: Config) {
  const server = createMcpServer({ api, config: cfg });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? "null");
}

describe("MCP tools", () => {
  it("lists the Discord tools", async () => {
    const { client, server } = await connect(new FakeDiscordApi(), config());
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "discord_get_profile",
      "discord_list_conversations",
      "discord_list_guilds",
      "discord_read_messages",
      "discord_search_messages",
      "discord_send_message",
      "discord_whoami",
    ]);
    await Promise.all([client.close(), server.close()]);
  });

  it("reads messages from a channel", async () => {
    const api = new FakeDiscordApi();
    api.messages = [message({ id: "2", content: "second" }), message({ id: "1", content: "first" })];
    const { client, server } = await connect(api, config());

    const result = payload(
      await client.callTool({
        name: "discord_read_messages",
        arguments: { channelId: "chan-1", limit: 5 },
      }),
    ) as { count: number; messages: Array<{ content: string }> };

    expect(result.count).toBe(2);
    expect(result.messages[0]?.content).toBe("second");
    expect(api.readCalls[0]).toMatchObject({ channelId: "chan-1", limit: 5 });
    await Promise.all([client.close(), server.close()]);
  });

  it("refuses a search with no criteria", async () => {
    const { client, server } = await connect(new FakeDiscordApi(), config());
    const result = await client.callTool({
      name: "discord_search_messages",
      arguments: { channelId: "chan-1" },
    });
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("cannot search for everything");
    await Promise.all([client.close(), server.close()]);
  });

  it("returns a preview instead of sending when send mode is off", async () => {
    const api = new FakeDiscordApi();
    api.channels.set("chan-1", {
      id: "chan-1",
      kind: "dm",
      name: "dana",
      guildId: null,
      guildName: null,
      recipientIds: ["user-1"],
    });
    const { client, server } = await connect(api, config({ mode: "off" }));

    const result = payload(
      await client.callTool({
        name: "discord_send_message",
        arguments: { channelId: "chan-1", text: "on it" },
      }),
    ) as { sent: boolean; preview: { text: string } };

    expect(result.sent).toBe(false);
    expect(result.preview.text).toBe("on it");
    expect(api.sent).toHaveLength(0);
    await Promise.all([client.close(), server.close()]);
  });

  it("sends when the channel is allowlisted", async () => {
    const api = new FakeDiscordApi();
    api.channels.set("chan-1", {
      id: "chan-1",
      kind: "dm",
      name: "dana",
      guildId: null,
      guildName: null,
      recipientIds: ["user-1"],
    });
    const { client, server } = await connect(api, config({ mode: "allowlist", allowlist: ["user-1"] }));

    const result = payload(
      await client.callTool({
        name: "discord_send_message",
        arguments: { channelId: "chan-1", text: "on it" },
      }),
    ) as { sent: boolean };

    expect(result.sent).toBe(true);
    expect(api.sent[0]).toMatchObject({ channelId: "chan-1", text: "on it" });
    await Promise.all([client.close(), server.close()]);
  });

  it("reports an unknown channel rather than sending blindly", async () => {
    const { client, server } = await connect(new FakeDiscordApi(), config({ mode: "all" }));
    const result = await client.callTool({
      name: "discord_send_message",
      arguments: { channelId: "missing", text: "hi" },
    });
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("Unknown channel missing");
    await Promise.all([client.close(), server.close()]);
  });
});

describe("checkSend", () => {
  const dm = { channelId: "chan-1", channelKind: "dm" as const, recipientIds: ["user-1"] };
  const guild = {
    channelId: "chan-2",
    channelKind: "guild_text" as const,
    recipientIds: [] as string[],
  };

  it("allows everything in all mode", () => {
    expect(checkSend({ mode: "all", allowlist: [], dmOnly: false }, guild)).toEqual({ allowed: true });
  });

  it("blocks everything in off mode", () => {
    expect(checkSend({ mode: "off", allowlist: [], dmOnly: false }, dm).allowed).toBe(false);
  });

  it("matches the allowlist on channel or recipient", () => {
    expect(checkSend({ mode: "allowlist", allowlist: ["chan-1"], dmOnly: false }, dm)).toEqual({
      allowed: true,
    });
    expect(checkSend({ mode: "allowlist", allowlist: ["user-1"], dmOnly: false }, dm)).toEqual({
      allowed: true,
    });
    expect(checkSend({ mode: "allowlist", allowlist: ["other"], dmOnly: false }, dm).allowed).toBe(
      false,
    );
  });

  it("honours dmOnly", () => {
    expect(checkSend({ mode: "all", allowlist: [], dmOnly: true }, guild).allowed).toBe(false);
    expect(checkSend({ mode: "all", allowlist: [], dmOnly: true }, dm).allowed).toBe(true);
  });
});
