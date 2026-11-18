import type { RakazoConfig } from "./config.js";
import type { DiscordMessage } from "./discord/types.js";
import type { WakeReason } from "./triggers.js";

export type WakeResult =
  | { ok: true; messageId: string; runId: string | null }
  | { ok: false; status: number; error: string };

export type WakePayload = {
  /** Rakazo labels the run from this field. Keep it a short token. */
  event: "discord.message";
  reason: WakeReason;
  message: {
    id: string;
    channel_id: string;
    channel_kind: string;
    guild_id: string | null;
    author_id: string;
    author_name: string;
    author_bot: boolean;
    content: string;
    created_at: string;
    reply_to: string | null;
    attachments: Array<{ name: string; url: string; content_type: string | null }>;
  };
  /** Plain sentence the agent reads first, so it knows where the message came from. */
  summary: string;
};

const MAX_CONTENT = 4_000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function where(message: DiscordMessage): string {
  switch (message.channelKind) {
    case "dm":
      return "a direct message";
    case "group_dm":
      return `a group DM (${message.channelId})`;
    case "guild_text":
    case "thread":
      return `a server channel (${message.channelId})`;
    default:
      return `channel ${message.channelId}`;
  }
}

export function buildWakePayload(message: DiscordMessage, reason: WakeReason): WakePayload {
  const author = message.author.globalName ?? message.author.username;
  const body = truncate(message.content.trim(), MAX_CONTENT);
  const summary = body
    ? `${author} sent you ${where(message)}: ${body}`
    : `${author} sent an attachment with no text in ${where(message)}.`;

  return {
    event: "discord.message",
    reason,
    message: {
      id: message.id,
      channel_id: message.channelId,
      channel_kind: message.channelKind,
      guild_id: message.guildId,
      author_id: message.author.id,
      author_name: author,
      author_bot: message.author.bot,
      content: body,
      created_at: message.createdAt,
      reply_to: message.replyTo?.messageId ?? null,
      attachments: message.attachments.map((file) => ({
        name: file.name,
        url: file.url,
        content_type: file.contentType,
      })),
    },
    summary,
  };
}

/**
 * Wake a Rakazo routine through its bot webhook.
 *
 * Rakazo answers 200 once the run is queued, so a 200 means the agent will
 * read the message — not that it has replied. Replies come back through the
 * `discord_send_message` tool, not from this response.
 */
export async function wakeRoutine(
  config: RakazoConfig,
  payload: WakePayload,
  options: { idempotencyKey?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<WakeResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await doFetch(config.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.webhookSecret}`,
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        ...config.extraHeaders,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, error: truncate(text, 500) || "no body" };
    }

    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    return {
      ok: true,
      messageId: typeof body.messageId === "string" ? body.messageId : "",
      runId: typeof body.runId === "string" ? body.runId : null,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 408 : 0,
      error: aborted ? "webhook timed out" : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
