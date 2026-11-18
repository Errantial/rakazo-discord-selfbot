import type { TriggerConfig } from "./config.js";
import type { DiscordMessage } from "./discord/types.js";

export type WakeDecision =
  | { wake: true; reason: WakeReason; detail: string }
  | { wake: false; reason: string };

export type WakeReason =
  | "dm"
  | "message_request"
  | "mention"
  | "keyword"
  | "channel"
  | "group_dm";

export type TriggerContext = {
  selfId: string;
  /** User ids mentioned in the message. */
  mentionedUserIds: string[];
};

/**
 * Decide whether a message should wake a routine.
 *
 * Order matters: the first matching rule names the reason, so a DM that also
 * contains a keyword reports "dm". Filters (ignored users, bots) run first, so
 * a message from an ignored user never wakes for any reason.
 */
export function decideWake(
  message: DiscordMessage,
  triggers: TriggerConfig,
  context: TriggerContext,
): WakeDecision {
  const authorId = message.author.id;

  if (triggers.ignoreSelf && authorId === context.selfId) {
    return { wake: false, reason: "own message" };
  }
  if (triggers.ignoreBots && message.author.bot) {
    return { wake: false, reason: "author is a bot" };
  }
  if (triggers.ignoreUserIds.includes(authorId)) {
    return { wake: false, reason: "author is ignored" };
  }
  if (triggers.fromUserIds.length > 0 && !triggers.fromUserIds.includes(authorId)) {
    return { wake: false, reason: "author is not in the from list" };
  }

  const mentioned =
    context.mentionedUserIds.includes(context.selfId) ||
    message.mentions.some((user) => user.id === context.selfId);

  if (message.channelKind === "dm") {
    if (message.messageRequest) {
      return triggers.messageRequests
        ? { wake: true, reason: "message_request", detail: `DM request from ${authorId}` }
        : { wake: false, reason: "unaccepted message request" };
    }
    if (!triggers.dms) return { wake: false, reason: "DMs are not a trigger" };
    return { wake: true, reason: "dm", detail: `DM from ${authorId}` };
  }

  if (message.channelKind === "group_dm") {
    if (!triggers.dms) return { wake: false, reason: "group DMs are not a trigger" };
    if (mentioned) {
      return { wake: true, reason: "mention", detail: `mentioned in group DM ${message.channelId}` };
    }
    if (triggers.channelIds.includes(message.channelId)) {
      return { wake: true, reason: "channel", detail: `group DM ${message.channelId} is watched` };
    }
    return { wake: false, reason: "group DM without a mention" };
  }

  if (triggers.channelIds.includes(message.channelId)) {
    return { wake: true, reason: "channel", detail: `channel ${message.channelId} is watched` };
  }

  if (mentioned && triggers.mentions) {
    return { wake: true, reason: "mention", detail: `mentioned in ${message.channelId}` };
  }

  if (triggers.keywords.length > 0) {
    const haystack = message.content.toLowerCase();
    const hit = triggers.keywords.find((keyword) => haystack.includes(keyword.toLowerCase()));
    if (hit) return { wake: true, reason: "keyword", detail: `matched "${hit}"` };
  }

  return { wake: false, reason: "no trigger matched" };
}

/**
 * Wake decisions are per message id. Discord redelivers messages after a
 * reconnect, and an edited message arrives as an update, so remembering recent
 * ids keeps one message from starting two runs.
 */
export class SeenMessages {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true the first time a key is seen, false while it is still remembered. */
  claim(key: string): boolean {
    const time = this.now();
    this.prune(time);
    if (this.seen.has(key)) return false;
    this.seen.set(key, time);
    if (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  private prune(time: number): void {
    for (const [key, at] of this.seen) {
      if (time - at < this.ttlMs) break;
      this.seen.delete(key);
    }
  }
}
