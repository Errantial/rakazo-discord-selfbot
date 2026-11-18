import { describe, expect, it } from "vitest";
import { messageFromEvent, mentionedIds, SelfbotDiscordApi } from "../src/discord/selfbot.js";

/**
 * A hand-built stand-in for the parts of discord.js-selfbot-v13 the adapter
 * reads. The library is unmaintained, so pinning its shape here means a
 * breaking change shows up as a test failure rather than as bad data reaching
 * an agent.
 */

class FakeCollection<K, V> extends Map<K, V> {
  values(): MapIterator<V> {
    return super.values();
  }
}

function collection<T extends { id: string }>(items: T[]): FakeCollection<string, T> {
  return new FakeCollection(items.map((item) => [item.id, item] as const));
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    username: "dana",
    globalName: "Dana",
    bot: false,
    createdAt: new Date("2021-01-01T00:00:00.000Z"),
    displayAvatarURL: () => "https://cdn.example/avatar.png",
    bannerURL: () => "https://cdn.example/banner.png",
    relationship: "FRIEND",
    friendNickname: "D",
    note: "met at the conference",
    ...overrides,
  };
}

function rawMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "100",
    channelId: "chan-1",
    guildId: null,
    content: "hello there",
    author: user(),
    createdAt: new Date("2026-11-18T10:00:00.000Z"),
    editedAt: null,
    attachments: collection([
      { id: "a1", name: "invoice.pdf", url: "https://cdn.example/i.pdf", contentType: "application/pdf", size: 12 },
    ]),
    embeds: [{}, {}],
    mentions: { users: collection([user({ id: "self-1", username: "me" })]) },
    reference: { messageId: "90" },
    pinned: false,
    channel: { id: "chan-1", type: "DM", messageRequest: false },
    ...overrides,
  };
}

function dmChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: "chan-1",
    type: "DM",
    recipient: user(),
    messageRequest: false,
    lastMessageId: "100",
    lastMessage: { createdAt: new Date("2026-11-18T10:00:00.000Z") },
    ...overrides,
  };
}

function makeClient(options: {
  channels?: unknown[];
  messages?: unknown[];
  search?: { messages: unknown[]; total: number };
  profile?: unknown;
  guilds?: unknown[];
  sendResult?: unknown;
} = {}) {
  const channels = options.channels ?? [dmChannel()];
  const messages = options.messages ?? [rawMessage()];
  const cache = collection(channels as Array<{ id: string }>);
  const byId = new Map((channels as Array<{ id: string }>).map((channel) => [channel.id, channel]));

  const self = user({ id: "self-1", username: "me", globalName: "Me" });
  const dana = user();
  // The library hangs getProfile off the user instance.
  (self as Record<string, unknown>).getProfile = async () => options.profile ?? {};
  (dana as Record<string, unknown>).getProfile = async () => options.profile ?? {};

  const client = {
    user: self,
    channels: {
      cache,
      fetch: async (id: string) => byId.get(id) ?? null,
    },
    users: {
      cache: collection([dana]),
      fetch: async (id: string) => {
        const found = user({ id });
        (found as Record<string, unknown>).getProfile = async () => options.profile ?? {};
        return found;
      },
    },
    guilds: { cache: collection((options.guilds ?? []) as Array<{ id: string }>) },
  };

  const searchCalls: Array<{ content: string; authors: string[]; limit: number }> = [];
  for (const channel of channels as Array<Record<string, unknown>>) {
    channel.messages = {
      fetch: async () => collection(messages as Array<{ id: string }>),
      search: async (query: { content: string; authors: string[]; limit: number }) => {
        searchCalls.push(query);
        return {
          messages: collection((options.search?.messages ?? messages) as Array<{ id: string }>),
          total: options.search?.total ?? messages.length,
        };
      },
    };
    channel.send = async () => options.sendResult ?? rawMessage({ id: "sent-1" });
  }
  for (const raw of messages as Array<Record<string, unknown>>) {
    raw.fetchReference = async () => rawMessage({ id: "90", content: "the original ask" });
  }

  return Object.assign(client, { searchCalls });
}

describe("SelfbotDiscordApi", () => {
  it("exposes the signed-in account", () => {
    const api = new SelfbotDiscordApi(makeClient() as never);
    expect(api.self()).toEqual({ id: "self-1", username: "me", globalName: "Me" });
  });

  it("maps a DM channel", async () => {
    const api = new SelfbotDiscordApi(makeClient() as never);
    expect(await api.getChannel("chan-1")).toEqual({
      id: "chan-1",
      kind: "dm",
      name: "dana",
      guildId: null,
      guildName: null,
      recipientIds: ["user-1"],
    });
  });

  it("returns null for an unknown channel", async () => {
    const api = new SelfbotDiscordApi(makeClient() as never);
    expect(await api.getChannel("nope")).toBeNull();
  });

  it("maps a group DM", async () => {
    const api = new SelfbotDiscordApi(
      makeClient({
        channels: [
          {
            id: "gdm-1",
            type: "GROUP_DM",
            name: "the crew",
            recipients: collection([user(), user({ id: "user-2", username: "sam" })]),
          },
        ],
      }) as never,
    );
    expect(await api.getChannel("gdm-1")).toMatchObject({
      kind: "group_dm",
      name: "the crew",
      recipientIds: ["user-1", "user-2"],
    });
  });

  it("maps a server channel with its guild", async () => {
    const api = new SelfbotDiscordApi(
      makeClient({
        channels: [
          { id: "c-1", type: "GUILD_TEXT", name: "general", guild: { id: "g1", name: "Acme" } },
        ],
      }) as never,
    );
    expect(await api.getChannel("c-1")).toMatchObject({
      kind: "guild_text",
      name: "general",
      guildId: "g1",
      guildName: "Acme",
    });
  });

  it("lists conversations newest first with a limit", async () => {
    const api = new SelfbotDiscordApi(
      makeClient({
        channels: [
          dmChannel({ id: "old", lastMessage: { createdAt: new Date("2026-01-01T00:00:00.000Z") } }),
          dmChannel({ id: "new", lastMessage: { createdAt: new Date("2026-11-01T00:00:00.000Z") } }),
        ],
      }) as never,
    );
    const list = await api.listConversations({ limit: 1 });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("new");
    expect(list[0]?.lastMessageAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("maps messages, attachments and mentions", async () => {
    const api = new SelfbotDiscordApi(makeClient() as never);
    const [mapped] = await api.readMessages({ channelId: "chan-1", limit: 10 });
    expect(mapped).toMatchObject({
      id: "100",
      channelKind: "dm",
      content: "hello there",
      createdAt: "2026-11-18T10:00:00.000Z",
      embedCount: 2,
      pinned: false,
      messageRequest: false,
      author: { id: "user-1", username: "dana", globalName: "Dana", bot: false },
    });
    expect(mapped?.attachments).toEqual([
      {
        id: "a1",
        name: "invoice.pdf",
        url: "https://cdn.example/i.pdf",
        contentType: "application/pdf",
        size: 12,
      },
    ]);
    expect(mapped?.mentions).toEqual([
      { id: "self-1", username: "me", globalName: "Dana", bot: false },
    ]);
  });

  it("fills in the quoted text of a reply", async () => {
    const api = new SelfbotDiscordApi(
      makeClient({
        messages: [
          rawMessage({ id: "100", reference: { messageId: "90" } }),
          rawMessage({ id: "90", content: "the original ask", reference: null }),
        ],
      }) as never,
    );
    const messages = await api.readMessages({ channelId: "chan-1", limit: 10 });
    const reply = messages.find((item) => item.id === "100");
    expect(reply?.replyTo).toEqual({
      messageId: "90",
      authorId: "user-1",
      content: "the original ask",
    });
  });

  it("can skip reply resolution", async () => {
    const api = new SelfbotDiscordApi(makeClient() as never, { resolveReplies: false });
    const [mapped] = await api.readMessages({ channelId: "chan-1", limit: 10 });
    expect(mapped?.replyTo).toEqual({ messageId: "90", authorId: null, content: null });
  });

  it("sorts messages newest first even if the API does not", async () => {
    const api = new SelfbotDiscordApi(
      makeClient({
        messages: [
          rawMessage({ id: "9", reference: null }),
          rawMessage({ id: "10", reference: null }),
          rawMessage({ id: "100", reference: null }),
        ],
      }) as never,
    );
    const messages = await api.readMessages({ channelId: "chan-1", limit: 10 });
    expect(messages.map((item) => item.id)).toEqual(["100", "10", "9"]);
  });

  it("caps search at Discord's 25-result limit", async () => {
    const client = makeClient({ search: { messages: [], total: 0 } });
    const api = new SelfbotDiscordApi(client as never);
    await api.searchMessages({ channelId: "chan-1", content: "invoice", limit: 100 });
    // The library throws above 25, so the adapter must clamp before calling it.
    expect(client.searchCalls[0]).toMatchObject({ content: "invoice", limit: 25 });
  });

  it("maps a full profile", async () => {
    const profile = {
      user: user({
        bio: "builds things",
        pronouns: "she/her",
        connected_accounts: [{ type: "github", name: "dana", verified: true }],
      }),
      mutual_guilds: [{ id: "g1", nick: "D", name: "Acme" }],
      mutual_friends: [{ id: "f1", username: "sam", global_name: "Sam" }],
      guild_member: { nick: "Dana", joined_at: "2024-01-01T00:00:00.000Z", roles: ["r1"] },
    };
    const api = new SelfbotDiscordApi(makeClient({ profile }) as never);
    const mapped = await api.getProfile({ userId: "user-1", guildId: "g1" });
    expect(mapped).toMatchObject({
      bio: "builds things",
      pronouns: "she/her",
      relationship: "FRIEND",
      friendNickname: "D",
      note: "met at the conference",
      mutualGuilds: [{ id: "g1", name: "Acme", nickname: "D" }],
      mutualFriends: [{ id: "f1", username: "sam", globalName: "Sam" }],
      connectedAccounts: [{ type: "github", name: "dana", verified: true }],
      member: { guildId: "g1", nickname: "Dana", roles: ["r1"] },
    });
    expect(mapped.user.createdAt).toBe("2021-01-01T00:00:00.000Z");
  });

  it("survives a profile lookup the API rejects", async () => {
    const client = makeClient();
    (client.users.cache.get("user-1") as Record<string, unknown>).getProfile = async () => {
      throw new Error("Missing Access");
    };
    const api = new SelfbotDiscordApi(client as never);
    const mapped = await api.getProfile({ userId: "user-1" });
    expect(mapped.bio).toBeNull();
    expect(mapped.mutualGuilds).toEqual([]);
  });

  it("lists guilds", async () => {
    const api = new SelfbotDiscordApi(
      makeClient({ guilds: [{ id: "g1", name: "Acme", memberCount: 12, ownerId: "o1" }] }) as never,
    );
    expect(await api.listGuilds()).toEqual([
      { id: "g1", name: "Acme", memberCount: 12, ownerId: "o1" },
    ]);
  });

  it("sends a message", async () => {
    const api = new SelfbotDiscordApi(makeClient() as never);
    const sent = await api.sendMessage({ channelId: "chan-1", text: "on it" });
    expect(sent.id).toBe("sent-1");
  });

  it("refuses to send empty text", async () => {
    const api = new SelfbotDiscordApi(makeClient() as never);
    await expect(api.sendMessage({ channelId: "chan-1", text: "   " })).rejects.toThrow(/empty/);
  });
});

describe("event helpers", () => {
  it("maps a live message event", () => {
    const mapped = messageFromEvent(rawMessage() as never);
    expect(mapped).toMatchObject({ id: "100", channelKind: "dm", content: "hello there" });
  });

  it("reads mentioned user ids", () => {
    expect(mentionedIds(rawMessage() as never)).toEqual(["self-1"]);
  });
});
