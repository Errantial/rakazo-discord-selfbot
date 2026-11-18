import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Config } from "../src/config.js";
import { startMcpHttpServer } from "../src/mcp/http.js";
import { FakeDiscordApi } from "./fake-api.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
});

function config(port: number): Config {
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
    send: { mode: "off", allowlist: [], dmOnly: false },
    rakazo: null,
    mcp: { port, host: "127.0.0.1", path: "/mcp", token: null },
    verbose: false,
    logFile: null,
  };
}

async function serve(port: number, token = "test-token-1234567890") {
  const cfg = config(port);
  const started = await startMcpHttpServer({
    api: new FakeDiscordApi(),
    config: cfg,
    mcp: cfg.mcp,
    token,
  });
  closers.push(started.close);
  return started;
}

describe("MCP HTTP endpoint", () => {
  it("answers a health check", async () => {
    const { url } = await serve(8931);
    const response = await fetch(url.replace("/mcp", "/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects a request without the bearer token", async () => {
    const { url } = await serve(8932);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a wrong token", async () => {
    const { url } = await serve(8933);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer nope",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("serves the tools to a real MCP client", async () => {
    const { url } = await serve(8934);
    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: "Bearer test-token-1234567890" } },
    });
    await client.connect(transport);
    closers.push(async () => client.close());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("discord_send_message");

    const result = await client.callTool({ name: "discord_whoami", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "{}";
    expect(JSON.parse(text).account.id).toBe("self-1");
  });

  it("returns 404 for another path", async () => {
    const { url } = await serve(8935);
    const response = await fetch(url.replace("/mcp", "/other"));
    expect(response.status).toBe(404);
  });
});
