import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = { DISCORD_TOKEN: "token" } as Record<string, string | undefined>;

describe("loadConfig", () => {
  it("defaults to read-only, DMs on, send off", async () => {
    const config = await loadConfig(base);
    expect(config.triggers).toMatchObject({
      dms: true,
      mentions: true,
      messageRequests: false,
      ignoreBots: true,
    });
    expect(config.send.mode).toBe("off");
    expect(config.rakazo).toBeNull();
    expect(config.mcp).toMatchObject({ port: 8791, host: "127.0.0.1", path: "/mcp" });
  });

  it("requires a token", async () => {
    await expect(loadConfig({})).rejects.toBeInstanceOf(ConfigError);
  });

  it("parses lists and booleans", async () => {
    const config = await loadConfig({
      ...base,
      DISCORD_TRIGGER_KEYWORDS: "deploy, invoice ,",
      DISCORD_TRIGGER_DMS: "false",
      DISCORD_SEND_MODE: "allowlist",
      DISCORD_SEND_ALLOWLIST: "chan-1,user-2",
    });
    expect(config.triggers.keywords).toEqual(["deploy", "invoice"]);
    expect(config.triggers.dms).toBe(false);
    expect(config.send).toEqual({ mode: "allowlist", allowlist: ["chan-1", "user-2"], dmOnly: false });
  });

  it("rejects a malformed boolean instead of guessing", async () => {
    await expect(loadConfig({ ...base, DISCORD_TRIGGER_DMS: "maybe" })).rejects.toThrow(
      /Expected a boolean/,
    );
  });

  it("needs a secret alongside the webhook URL", async () => {
    await expect(
      loadConfig({ ...base, RAKAZO_WEBHOOK_URL: "https://rakazo.example/api/v1/bots/b/webhook" }),
    ).rejects.toThrow(/RAKAZO_WEBHOOK_SECRET/);
  });

  it("accepts a full webhook configuration", async () => {
    const config = await loadConfig({
      ...base,
      RAKAZO_WEBHOOK_URL: "https://rakazo.example/api/v1/bots/b/webhook",
      RAKAZO_WEBHOOK_SECRET: "key",
      RAKAZO_EXTRA_HEADERS: '{"x-proxy":"1"}',
    });
    expect(config.rakazo).toMatchObject({
      webhookSecret: "key",
      extraHeaders: { "x-proxy": "1" },
      timeoutMs: 15_000,
    });
  });

  it("rejects a webhook URL that is not a URL", async () => {
    await expect(
      loadConfig({ ...base, RAKAZO_WEBHOOK_URL: "not-a-url", RAKAZO_WEBHOOK_SECRET: "k" }),
    ).rejects.toThrow();
  });

  it("reads rules from a file and lets env win", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rakazo-discord-"));
    const rules = join(dir, "rules.json");
    await writeFile(
      rules,
      JSON.stringify({
        triggers: { keywords: ["from-file"], mentions: false },
        send: { mode: "all" },
      }),
    );

    const fromFile = await loadConfig({ ...base, DISCORD_RULES_FILE: rules });
    expect(fromFile.triggers.keywords).toEqual(["from-file"]);
    expect(fromFile.triggers.mentions).toBe(false);
    expect(fromFile.send.mode).toBe("all");

    const overridden = await loadConfig({
      ...base,
      DISCORD_RULES_FILE: rules,
      DISCORD_TRIGGER_KEYWORDS: "from-env",
      DISCORD_SEND_MODE: "off",
    });
    expect(overridden.triggers.keywords).toEqual(["from-env"]);
    expect(overridden.send.mode).toBe("off");
  });

  it("reports a bad rules file clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rakazo-discord-"));
    const rules = join(dir, "rules.json");
    await writeFile(rules, "{ nope");
    await expect(loadConfig({ ...base, DISCORD_RULES_FILE: rules })).rejects.toThrow(/not valid JSON/);
  });
});

describe("unprefixed aliases", () => {
  // Rakazo reserves the RAKAZO_ prefix for its own command variables, so a bot
  // configuring this bridge has to use these names.
  it("accepts ROUTINE_* for the webhook pair", async () => {
    const config = await loadConfig({
      SELFBOT_TOKEN: "tok",
      ROUTINE_WEBHOOK_URL: "https://rakazo.example/api/v1/bots/b/webhook",
      ROUTINE_WEBHOOK_SECRET: "key",
    });
    expect(config.discordToken).toBe("tok");
    expect(config.rakazo).toMatchObject({ webhookSecret: "key", timeoutMs: 15_000 });
  });

  it("accepts SELFBOT_TOKEN and SELFBOT_MCP_TOKEN", async () => {
    const config = await loadConfig({
      SELFBOT_TOKEN: "tok",
      SELFBOT_MCP_TOKEN: "a-long-enough-mcp-token",
    });
    expect(config.mcp.token).toBe("a-long-enough-mcp-token");
  });

  it("prefers the descriptive name when both are set", async () => {
    const config = await loadConfig({
      DISCORD_TOKEN: "primary",
      SELFBOT_TOKEN: "alias",
      ROUTINE_WEBHOOK_URL: "https://rakazo.example/api/v1/bots/b/webhook",
      ROUTINE_WEBHOOK_SECRET: "alias-key",
      RAKAZO_WEBHOOK_SECRET: "primary-key",
    });
    expect(config.discordToken).toBe("primary");
    expect(config.rakazo?.webhookSecret).toBe("primary-key");
  });

  it("still requires a secret with an aliased URL", async () => {
    await expect(
      loadConfig({
        SELFBOT_TOKEN: "tok",
        ROUTINE_WEBHOOK_URL: "https://rakazo.example/api/v1/bots/b/webhook",
      }),
    ).rejects.toThrow(/webhook secret/i);
  });
});
