import { describe, expect, it } from "vitest";
import { decideWake, SeenMessages } from "../src/triggers.js";
import type { TriggerConfig } from "../src/config.js";
import { message } from "./fake-api.js";

const base: TriggerConfig = {
  dms: true,
  messageRequests: false,
  mentions: true,
  channelIds: [],
  keywords: [],
  fromUserIds: [],
  ignoreUserIds: [],
  ignoreBots: true,
  ignoreSelf: true,
};

const ctx = { selfId: "self-1", mentionedUserIds: [] as string[] };

describe("decideWake", () => {
  it("wakes on a DM", () => {
    const decision = decideWake(message(), base, ctx);
    expect(decision).toMatchObject({ wake: true, reason: "dm" });
  });

  it("does not wake on a DM when dms is off", () => {
    expect(decideWake(message(), { ...base, dms: false }, ctx)).toMatchObject({
      wake: false,
      reason: "DMs are not a trigger",
    });
  });

  it("ignores unaccepted message requests by default", () => {
    const request = message({ messageRequest: true });
    expect(decideWake(request, base, ctx)).toMatchObject({
      wake: false,
      reason: "unaccepted message request",
    });
    expect(decideWake(request, { ...base, messageRequests: true }, ctx)).toMatchObject({
      wake: true,
      reason: "message_request",
    });
  });

  it("wakes on a mention in a server channel", () => {
    const mention = message({ channelKind: "guild_text", guildId: "g1", mentions: [{ id: "self-1", username: "me", globalName: null, bot: false }] });
    expect(decideWake(mention, base, ctx)).toMatchObject({ wake: true, reason: "mention" });
  });

  it("does not wake on an unmentioned server message", () => {
    const plain = message({ channelKind: "guild_text", guildId: "g1" });
    expect(decideWake(plain, base, ctx)).toMatchObject({ wake: false, reason: "no trigger matched" });
  });

  it("wakes on a watched channel without a mention", () => {
    const plain = message({ channelKind: "guild_text", channelId: "watched" });
    expect(decideWake(plain, { ...base, channelIds: ["watched"] }, ctx)).toMatchObject({
      wake: true,
      reason: "channel",
    });
  });

  it("wakes on a keyword case-insensitively", () => {
    const keyworded = message({ channelKind: "guild_text", content: "is the DEPLOY done?" });
    expect(decideWake(keyworded, { ...base, keywords: ["deploy"] }, ctx)).toMatchObject({
      wake: true,
      reason: "keyword",
      detail: 'matched "deploy"',
    });
  });

  it("needs a mention for group DMs", () => {
    const group = message({ channelKind: "group_dm" });
    expect(decideWake(group, base, ctx)).toMatchObject({ wake: false });
    const mentioned = message({
      channelKind: "group_dm",
      mentions: [{ id: "self-1", username: "me", globalName: null, bot: false }],
    });
    expect(decideWake(mentioned, base, ctx)).toMatchObject({ wake: true, reason: "mention" });
  });

  it("applies ignore and from filters before triggers", () => {
    const fromDana = message();
    expect(decideWake(fromDana, { ...base, ignoreUserIds: ["user-1"] }, ctx)).toMatchObject({
      wake: false,
      reason: "author is ignored",
    });
    expect(decideWake(fromDana, { ...base, fromUserIds: ["someone-else"] }, ctx)).toMatchObject({
      wake: false,
      reason: "author is not in the from list",
    });
    expect(decideWake(fromDana, { ...base, fromUserIds: ["user-1"] }, ctx)).toMatchObject({
      wake: true,
      reason: "dm",
    });
  });

  it("ignores bots and its own messages", () => {
    const bot = message({ author: { id: "bot-1", username: "app", globalName: null, bot: true } });
    expect(decideWake(bot, base, ctx)).toMatchObject({ wake: false, reason: "author is a bot" });
    expect(decideWake(bot, { ...base, ignoreBots: false }, ctx)).toMatchObject({ wake: true });

    const own = message({ author: { id: "self-1", username: "me", globalName: null, bot: false } });
    expect(decideWake(own, base, ctx)).toMatchObject({ wake: false, reason: "own message" });
    expect(decideWake(own, { ...base, ignoreSelf: false }, ctx)).toMatchObject({ wake: true });
  });
});

describe("SeenMessages", () => {
  it("claims a key once", () => {
    const seen = new SeenMessages(60_000);
    expect(seen.claim("a")).toBe(true);
    expect(seen.claim("a")).toBe(false);
  });

  it("forgets keys after the ttl", () => {
    let now = 1_000;
    const seen = new SeenMessages(1_000, 100, () => now);
    expect(seen.claim("a")).toBe(true);
    now += 1_500;
    expect(seen.claim("a")).toBe(true);
  });

  it("evicts the oldest key past the cap", () => {
    const seen = new SeenMessages(60_000, 2);
    seen.claim("a");
    seen.claim("b");
    seen.claim("c");
    expect(seen.claim("a")).toBe(true);
  });
});
