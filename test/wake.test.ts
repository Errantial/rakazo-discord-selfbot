import { describe, expect, it, vi } from "vitest";
import { buildWakePayload, wakeRoutine } from "../src/wake.js";
import type { RakazoConfig } from "../src/config.js";
import { message } from "./fake-api.js";

const config: RakazoConfig = {
  webhookUrl: "https://rakazo.example/api/v1/bots/bot-1/webhook",
  webhookSecret: "secret",
  extraHeaders: {},
  timeoutMs: 1_000,
};

describe("buildWakePayload", () => {
  it("describes where the message came from", () => {
    const payload = buildWakePayload(message({ content: "can you check the invoice?" }), "dm");
    expect(payload.event).toBe("discord.message");
    expect(payload.reason).toBe("dm");
    expect(payload.summary).toBe("Dana sent you a direct message: can you check the invoice?");
    expect(payload.message).toMatchObject({
      id: "100",
      channel_id: "chan-1",
      author_id: "user-1",
      author_name: "Dana",
    });
  });

  it("falls back to a description when there is no text", () => {
    const payload = buildWakePayload(message({ content: "   " }), "mention");
    expect(payload.summary).toContain("sent an attachment with no text");
  });

  it("keeps the payload within a sane size", () => {
    const payload = buildWakePayload(message({ content: "x".repeat(10_000) }), "dm");
    expect(payload.message.content.length).toBeLessThanOrEqual(4_000);
    expect(payload.message.content.endsWith("…")).toBe(true);
  });

  it("names the server channel for guild messages", () => {
    const payload = buildWakePayload(
      message({ channelKind: "guild_text", guildId: "g1", content: "ping" }),
      "mention",
    );
    expect(payload.summary).toBe("Dana sent you a server channel (chan-1): ping");
  });
});

describe("wakeRoutine", () => {
  it("posts the payload with the bot bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, messageId: "m1", runId: "r1", seq: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await wakeRoutine(config, buildWakePayload(message(), "dm"), {
      idempotencyKey: "discord:100",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    expect(result).toEqual({ ok: true, messageId: "m1", runId: "r1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(config.webhookUrl);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("discord:100");
    expect(JSON.parse(init.body as string).message.id).toBe("100");
  });

  it("reports a rejected wake with its status", async () => {
    const fetchMock = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const result = await wakeRoutine(config, buildWakePayload(message(), "dm"), {
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect(result).toEqual({ ok: false, status: 401, error: "Unauthorized" });
  });

  it("turns a network failure into a result instead of throwing", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await wakeRoutine(config, buildWakePayload(message(), "dm"), {
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 0 });
  });
});
