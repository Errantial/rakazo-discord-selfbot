/**
 * The Discord surface this bridge needs, written as a narrow port.
 *
 * Everything above this file (triggers, wake delivery, MCP tools, tests) talks
 * to `DiscordApi`, never to discord.js-selfbot-v13 directly. That keeps the
 * unmaintained selfbot library at one edge and lets tests run offline.
 */

export type ChannelKind = "dm" | "group_dm" | "guild_text" | "thread" | "other";

export type SelfUser = {
  id: string;
  username: string;
  globalName: string | null;
};

export type ChannelInfo = {
  id: string;
  kind: ChannelKind;
  /** DM recipient, group DM name, or guild channel name. */
  name: string | null;
  guildId: string | null;
  guildName: string | null;
  /** Users in a DM or group DM; empty for guild channels. */
  recipientIds: string[];
};

export type ConversationSummary = {
  id: string;
  kind: ChannelKind;
  name: string | null;
  guildId: string | null;
  guildName: string | null;
  recipientIds: string[];
  lastMessageId: string | null;
  lastMessageAt: string | null;
};

export type MessageAttachment = {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
};

export type MessageAuthor = {
  id: string;
  username: string;
  globalName: string | null;
  bot: boolean;
};

export type DiscordMessage = {
  id: string;
  channelId: string;
  channelKind: ChannelKind;
  guildId: string | null;
  author: MessageAuthor;
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: MessageAttachment[];
  embedCount: number;
  mentions: MessageAuthor[];
  replyTo: { messageId: string; authorId: string | null; content: string | null } | null;
  pinned: boolean;
  /** True when the message is a DM from someone who has not been accepted yet. */
  messageRequest: boolean;
};

export type GuildSummary = {
  id: string;
  name: string;
  memberCount: number | null;
  ownerId: string | null;
};

export type ProfileConnection = {
  type: string;
  name: string;
  verified: boolean;
};

export type DiscordProfile = {
  user: MessageAuthor & { createdAt: string | null };
  bio: string | null;
  pronouns: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  relationship: string | null;
  friendNickname: string | null;
  note: string | null;
  mutualGuilds: Array<{ id: string; name: string | null; nickname: string | null }>;
  mutualFriends: Array<{ id: string; username: string; globalName: string | null }>;
  connectedAccounts: ProfileConnection[];
  member: {
    guildId: string;
    nickname: string | null;
    joinedAt: string | null;
    roles: string[];
  } | null;
};

export type ReadMessagesOptions = {
  channelId: string;
  limit: number;
  before?: string;
  after?: string;
};

export type SearchMessagesOptions = {
  /** Any channel in scope. A guild channel searches its guild; a DM searches that DM. */
  channelId: string;
  content?: string;
  authorIds?: string[];
  limit: number;
};

export type SendMessageOptions = {
  channelId: string;
  text: string;
  replyTo?: string;
};

export type ListConversationsOptions = {
  limit: number;
  kinds?: ChannelKind[];
};

export type GetProfileOptions = {
  userId: string;
  guildId?: string;
};

export interface DiscordApi {
  self(): SelfUser;
  getChannel(channelId: string): Promise<ChannelInfo | null>;
  listConversations(options: ListConversationsOptions): Promise<ConversationSummary[]>;
  readMessages(options: ReadMessagesOptions): Promise<DiscordMessage[]>;
  searchMessages(options: SearchMessagesOptions): Promise<{ messages: DiscordMessage[]; total: number }>;
  getProfile(options: GetProfileOptions): Promise<DiscordProfile>;
  listGuilds(): Promise<GuildSummary[]>;
  sendMessage(options: SendMessageOptions): Promise<DiscordMessage>;
}
