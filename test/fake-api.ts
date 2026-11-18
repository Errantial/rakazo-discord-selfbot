import type {
  ChannelInfo,
  ConversationSummary,
  DiscordApi,
  DiscordMessage,
  DiscordProfile,
  GuildSummary,
  ListConversationsOptions,
  ReadMessagesOptions,
  SearchMessagesOptions,
  SelfUser,
  SendMessageOptions,
} from "../src/discord/types.js";

export function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "100",
    channelId: "chan-1",
    channelKind: "dm",
    guildId: null,
    author: { id: "user-1", username: "dana", globalName: "Dana", bot: false },
    content: "hello",
    createdAt: "2026-11-18T10:00:00.000Z",
    editedAt: null,
    attachments: [],
    embedCount: 0,
    mentions: [],
    replyTo: null,
    pinned: false,
    messageRequest: false,
    ...overrides,
  };
}

export class FakeDiscordApi implements DiscordApi {
  selfUser: SelfUser = { id: "self-1", username: "me", globalName: "Me" };
  channels = new Map<string, ChannelInfo>();
  conversations: ConversationSummary[] = [];
  messages: DiscordMessage[] = [];
  searchResults: DiscordMessage[] = [];
  searchTotal = 0;
  guilds: GuildSummary[] = [];
  profile: DiscordProfile | null = null;
  sent: SendMessageOptions[] = [];
  sentMessage: DiscordMessage | null = null;
  searchCalls: SearchMessagesOptions[] = [];
  readCalls: ReadMessagesOptions[] = [];

  self(): SelfUser {
    return this.selfUser;
  }

  async getChannel(channelId: string): Promise<ChannelInfo | null> {
    return this.channels.get(channelId) ?? null;
  }

  async listConversations(options: ListConversationsOptions): Promise<ConversationSummary[]> {
    return this.conversations.slice(0, options.limit);
  }

  async readMessages(options: ReadMessagesOptions): Promise<DiscordMessage[]> {
    this.readCalls.push(options);
    return this.messages.slice(0, options.limit);
  }

  async searchMessages(
    options: SearchMessagesOptions,
  ): Promise<{ messages: DiscordMessage[]; total: number }> {
    this.searchCalls.push(options);
    return { messages: this.searchResults.slice(0, options.limit), total: this.searchTotal };
  }

  async getProfile(): Promise<DiscordProfile> {
    if (!this.profile) throw new Error("no profile fixture");
    return this.profile;
  }

  async listGuilds(): Promise<GuildSummary[]> {
    return this.guilds;
  }

  async sendMessage(options: SendMessageOptions): Promise<DiscordMessage> {
    this.sent.push(options);
    return (
      this.sentMessage ??
      message({ id: "sent-1", channelId: options.channelId, content: options.text })
    );
  }
}
