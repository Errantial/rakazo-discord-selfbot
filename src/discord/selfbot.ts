import type { Collection, Client as SelfbotClient, Message, AnyChannel, User } from "discord.js-selfbot-v13";
import type {
  ChannelInfo,
  ChannelKind,
  ConversationSummary,
  DiscordApi,
  DiscordMessage,
  DiscordProfile,
  GetProfileOptions,
  GuildSummary,
  ListConversationsOptions,
  MessageAuthor,
  ReadMessagesOptions,
  SearchMessagesOptions,
  SelfUser,
  SendMessageOptions,
} from "./types.js";

/**
 * discord.js-selfbot-v13 is unmaintained and ships loose typings, so this file
 * narrows its shapes to the port once instead of leaking `any` upward.
 */

type RawUser = {
  id: string;
  username: string;
  globalName?: string | null;
  bot?: boolean;
  createdAt?: Date;
  bio?: string | null;
  pronouns?: string | null;
  displayAvatarURL?: (options?: { size?: number }) => string;
  bannerURL?: (options?: { size?: number }) => string | null;
  relationship?: string;
  friendNickname?: string | null;
  note?: string;
};

type RawChannel = {
  id: string;
  type: string;
  name?: string | null;
  guildId?: string | null;
  guild?: { id: string; name: string; memberCount?: number | null; ownerId?: string | null } | null;
  recipient?: RawUser | null;
  recipients?: Collection<string, RawUser> | RawUser[];
  lastMessageId?: string | null;
  lastMessage?: { createdAt?: Date } | null;
  messageRequest?: boolean;
};

type RawMessage = {
  id: string;
  channelId: string;
  guildId?: string | null;
  content: string;
  author: RawUser;
  createdAt: Date;
  editedAt?: Date | null;
  attachments?: Collection<string, RawAttachment> | RawAttachment[];
  embeds?: unknown[];
  mentions?: { users?: Collection<string, RawUser> | RawUser[] };
  reference?: { messageId?: string | null; channelId?: string | null } | null;
  pinned?: boolean;
  channel?: RawChannel;
  fetchReference?: () => Promise<RawMessage>;
};

type RawAttachment = {
  id: string;
  name?: string | null;
  url: string;
  contentType?: string | null;
  size?: number;
};

type RawProfile = {
  user?: RawUser & {
    bio?: string | null;
    pronouns?: string | null;
    connected_accounts?: Array<{ type: string; name: string; verified?: boolean }>;
  };
  user_profile?: {
    bio?: string | null;
    pronouns?: string | null;
    connected_accounts?: Array<{ type: string; name: string; verified?: boolean }>;
  };
  connected_accounts?: Array<{ type: string; name: string; verified?: boolean }>;
  mutual_guilds?: Array<{ id: string; nick?: string | null; name?: string | null }>;
  mutual_friends?: Array<{ id: string; username: string; global_name?: string | null }>;
  guild_member?: {
    nick?: string | null;
    joined_at?: string | null;
    roles?: string[];
  } | null;
};

function toArray<T>(value: Collection<string, T> | T[] | undefined | null): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [...value.values()];
}

function kindOf(type: string): ChannelKind {
  switch (type) {
    case "DM":
      return "dm";
    case "GROUP_DM":
      return "group_dm";
    case "GUILD_TEXT":
    case "GUILD_NEWS":
    case "GUILD_VOICE":
    case "GUILD_STAGE_VOICE":
    case "GUILD_FORUM":
    case "GUILD_MEDIA":
      return "guild_text";
    case "GUILD_PUBLIC_THREAD":
    case "GUILD_PRIVATE_THREAD":
    case "GUILD_NEWS_THREAD":
      return "thread";
    default:
      return "other";
  }
}

function authorOf(user: RawUser): MessageAuthor {
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName ?? null,
    bot: user.bot ?? false,
  };
}

function channelOf(channel: RawChannel): ChannelInfo {
  const recipients = channel.recipient ? [channel.recipient] : toArray(channel.recipients);
  return {
    id: channel.id,
    kind: kindOf(channel.type),
    name: channel.name ?? channel.recipient?.username ?? null,
    guildId: channel.guildId ?? channel.guild?.id ?? null,
    guildName: channel.guild?.name ?? null,
    recipientIds: recipients.map((user) => user.id),
  };
}

function attachmentsOf(raw: RawMessage): DiscordMessage["attachments"] {
  return toArray(raw.attachments).map((file) => ({
    id: file.id,
    name: file.name ?? "attachment",
    url: file.url,
    contentType: file.contentType ?? null,
    size: file.size ?? 0,
  }));
}

function messageOf(raw: RawMessage, kind: ChannelKind): DiscordMessage {
  return {
    id: raw.id,
    channelId: raw.channelId,
    channelKind: kind,
    guildId: raw.guildId ?? raw.channel?.guildId ?? null,
    author: authorOf(raw.author),
    content: raw.content ?? "",
    createdAt: raw.createdAt.toISOString(),
    editedAt: raw.editedAt ? raw.editedAt.toISOString() : null,
    attachments: attachmentsOf(raw),
    embedCount: raw.embeds?.length ?? 0,
    mentions: toArray(raw.mentions?.users).map(authorOf),
    replyTo: raw.reference?.messageId
      ? { messageId: raw.reference.messageId, authorId: null, content: null }
      : null,
    pinned: raw.pinned ?? false,
    messageRequest: raw.channel?.messageRequest ?? false,
  };
}

/** Sort newest first without trusting the API's ordering. */
function newestFirst(messages: DiscordMessage[]): DiscordMessage[] {
  return [...messages].sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
}

export type SelfbotAdapterOptions = {
  /** Fetch the message a reply points at, so the agent sees the quoted text. */
  resolveReplies?: boolean;
};

export class SelfbotDiscordApi implements DiscordApi {
  private readonly resolveReplies: boolean;

  constructor(
    private readonly client: SelfbotClient,
    options: SelfbotAdapterOptions = {},
  ) {
    this.resolveReplies = options.resolveReplies ?? true;
  }

  self(): SelfUser {
    const user = this.client.user as RawUser | null;
    if (!user) throw new Error("Discord client is not ready yet");
    return { id: user.id, username: user.username, globalName: user.globalName ?? null };
  }

  private channels(): RawChannel[] {
    const manager = this.client.channels as unknown as { cache: Collection<string, RawChannel> };
    return toArray(manager.cache);
  }

  private channelById(channelId: string): RawChannel | null {
    const manager = this.client.channels as unknown as {
      cache: Collection<string, RawChannel>;
      fetch: (id: string) => Promise<RawChannel | null>;
    };
    return manager.cache.get(channelId) ?? null;
  }

  async getChannel(channelId: string): Promise<ChannelInfo | null> {
    const cached = this.channelById(channelId);
    if (cached) return channelOf(cached);
    const manager = this.client.channels as unknown as {
      fetch: (id: string) => Promise<RawChannel | null>;
    };
    const fetched = await manager.fetch(channelId).catch(() => null);
    return fetched ? channelOf(fetched) : null;
  }

  async listConversations(options: ListConversationsOptions): Promise<ConversationSummary[]> {
    // Server channels can number in the thousands, so they only appear when the
    // caller asks for them; DMs are what this bridge is usually for.
    const kinds = new Set<ChannelKind>(options.kinds ?? ["dm", "group_dm"]);
    const all = this.channels()
      .map((channel) => channelOf(channel))
      .filter((channel) => kinds.has(channel.kind));

    const withTimes = all.map((channel) => {
      const raw = this.channelById(channel.id);
      const last = raw?.lastMessage?.createdAt;
      return {
        ...channel,
        lastMessageId: raw?.lastMessageId ?? null,
        lastMessageAt: last ? last.toISOString() : null,
      } satisfies ConversationSummary;
    });

    withTimes.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
    return withTimes.slice(0, options.limit);
  }

  async readMessages(options: ReadMessagesOptions): Promise<DiscordMessage[]> {
    const channel = await this.fetchChannelObject(options.channelId);
    const manager = channel.messages as unknown as {
      fetch: (query: { limit: number; before?: string; after?: string }) => Promise<
        Collection<string, RawMessage>
      >;
    };
    const raw = await manager.fetch({
      limit: options.limit,
      ...(options.before ? { before: options.before } : {}),
      ...(options.after ? { after: options.after } : {}),
    });
    const kind = kindOf((channel as unknown as RawChannel).type);
    const mapped = newestFirst(toArray(raw).map((message) => messageOf(message, kind)));
    if (!this.resolveReplies) return mapped;
    return Promise.all(mapped.map((item) => this.withReply(item, raw)));
  }

  async searchMessages(
    options: SearchMessagesOptions,
  ): Promise<{ messages: DiscordMessage[]; total: number }> {
    const channel = await this.fetchChannelObject(options.channelId);
    const manager = channel.messages as unknown as {
      search: (query: {
        content: string;
        authors: string[];
        limit: number;
        sortBy: "timestamp" | "relevance";
        sortOrder: "asc" | "desc";
      }) => Promise<{ messages: Collection<string, RawMessage>; total: number }>;
    };
    const result = await manager.search({
      content: options.content ?? "",
      authors: options.authorIds ?? [],
      limit: Math.min(options.limit, 25),
      sortBy: "timestamp",
      sortOrder: "desc",
    });
    const kind = kindOf((channel as unknown as RawChannel).type);
    const mapped = newestFirst(toArray(result.messages).map((message) => messageOf(message, kind)));
    return {
      messages: this.resolveReplies
        ? await Promise.all(mapped.map((item) => this.withReply(item, result.messages)))
        : mapped,
      total: result.total,
    };
  }

  async getProfile(options: GetProfileOptions): Promise<DiscordProfile> {
    const users = this.client.users as unknown as {
      cache: Collection<string, RawUser>;
      fetch: (id: string) => Promise<RawUser>;
    };
    const cached = users.cache.get(options.userId);
    const user: RawUser = cached ?? (await users.fetch(options.userId));

    const raw = await (user as unknown as { getProfile: (guildId?: string) => Promise<RawProfile> })
      .getProfile(options.guildId)
      .catch(() => ({}) as RawProfile);

    const profile = raw.user_profile ?? {};
    const connected =
      raw.connected_accounts ?? profile.connected_accounts ?? raw.user?.connected_accounts ?? [];

    return {
      user: {
        ...authorOf(raw.user ?? user),
        createdAt: (raw.user?.createdAt ?? user.createdAt)?.toISOString() ?? null,
      },
      bio: profile.bio ?? raw.user?.bio ?? user.bio ?? null,
      pronouns: profile.pronouns ?? raw.user?.pronouns ?? user.pronouns ?? null,
      avatarUrl: (raw.user ?? user).displayAvatarURL?.({ size: 256 }) ?? null,
      bannerUrl: (raw.user ?? user).bannerURL?.({ size: 600 }) ?? null,
      relationship: user.relationship ?? null,
      friendNickname: user.friendNickname ?? null,
      note: user.note ?? null,
      mutualGuilds: (raw.mutual_guilds ?? []).map((guild) => ({
        id: guild.id,
        name: guild.name ?? null,
        nickname: guild.nick ?? null,
      })),
      mutualFriends: (raw.mutual_friends ?? []).map((friend) => ({
        id: friend.id,
        username: friend.username,
        globalName: friend.global_name ?? null,
      })),
      connectedAccounts: connected.map((account) => ({
        type: account.type,
        name: account.name,
        verified: account.verified ?? false,
      })),
      member: raw.guild_member
        ? {
            guildId: options.guildId ?? "",
            nickname: raw.guild_member.nick ?? null,
            joinedAt: raw.guild_member.joined_at ?? null,
            roles: raw.guild_member.roles ?? [],
          }
        : null,
    };
  }

  async listGuilds(): Promise<GuildSummary[]> {
    const guilds = this.client.guilds as unknown as {
      cache: Collection<string, { id: string; name: string; memberCount?: number | null; ownerId?: string | null }>;
    };
    return toArray(guilds.cache).map((guild) => ({
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount ?? null,
      ownerId: guild.ownerId ?? null,
    }));
  }

  async sendMessage(options: SendMessageOptions): Promise<DiscordMessage> {
    const channel = await this.fetchChannelObject(options.channelId);
    const text = options.text.trim();
    if (!text) throw new Error("Refusing to send an empty message");

    const sender = channel as unknown as {
      send: (options: string | { content: string; reply?: { messageReference: string } }) => Promise<RawMessage>;
    };
    const raw = await sender.send(
      options.replyTo ? { content: text, reply: { messageReference: options.replyTo } } : text,
    );
    return messageOf(raw, kindOf((channel as unknown as RawChannel).type));
  }

  /**
   * Fill in the quoted text of a reply. Discord sends only the referenced id,
   * and an agent that cannot see what it is answering writes a worse reply.
   * A failed lookup is not fatal; the id alone is still useful.
   */
  private async withReply(
    item: DiscordMessage,
    source: Collection<string, RawMessage> | RawMessage[],
  ): Promise<DiscordMessage> {
    if (!item.replyTo) return item;
    const parent = toArray(source).find((raw) => raw.id === item.replyTo?.messageId);
    if (!parent) return item;
    return {
      ...item,
      replyTo: {
        messageId: parent.id,
        authorId: parent.author?.id ?? null,
        content: (parent.content ?? "").slice(0, 500),
      },
    };
  }

  private async fetchChannelObject(channelId: string): Promise<AnyChannel & { messages: unknown }> {
    const manager = this.client.channels as unknown as {
      cache: Collection<string, AnyChannel>;
      fetch: (id: string) => Promise<AnyChannel | null>;
    };
    const cached = manager.cache.get(channelId) as (AnyChannel & { messages: unknown }) | undefined;
    if (cached) return cached;
    const fetched = (await manager.fetch(channelId)) as (AnyChannel & { messages: unknown }) | null;
    if (!fetched) throw new Error(`Unknown channel ${channelId}`);
    return fetched;
  }
}

/** Convert a live library message into the port type, for the event handler. */
export function messageFromEvent(message: Message): DiscordMessage {
  if (!message.author) throw new Error("message has no author yet");
  const channel = message.channel as unknown as RawChannel | null;
  const mapped = messageOf(message as unknown as RawMessage, kindOf(channel?.type ?? "UNKNOWN"));
  return { ...mapped, messageRequest: channel?.messageRequest ?? false };
}

export function mentionedIds(message: Message): string[] {
  const mentions = message.mentions as unknown as { users?: Collection<string, User> | User[] };
  return toArray(mentions?.users).map((user) => user.id);
}
