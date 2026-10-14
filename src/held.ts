/**
 * The hold queue.
 *
 * A message that policy says should be reviewed is parked here rather than
 * delivered. It leaves the queue in one of three ways: approved, denied, or
 * expired — and each maps directly onto the receipt the sender receives.
 *
 * Entries are held in insertion order so that the oldest can be evicted first
 * when the queue is full.
 */

import { randomUUID } from "node:crypto";

import {
  HELD_QUEUE_MAX,
  type FileAttachment,
  type FromMode,
  type Priority,
} from "./protocol.ts";
import type { PolicyCause } from "./policy.ts";

/** How a held message left the queue. Mirrors the wire receipt statuses. */
export type HeldOutcome = "delivered" | "denied" | "expired";

export interface HeldMessage {
  /** Short id an operator uses to approve or deny. */
  id: string;
  receivedAt: number;
  from: string;
  fromName?: string;
  msgId?: string;
  /** Whether the sender is a session in the registry. */
  knownPeer: boolean;
  /** Why it was held. Only some causes warrant an unsolicited prompt. */
  cause: PolicyCause;
  body: string;
  fromMode?: FromMode;
  selfSent: boolean;
  priority: Priority;
  /** Attachments as described by the sender, before any local copies. */
  attachments?: FileAttachment[];
  /** Local copies created on receipt, removed if the message is dropped. */
  attachmentPaths?: string[];
  sessionId: string;
}

export interface HeldQueueOptions {
  /**
   * The session these entries belong to. A function is accepted so a queue can
   * track a session id that changes (as `/clear` does) rather than stamping a
   * value that later disagrees with where attachments were actually written.
   */
  sessionId: string | (() => string);
  /** Entries kept before the oldest is evicted. Defaults to HELD_QUEUE_MAX. */
  max?: number;
  /** How long an entry waits before expiring. Zero disables the timer. */
  expiryMs?: number;
  now?: () => number;
  /** Called as soon as an entry is queued. */
  onHeld?: (message: HeldMessage) => void;
  /** Called once per entry when it leaves the queue. */
  onResolved?: (message: HeldMessage, outcome: HeldOutcome) => void;
}

export class HeldQueue {
  readonly #entries = new Map<string, HeldMessage>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #max: number;
  readonly #expiryMs: number;
  readonly #sessionId: string | (() => string);
  readonly #now: () => number;
  readonly #onHeld?: (message: HeldMessage) => void;
  readonly #onResolved?: (message: HeldMessage, outcome: HeldOutcome) => void;

  constructor(options: HeldQueueOptions) {
    this.#sessionId = options.sessionId;
    // A capacity of zero would mean the entry being added is itself the
    // oldest, so it would be evicted inside `add` before the caller can ever
    // reference it. Refusing to hold is what `refuse` policy is for.
    this.#max = Math.max(1, options.max ?? HELD_QUEUE_MAX);
    this.#expiryMs = options.expiryMs ?? 0;
    this.#now = options.now ?? Date.now;
    if (options.onHeld) this.#onHeld = options.onHeld;
    if (options.onResolved) this.#onResolved = options.onResolved;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Queued messages, oldest first. */
  list(): HeldMessage[] {
    return [...this.#entries.values()];
  }

  get(id: string): HeldMessage | undefined {
    return this.#entries.get(id);
  }

  /**
   * Queue a message. When the queue is over capacity the oldest entry is
   * resolved as `expired`, matching the reference behaviour.
   */
  add(input: Omit<HeldMessage, "id" | "receivedAt" | "sessionId">): HeldMessage {
    const message: HeldMessage = {
      id: this.#freshId(),
      receivedAt: this.#now(),
      sessionId:
        typeof this.#sessionId === "function" ? this.#sessionId() : this.#sessionId,
      ...input,
    };

    this.#entries.set(message.id, message);
    this.#arm(message);

    // Evict before announcing, so a consumer that reacts to `onHeld` never sees
    // a queue over capacity — and never sees an entry that is already gone.
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#settle(oldest, "expired");
    }

    if (this.#entries.has(message.id)) this.#onHeld?.(message);

    return message;
  }

  /** An 8-character id that is not already in use. */
  #freshId(): string {
    for (;;) {
      const id = randomUUID().slice(0, 8);
      if (!this.#entries.has(id)) return id;
    }
  }

  approve(id: string): boolean {
    return this.#settle(id, "delivered");
  }

  deny(id: string): boolean {
    return this.#settle(id, "denied");
  }

  expire(id: string): boolean {
    return this.#settle(id, "expired");
  }

  /** Expire everything still queued, e.g. when the session shuts down. */
  expireAll(): void {
    for (const id of [...this.#entries.keys()]) this.#settle(id, "expired");
  }

  /** Drop timers without resolving. Call after {@link expireAll}. */
  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#entries.clear();
  }

  #arm(message: HeldMessage): void {
    if (this.#expiryMs <= 0) return;

    const elapsed = this.#now() - message.receivedAt;
    const delay = Math.max(0, this.#expiryMs - elapsed);

    const timer = setTimeout(() => {
      this.#timers.delete(message.id);
      this.#settle(message.id, "expired");
    }, delay);
    timer.unref?.();

    this.#timers.set(message.id, timer);
  }

  #settle(id: string, outcome: HeldOutcome): boolean {
    const message = this.#entries.get(id);
    if (!message) return false;

    this.#entries.delete(id);

    const timer = this.#timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }

    this.#onResolved?.(message, outcome);
    return true;
  }
}
