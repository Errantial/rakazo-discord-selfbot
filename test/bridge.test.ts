import { describe, expect, it, vi } from "vitest";
import { DiscordBridge, WakeQueue, type BridgeEvent } from "../src/bridge.js";
import type { Config } from "../src/config.js";
import { message, FakeDiscordApi } from "./fake-api.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    discordToken: "token",
    totpKey: null,
    triggers: {
      dms: true,
      messageRequests: false,
      mentions: true,
      channelIds: [],
      keywords: [],
      fromUserIds: [],
      ignoreUserIds: [],
      ignoreBots: true,
      ignoreSelf: true,
    },
    send: { mode: "off", allowlist: [], dmOnly: false },
    rakazo: {
      webhookUrl: "https://rakazo.example/api/v1/bots/bot-1/webhook",
      webhookSecret: "secret",
      extraHeaders: {},
      timeoutMs: 1_000,
    },
    mcp: { port: 8787, host: "127.0.0.1", path: "/mcp", token: null },
    verbose: false,
    logFile: null,
    ...overrides,
  };
}

function bridge(overrides: Partial<Config> = {}, fetchImpl?: typeof globalThis.fetch) {
  const api = new FakeDiscordApi();
  const events: BridgeEvent[] = [];
  const instance = new DiscordBridge({
    api,
    config: config(overrides),
    log: () => undefined,
    onEvent: (event) => events.push(event),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return { api, events, instance };
}

const okFetch = (body: Record<string, unknown> = { messageId: "m1", runId: "r1" }) =>
  vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, seq: 1, ...body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof globalThis.fetch;

describe("DiscordBridge", () => {
  it("wakes a routine for a DM", async () => {
    const fetchMock = okFetch();
    const { instance, events } = bridge({}, fetchMock);
    const event = await instance.handleMessage(message());
    expect(event.kind).toBe("wake");
    expect(events).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not wake twice for the same message id", async () => {
    const fetchMock = okFetch();
    const { instance } = bridge({}, fetchMock);
    await instance.handleMessage(message({ id: "42" }));
    const second = await instance.handleMessage(message({ id: "42" }));
    expect(second.kind).toBe("duplicate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips an unmentioned server message without calling Rakazo", async () => {
    const fetchMock = okFetch();
    const { instance } = bridge({}, fetchMock);
    const event = await instance.handleMessage(
      message({ channelKind: "guild_text", guildId: "g1" }),
    );
    expect(event.kind).toBe("skip");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still reports the decision when no webhook is configured", async () => {
    const { instance } = bridge({ rakazo: null });
    const event = await instance.handleMessage(message());
    expect(event).toMatchObject({ kind: "wake", result: { ok: false, status: 0 } });
  });

  it("passes the idempotency key so a retry cannot double-run", async () => {
    const fetchMock = okFetch();
    const { instance } = bridge({}, fetchMock);
    await instance.handleMessage(message({ id: "77" }));
    const init = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe("discord:77");
  });

  it("keeps waking after a failed wake", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch;
    const { instance } = bridge({}, fetchMock);
    const first = await instance.handleMessage(message({ id: "1" }));
    const second = await instance.handleMessage(message({ id: "2" }));
    expect(first).toMatchObject({ kind: "wake", result: { ok: false, status: 500 } });
    expect(second).toMatchObject({ kind: "wake", result: { ok: false, status: 500 } });
  });
});

describe("WakeQueue", () => {
  it("runs tasks in order, one at a time", async () => {
    const queue = new WakeQueue();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const task = (name: string, ms: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(name);
      active -= 1;
    };

    await Promise.all([queue.run(task("a", 20)), queue.run(task("b", 1)), queue.run(task("c", 1))]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1);
    expect(queue.size).toBe(0);
  });

  it("keeps going after a task throws", async () => {
    const queue = new WakeQueue();
    await expect(
      queue.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(queue.run(async () => "ok")).resolves.toBe("ok");
  });
});
