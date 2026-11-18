import { readFile } from "node:fs/promises";
import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Who wakes a routine. Empty lists mean "no constraint", except `dms` which is
 * the whole point of running this on a personal account.
 */
const TriggerConfig = z.object({
  dms: z.boolean().default(true),
  /** DMs from people you have not accepted yet. Off by default: they are often spam. */
  messageRequests: z.boolean().default(false),
  /** Wakes when you are @mentioned in a server channel. */
  mentions: z.boolean().default(true),
  /** Any message in these channel ids wakes, mention or not. */
  channelIds: z.array(z.string()).default([]),
  /** Case-insensitive substrings; a match wakes even without a mention. */
  keywords: z.array(z.string()).default([]),
  /** Only these user ids may wake a routine. Empty means anyone. */
  fromUserIds: z.array(z.string()).default([]),
  /** These user ids never wake a routine. */
  ignoreUserIds: z.array(z.string()).default([]),
  /** Ignore messages from other bots and apps. */
  ignoreBots: z.boolean().default(true),
  /** Ignore your own messages, including ones the bot sent. */
  ignoreSelf: z.boolean().default(true),
});
export type TriggerConfig = z.infer<typeof TriggerConfig>;

const SendConfig = z.object({
  /** `off` reports what would be sent without sending it. */
  mode: z.enum(["off", "allowlist", "all"]).default("off"),
  /** Channel ids or user ids that may receive a send in allowlist mode. */
  allowlist: z.array(z.string()).default([]),
  /** Refuse to send to a channel that is not a DM, group DM or thread. */
  dmOnly: z.boolean().default(false),
});
export type SendConfig = z.infer<typeof SendConfig>;

const RakazoConfig = z.object({
  /** Full routine webhook URL, e.g. https://rakazo.example/api/v1/bots/<id>/webhook */
  webhookUrl: z.string().url(),
  /** The bot's webhook key, sent as `Authorization: Bearer`. */
  webhookSecret: z.string().min(1),
  /** Optional extra header, e.g. for a proxy in front of Rakazo. */
  extraHeaders: z.record(z.string(), z.string()).default({}),
  /** Give up on a wake after this long. Rakazo answers once the run is queued. */
  timeoutMs: z.number().int().positive().default(15_000),
});
export type RakazoConfig = z.infer<typeof RakazoConfig>;

const McpConfig = z.object({
  port: z.number().int().min(1).max(65_535).default(8791),
  host: z.string().default("127.0.0.1"),
  path: z.string().startsWith("/").default("/mcp"),
  /** Bearer token clients must present. Generated and printed when unset. */
  token: z.string().min(16).nullable().default(null),
});
export type McpConfig = z.infer<typeof McpConfig>;

const Config = z.object({
  discordToken: z.string().min(1),
  /** TOTP secret for accounts with 2FA, used when the library needs it. */
  totpKey: z.string().min(1).nullable().default(null),
  triggers: TriggerConfig,
  send: SendConfig,
  rakazo: RakazoConfig.nullable(),
  mcp: McpConfig,
  /** Log every wake decision at info level. */
  verbose: z.boolean().default(false),
  /** File to append wake decisions to, for debugging what did and did not fire. */
  logFile: z.string().nullable().default(null),
});
export type Config = z.infer<typeof Config>;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normal = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normal)) return true;
  if (["0", "false", "no", "off"].includes(normal)) return false;
  throw new ConfigError(`Expected a boolean, got "${value}"`);
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new ConfigError(`Expected an integer, got "${value}"`);
  return parsed;
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * A trigger file lets you keep rules in one place. Environment variables win
 * over it, so a one-off override does not need a file edit.
 */
const TriggerFile = z.object({
  triggers: TriggerConfig.partial().optional(),
  send: SendConfig.partial().optional(),
});

export type Env = Record<string, string | undefined>;

export async function loadConfig(env: Env = process.env): Promise<Config> {
  const token = optional(env.DISCORD_TOKEN);
  if (!token) {
    throw new ConfigError(
      "DISCORD_TOKEN is required. It is your account token, so treat it like a password.",
    );
  }

  let fromFile: z.infer<typeof TriggerFile> = {};
  const rulesPath = optional(env.DISCORD_RULES_FILE);
  if (rulesPath) {
    let raw: string;
    try {
      raw = await readFile(rulesPath, "utf8");
    } catch (error) {
      throw new ConfigError(`Could not read DISCORD_RULES_FILE at ${rulesPath}: ${String(error)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new ConfigError(`${rulesPath} is not valid JSON: ${String(error)}`);
    }
    const parsed = TriggerFile.safeParse(json);
    if (!parsed.success) {
      throw new ConfigError(`${rulesPath} is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
    fromFile = parsed.data;
  }

  const fileTriggers = fromFile.triggers ?? {};
  const fileSend = fromFile.send ?? {};

  const webhookUrl = optional(env.RAKAZO_WEBHOOK_URL);
  const webhookSecret = optional(env.RAKAZO_WEBHOOK_SECRET);
  if (webhookUrl && !webhookSecret) {
    throw new ConfigError("RAKAZO_WEBHOOK_SECRET is required when RAKAZO_WEBHOOK_URL is set.");
  }

  let extraHeaders: Record<string, string> = {};
  const extraHeadersRaw = optional(env.RAKAZO_EXTRA_HEADERS);
  if (extraHeadersRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extraHeadersRaw);
    } catch {
      throw new ConfigError("RAKAZO_EXTRA_HEADERS must be a JSON object of header names to values.");
    }
    const headers = z.record(z.string(), z.string()).safeParse(parsed);
    if (!headers.success) {
      throw new ConfigError("RAKAZO_EXTRA_HEADERS must be a JSON object of header names to values.");
    }
    extraHeaders = headers.data;
  }

  const triggers = TriggerConfig.parse({
    dms: bool(env.DISCORD_TRIGGER_DMS, fileTriggers.dms ?? true),
    messageRequests: bool(env.DISCORD_TRIGGER_MESSAGE_REQUESTS, fileTriggers.messageRequests ?? false),
    mentions: bool(env.DISCORD_TRIGGER_MENTIONS, fileTriggers.mentions ?? true),
    channelIds: list(env.DISCORD_TRIGGER_CHANNELS).length
      ? list(env.DISCORD_TRIGGER_CHANNELS)
      : (fileTriggers.channelIds ?? []),
    keywords: list(env.DISCORD_TRIGGER_KEYWORDS).length
      ? list(env.DISCORD_TRIGGER_KEYWORDS)
      : (fileTriggers.keywords ?? []),
    fromUserIds: list(env.DISCORD_TRIGGER_FROM).length
      ? list(env.DISCORD_TRIGGER_FROM)
      : (fileTriggers.fromUserIds ?? []),
    ignoreUserIds: list(env.DISCORD_TRIGGER_IGNORE).length
      ? list(env.DISCORD_TRIGGER_IGNORE)
      : (fileTriggers.ignoreUserIds ?? []),
    ignoreBots: bool(env.DISCORD_TRIGGER_IGNORE_BOTS, fileTriggers.ignoreBots ?? true),
    ignoreSelf: bool(env.DISCORD_TRIGGER_IGNORE_SELF, fileTriggers.ignoreSelf ?? true),
  });

  const sendModeRaw = optional(env.DISCORD_SEND_MODE);
  const sendMode = sendModeRaw
    ? z.enum(["off", "allowlist", "all"]).parse(sendModeRaw)
    : (fileSend.mode ?? "off");

  const mcpToken = optional(env.DISCORD_MCP_TOKEN);

  return Config.parse({
    discordToken: token,
    totpKey: optional(env.DISCORD_TOTP_KEY),
    triggers,
    send: {
      mode: sendMode,
      allowlist: list(env.DISCORD_SEND_ALLOWLIST).length
        ? list(env.DISCORD_SEND_ALLOWLIST)
        : (fileSend.allowlist ?? []),
      dmOnly: bool(env.DISCORD_SEND_DM_ONLY, fileSend.dmOnly ?? false),
    },
    rakazo: webhookUrl
      ? {
          webhookUrl,
          webhookSecret: webhookSecret as string,
          extraHeaders,
          timeoutMs: int(env.RAKAZO_TIMEOUT_MS, 15_000),
        }
      : null,
    mcp: {
      port: int(env.DISCORD_MCP_PORT, 8791),
      host: optional(env.DISCORD_MCP_HOST) ?? "127.0.0.1",
      path: optional(env.DISCORD_MCP_PATH) ?? "/mcp",
      token: mcpToken,
    },
    verbose: bool(env.DISCORD_VERBOSE, false),
    logFile: optional(env.DISCORD_LOG_FILE),
  });
}
