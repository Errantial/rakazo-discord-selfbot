import type { Config } from "./config.js";
import type { DiscordApi, DiscordMessage } from "./discord/types.js";
import { decideWake, SeenMessages, type WakeDecision } from "./triggers.js";
import { buildWakePayload, wakeRoutine, type WakeResult } from "./wake.js";

export type BridgeEvent =
  | { kind: "wake"; decision: Extract<WakeDecision, { wake: true }>; message: DiscordMessage; result: WakeResult }
  | { kind: "skip"; decision: Extract<WakeDecision, { wake: false }>; message: DiscordMessage }
  | { kind: "duplicate"; message: DiscordMessage };

export type Logger = (line: string) => void;

export type BridgeDeps = {
  api: DiscordApi;
  config: Config;
  fetch?: typeof globalThis.fetch;
  log?: Logger;
  /** Called after each handled message, for tests and for the log file. */
  onEvent?: (event: BridgeEvent) => void;
  seen?: SeenMessages;
  /** Serializes wakes so two messages do not start two runs at once. */
  queue?: WakeQueue;
};

/** Runs wakes one at a time; a burst of DMs should not become a burst of runs. */
export class WakeQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );
    return result;
  }
}

export class DiscordBridge {
  private readonly seen: SeenMessages;
  private readonly queue: WakeQueue;
  private readonly log: Logger;

  constructor(private readonly deps: BridgeDeps) {
    this.seen = deps.seen ?? new SeenMessages();
    this.queue = deps.queue ?? new WakeQueue();
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Handle one message event. Safe to call for edits and redeliveries: the
   * message id is claimed once, so a message wakes at most one run.
   */
  async handleMessage(message: DiscordMessage, mentionedUserIds: string[] = []): Promise<BridgeEvent> {
    const self = this.deps.api.self();
    const decision = decideWake(message, this.deps.config.triggers, {
      selfId: self.id,
      mentionedUserIds,
    });

    if (!decision.wake) {
      return this.emit({ kind: "skip", decision, message });
    }

    if (!this.seen.claim(message.id)) {
      return this.emit({ kind: "duplicate", message });
    }

    const rakazo = this.deps.config.rakazo;
    if (!rakazo) {
      const result: WakeResult = { ok: false, status: 0, error: "no RAKAZO_WEBHOOK_URL configured" };
      return this.emit({ kind: "wake", decision, message, result });
    }

    const payload = buildWakePayload(message, decision.reason);
    const result = await this.queue.run(() =>
      wakeRoutine(rakazo, payload, {
        idempotencyKey: `discord:${message.id}`,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      }),
    );

    return this.emit({ kind: "wake", decision, message, result });
  }

  private emit(event: BridgeEvent): BridgeEvent {
    const line = describe(event);
    if (this.deps.config.verbose || event.kind !== "skip") this.log(line);
    this.deps.onEvent?.(event);
    return event;
  }
}

export function describe(event: BridgeEvent): string {
  const where = `${event.message.channelKind}:${event.message.channelId}`;
  const author = event.message.author.globalName ?? event.message.author.username;
  switch (event.kind) {
    case "wake":
      return event.result.ok
        ? `woke ${event.decision.reason} (${where}) from ${author} → run ${event.result.runId ?? "queued"}`
        : `wake failed ${event.decision.reason} (${where}) from ${author} → ${event.result.status} ${event.result.error}`;
    case "duplicate":
      return `skip duplicate (${where}) ${event.message.id}`;
    case "skip":
      return `skip ${event.decision.reason} (${where}) from ${author}`;
  }
}
