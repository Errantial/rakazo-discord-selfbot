import { Client, Collection, Guild, Message } from "discord.js-selfbot-v13";
import { describe, expect, it } from "vitest";
import { messageFromEvent, mentionedIds, SelfbotDiscordApi } from "../src/discord/selfbot.js";

/**
 * These tests build *real* discord.js-selfbot-v13 objects offline and only stub
 * the network, so the adapter is checked against the library's actual shapes
 * rather than against a guess. Two real bugs came out of writing them:
 *
 * - `getProfile` returns Discord's raw snake_case JSON, not a library User, so
 *   reading `globalName` / `createdAt` off it blanked the profile.
 * - `User#bannerURL()` throws until the banner is fetched, which crashed every
 *   profile lookup for a user with no banner.
 *
 * The library is archived, so pinning its behaviour here is the early warning
 * for a breaking change.
 */

const SELF = "111000111222333444";
const DANA = "555000111222333444";
const SAM = "777000111222333444";
const GUILD = "600000111222333444";
const GUILD_CHANNEL = "700000111222333444";

function rawUser(id: string, username: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    username,
    global_name: username[0]!.toUpperCase() + username.slice(1),
    discriminator: "0",
    avatar: null,
    public_flags: 0,
    ...extra,
  };
}

function rawMessage(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    id: "1000000000000000002",
    channel_id: "999000111222333444",
    content: "can you check the invoice?",
    timestamp: "2026-11-18T10:00:00.000000+00:00",
    author: rawUser(DANA, "dana"),
    attachments: [
      {
        id: "a1",
        filename: "invoice.pdf",
        url: "https://cdn.example/i.pdf",
        content_type: "application/pdf",
        size: 12,
      },
    ],
    embeds: [],
    mentions: [rawUser(SELF, "me")],
    message_reference: { message_id: "1000000000000000001", channel_id: "999000111222333444" },
    pinned: false,
    type: 0,
    mention_everyone: false,
    tts: false,
    edited_timestamp: null,
    flags: 0,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

/** `_add` is the library's own way of materialising a structure from raw JSON. */
type Adder = { _add: (data: Record<string, unknown>) => unknown };

/**
 * `Guild` and `Message` have private constructors in the typings, but the
 * runtime constructors are the supported way to build them from raw data.
 */
type Constructable<T> = new (client: Client, data: Record<string, unknown>) => T;

type Fixture = {
  client: Client;
  api: SelfbotDiscordApi;
  dm: { id: string };
  guildChannel: { id: string };
  message: Message;
  parent: Message;
};

/**
 * A client whose caches hold real library objects. `messages.fetch` and
 * `messages.search` are the only stubs, because those always hit the API.
 */
function fixture(options: { profile?: unknown; failProfile?: boolean } = {}): Fixture {
  const client = new Client();

  const guild = new (Guild as unknown as Constructable<Guild>)(client, {
    id: GUILD,
    name: "Acme",
    owner_id: "1",
    member_count: 12,
    channels: [{ id: GUILD_CHANNEL, type: 0, name: "general", guild_id: GUILD, position: 0 }],
    roles: [],
    emojis: [],
    features: [],
    verification_level: 0,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    mfa_level: 0,
    premium_tier: 0,
    nsfw_level: 0,
    stickers: [],
  });
  (client.guilds.cache as Collection<string, Guild>).set(GUILD, guild);

  const dm = (client.channels as unknown as Adder)._add({
    id: "999000111222333444",
    type: 1,
    recipients: [rawUser(DANA, "dana")],
    last_message_id: "1000000000000000003",
  });
  const guildChannel = client.channels.cache.get(GUILD_CHANNEL);
  if (!guildChannel) throw new Error("guild channel fixture missing");

  const BuildMessage = Message as unknown as Constructable<Message>;
  const message = new BuildMessage(client, rawMessage());
  const parent = new BuildMessage(
    client,
    rawMessage({
      id: "1000000000000000001",
      content: "the original ask",
      message_reference: undefined,
    }),
  );

  const cache = new Collection<string, Message>();
  cache.set(message.id, message);
  cache.set(parent.id, parent);

  const dmMessages = (dm as unknown as { messages: Record<string, unknown> }).messages;
  dmMessages.fetch = async () => cache;
  const guildMessages = (guildChannel as unknown as { messages: Record<string, unknown> }).messages;
  guildMessages.fetch = async () => cache;
  guildMessages.search = async () => ({ messages: cache, total: 2 });

  const users = client.users as unknown as Adder;
  (client as unknown as { user: unknown }).user = users._add(rawUser(SELF, "me"));

  const dana = users._add(rawUser(DANA, "dana", { avatar: "abc123" })) as unknown as Record<
    string,
    unknown
  >;
  // The library keeps these in caches, not on the user object.
  (client.relationships.cache as Collection<string, number>).set(DANA, 1);
  (client.relationships.friendNicknames as Collection<string, string | null>).set(DANA, "D");
  (client.notes.cache as Collection<string, string>).set(DANA, "met at the conference");
  dana.getProfile = async () => {
    if (options.failProfile) throw new Error("Missing Access");
    return (
      options.profile ?? {
        user: {
          id: DANA,
          username: "dana",
          global_name: "Dana B",
          bio: "builds things",
          avatar: "abc123",
          banner: "ban456",
        },
        user_profile: {
          bio: "builds things",
          pronouns: "she/her",
          connected_accounts: [{ type: "github", name: "dana", verified: true }],
        },
        mutual_guilds: [{ id: "g1", nick: "D", name: "Acme" }],
        mutual_friends: [{ id: "f1", username: "sam", global_name: "Sam" }],
        guild_member: { nick: "Dana", joined_at: "2024-01-01T00:00:00.000Z", roles: ["r1"] },
      }
    );
  };

  return {
    client,
    api: new SelfbotDiscordApi(client),
    dm: dm as unknown as { id: string },
    guildChannel: guildChannel as unknown as { id: string },
    message,
    parent,
  };
}

describe("adapter against real library objects", () => {
  it("reads the signed-in account", () => {
    const { api } = fixture();
    expect(api.self()).toEqual({ id: SELF, username: "me", globalName: "Me" });
  });

  it("maps a real DMChannel", async () => {
    const { api, dm } = fixture();
    expect(await api.getChannel(dm.id)).toEqual({
      id: "999000111222333444",
      kind: "dm",
      name: "dana",
      guildId: null,
      guildName: null,
      recipientIds: [DANA],
    });
  });

  it("maps a real TextChannel with its guild", async () => {
    const { api, guildChannel } = fixture();
    expect(await api.getChannel(guildChannel.id)).toMatchObject({
      kind: "guild_text",
      name: "general",
      guildId: GUILD,
      guildName: "Acme",
    });
  });

  it("lists DMs newest-first and omits server channels by default", async () => {
    const { api } = fixture();
    const list = await api.listConversations({ limit: 25 });
    expect(list.map((item) => item.kind)).toEqual(["dm"]);
    expect(list[0]?.lastMessageId).toBe("1000000000000000003");
  });

  it("includes server channels when asked", async () => {
    const { api } = fixture();
    const list = await api.listConversations({ limit: 25, kinds: ["guild_text"] });
    expect(list.map((item) => item.kind)).toEqual(["guild_text"]);
  });

  it("maps a real Message, its attachments and mentions", async () => {
    const { api, dm, message } = fixture();
    const read = await api.readMessages({ channelId: dm.id, limit: 10 });
    const found = read.find((item) => item.id === message.id);
    expect(found).toMatchObject({
      channelKind: "dm",
      content: "can you check the invoice?",
      author: { id: DANA, username: "dana", globalName: "Dana", bot: false },
      pinned: false,
    });
    expect(found?.attachments).toEqual([
      {
        id: "a1",
        name: "invoice.pdf",
        url: "https://cdn.example/i.pdf",
        contentType: "application/pdf",
        size: 12,
      },
    ]);
    expect(found?.mentions.map((user) => user.id)).toEqual([SELF]);
    // Timestamps come from the snowflake, not the payload string.
    expect(found?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("fills in the quoted text of a real reply", async () => {
    const { api, dm, message } = fixture();
    const read = await api.readMessages({ channelId: dm.id, limit: 10 });
    expect(read.find((item) => item.id === message.id)?.replyTo).toEqual({
      messageId: "1000000000000000001",
      authorId: DANA,
      content: "the original ask",
    });
  });

  it("searches through a real guild channel", async () => {
    const { api, guildChannel } = fixture();
    const result = await api.searchMessages({
      channelId: guildChannel.id,
      content: "invoice",
      limit: 5,
    });
    expect(result.total).toBe(2);
    expect(result.messages.every((item) => item.channelKind === "guild_text")).toBe(true);
  });

  it("lists real guilds", async () => {
    const { api } = fixture();
    expect(await api.listGuilds()).toEqual([
      { id: GUILD, name: "Acme", memberCount: 12, ownerId: "1" },
    ]);
  });

  it("maps a real profile, including snake_case raw JSON", async () => {
    const { api } = fixture();
    const profile = await api.getProfile({ userId: DANA, guildId: "g1" });
    expect(profile).toMatchObject({
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
    // These three came back null before the raw-JSON fix.
    expect(profile.user.globalName).toBe("Dana");
    expect(profile.user.createdAt).toMatch(/^\d{4}-/);
    expect(profile.avatarUrl).toContain("/avatars/");
    expect(profile.bannerUrl).toContain("/banners/");
  });

  it("does not crash when the banner was never fetched", async () => {
    const { client, api } = fixture({
      profile: { user: { id: SAM, username: "sam" } },
    });
    const sam = (client.users as unknown as Adder)._add(rawUser(SAM, "sam")) as unknown as Record<
      string,
      unknown
    >;
    sam.getProfile = async () => ({ user: { id: SAM, username: "sam" } });
    (client.users.cache as Collection<string, unknown>).set(SAM, sam);

    const profile = await api.getProfile({ userId: SAM });
    expect(profile.bannerUrl).toBeNull();
    expect(profile.bio).toBeNull();
    expect(profile.mutualGuilds).toEqual([]);
  });

  it("survives a profile the API rejects", async () => {
    const { api } = fixture({ failProfile: true });
    const profile = await api.getProfile({ userId: DANA });
    expect(profile.bio).toBeNull();
    expect(profile.mutualGuilds).toEqual([]);
    expect(profile.relationship).toBe("FRIEND");
  });

  it("maps a live message event", () => {
    const { message } = fixture();
    expect(messageFromEvent(message)).toMatchObject({
      id: message.id,
      channelKind: "dm",
      content: "can you check the invoice?",
    });
    expect(mentionedIds(message)).toEqual([SELF]);
  });

  it("refuses to send empty text", async () => {
    const { api, dm } = fixture();
    await expect(api.sendMessage({ channelId: dm.id, text: "   " })).rejects.toThrow(/empty/);
  });

  it("throws a clear error for an unknown channel", async () => {
    const { api } = fixture();
    await expect(api.sendMessage({ channelId: "404", text: "hi" })).rejects.toThrow(/Unknown channel/);
  });
});
