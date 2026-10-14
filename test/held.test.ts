import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HeldQueue, type HeldMessage, type HeldOutcome } from "../src/held.ts";
import { HELD_QUEUE_MAX } from "../src/protocol.ts";

/** Everything `add()` accepts; id, receivedAt and sessionId are stamped by the queue. */
type AddInput = Omit<HeldMessage, "id" | "receivedAt" | "sessionId">;

const SESSION_ID = "session-under-test";

function input(overrides: Partial<AddInput> = {}): AddInput {
  return {
    from: "uds:/run/user/1000/qoder-socks/1.sock",
    knownPeer: true,
    cause: "repo-setting",
    body: "hello",
    selfSent: false,
    priority: "now",
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collects (message, outcome) pairs so tests can assert on both. */
function recorder(): {
  calls: Array<{ message: HeldMessage; outcome: HeldOutcome }>;
  onResolved: (message: HeldMessage, outcome: HeldOutcome) => void;
} {
  const calls: Array<{ message: HeldMessage; outcome: HeldOutcome }> = [];
  return {
    calls,
    onResolved: (message, outcome) => {
      calls.push({ message, outcome });
    },
  };
}

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

describe("add", () => {
  it("returns an entry with an 8-character id", () => {
    const queue = new HeldQueue({ sessionId: SESSION_ID });

    const message = queue.add(input());

    assert.equal(message.id.length, 8);
    assert.match(message.id, /^[0-9a-f]{8}$/);
  });

  it("stamps receivedAt from the injected clock and the queue sessionId", () => {
    const queue = new HeldQueue({ sessionId: SESSION_ID, now: () => 1234 });

    const message = queue.add(input());

    assert.equal(message.receivedAt, 1234);
    assert.equal(message.sessionId, SESSION_ID);
    assert.equal(queue.get(message.id), message);
  });

  it("carries the caller's fields through unchanged", () => {
    const queue = new HeldQueue({ sessionId: SESSION_ID });
    const attachments = [{ path: "/tmp/a.txt", name: "a.txt", bytes: 3 }];

    const message = queue.add(
      input({
        from: "uds:/run/other.sock",
        fromName: "other",
        msgId: "m-1",
        body: "payload",
        fromMode: "prompting",
        knownPeer: false,
        selfSent: true,
        priority: "later",
        attachments,
      }),
    );

    assert.equal(message.from, "uds:/run/other.sock");
    assert.equal(message.fromName, "other");
    assert.equal(message.msgId, "m-1");
    assert.equal(message.body, "payload");
    assert.equal(message.fromMode, "prompting");
    assert.equal(message.knownPeer, false);
    assert.equal(message.selfSent, true);
    assert.equal(message.priority, "later");
    assert.deepEqual(message.attachments, attachments);
  });

  it("reports size and looks entries up by id", () => {
    const queue = new HeldQueue({ sessionId: SESSION_ID });
    assert.equal(queue.size, 0);

    const first = queue.add(input());
    const second = queue.add(input());

    assert.equal(queue.size, 2);
    assert.equal(queue.get(first.id), first);
    assert.equal(queue.get(second.id), second);
    assert.equal(queue.get("missing1"), undefined);
    assert.equal(queue.get(""), undefined);
  });

  it("lists entries oldest first", () => {
    const queue = new HeldQueue({ sessionId: SESSION_ID });
    const bodies = ["first", "second", "third"];

    for (const body of bodies) queue.add(input({ body }));

    assert.deepEqual(
      queue.list().map((message) => message.body),
      bodies,
    );
  });

  it("returns a snapshot that does not mutate the queue", () => {
    const queue = new HeldQueue({ sessionId: SESSION_ID });
    queue.add(input());

    queue.list().pop();

    assert.equal(queue.size, 1);
  });

  it("invokes onHeld synchronously with the same entry add returns", () => {
    const held: HeldMessage[] = [];
    const queue = new HeldQueue({
      sessionId: SESSION_ID,
      onHeld: (message) => held.push(message),
    });

    const added = queue.add(input());

    // The callback ran before add() returned, and saw identical objects.
    assert.equal(held.length, 1);
    assert.equal(held[0], added);
    assert.equal(queue.get(added.id), held[0]);
  });
});

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

describe("capacity", () => {
  it("evicts the oldest entry as expired when the queue is full", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, max: 3, onResolved });

    const oldest = queue.add(input({ body: "oldest" }));
    queue.add(input({ body: "second" }));
    queue.add(input({ body: "third" }));
    assert.equal(queue.size, 3);
    assert.equal(calls.length, 0);

    const newest = queue.add(input({ body: "newest" }));

    assert.equal(queue.size, 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.outcome, "expired");
    assert.equal(calls[0]!.message.id, oldest.id);
    assert.equal(queue.get(oldest.id), undefined);
    assert.deepEqual(
      queue.list().map((message) => message.body),
      ["second", "third", "newest"],
    );
    assert.equal(queue.get(newest.id), newest);
  });

  it("never exceeds max across a burst of adds", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, max: 3, onResolved });

    for (let i = 0; i < 10; i += 1) {
      queue.add(input({ body: `m${i}` }));
      assert.equal(queue.size <= 3, true);
    }

    assert.equal(queue.size, 3);
    assert.deepEqual(
      queue.list().map((message) => message.body),
      ["m7", "m8", "m9"],
    );
    assert.equal(calls.length, 7);
    assert.equal(
      calls.every((call) => call.outcome === "expired"),
      true,
    );
  });

  it("honours the default max from the protocol", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, onResolved });

    for (let i = 0; i < HELD_QUEUE_MAX; i += 1) queue.add(input({ body: `m${i}` }));
    assert.equal(queue.size, HELD_QUEUE_MAX);
    assert.equal(calls.length, 0);

    queue.add(input({ body: "overflow" }));

    assert.equal(queue.size, HELD_QUEUE_MAX);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.message.body, "m0");
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("approve / deny / expire", () => {
  it("approve resolves as delivered and removes the entry", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, onResolved });
    const message = queue.add(input());

    assert.equal(queue.approve(message.id), true);

    assert.equal(queue.size, 0);
    assert.equal(queue.get(message.id), undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.message.id, message.id);
    assert.equal(calls[0]!.outcome, "delivered");
  });

  it("deny resolves as denied", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, onResolved });
    const message = queue.add(input());

    assert.equal(queue.deny(message.id), true);

    assert.equal(queue.size, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.outcome, "denied");
  });

  it("expire resolves as expired", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, onResolved });
    const message = queue.add(input());

    assert.equal(queue.expire(message.id), true);

    assert.equal(queue.size, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.outcome, "expired");
  });

  it("returns false and does not re-resolve on a repeated operation", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, onResolved });
    const message = queue.add(input());

    assert.equal(queue.approve(message.id), true);
    assert.equal(queue.approve(message.id), false);
    assert.equal(queue.deny(message.id), false);
    assert.equal(queue.expire(message.id), false);
    assert.equal(calls.length, 1);
  });

  it("returns false for an unknown id", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, onResolved });

    assert.equal(queue.approve("nope0000"), false);
    assert.equal(queue.deny("nope0000"), false);
    assert.equal(queue.expire("nope0000"), false);
    assert.equal(calls.length, 0);
  });

  it("leaves the other entries queued", () => {
    const queue = new HeldQueue({ sessionId: SESSION_ID });
    const first = queue.add(input({ body: "first" }));
    const second = queue.add(input({ body: "second" }));

    assert.equal(queue.deny(first.id), true);

    assert.equal(queue.size, 1);
    assert.equal(queue.get(second.id), second);
  });
});

// ---------------------------------------------------------------------------
// Expiry timer
// ---------------------------------------------------------------------------

describe("expiry timer", () => {
  it("auto-expires an entry after expiryMs", async () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, expiryMs: 30, onResolved });

    const message = queue.add(input());
    assert.equal(queue.size, 1);
    assert.equal(calls.length, 0);

    await delay(120);

    assert.equal(queue.size, 0);
    assert.equal(queue.get(message.id), undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.message.id, message.id);
    assert.equal(calls[0]!.outcome, "expired");
  });

  it("expires entries independently, in order of their own deadlines", async () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, expiryMs: 30, onResolved });

    const first = queue.add(input({ body: "first" }));
    const second = queue.add(input({ body: "second" }));

    await delay(120);

    assert.equal(queue.size, 0);
    assert.deepEqual(
      calls.map((call) => call.message.id),
      [first.id, second.id],
    );
    assert.equal(
      calls.every((call) => call.outcome === "expired"),
      true,
    );
  });

  it("cancels the timer when the entry is approved first", async () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, expiryMs: 30, onResolved });
    const message = queue.add(input());

    assert.equal(queue.approve(message.id), true);
    await delay(120);

    // A dangling timer would have produced a second, spurious resolution.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.outcome, "delivered");
  });

  it("does not arm a timer when expiryMs is 0", async () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, expiryMs: 0, onResolved });

    const message = queue.add(input());
    await delay(40);

    assert.equal(queue.size, 1);
    assert.equal(queue.get(message.id), message);
    assert.equal(calls.length, 0);

    queue.expireAll();
  });

  it("does not arm a timer by default", async () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, onResolved });

    queue.add(input());
    await delay(40);

    assert.equal(queue.size, 1);
    assert.equal(calls.length, 0);

    queue.expireAll();
  });

  it("clears the timer of an entry evicted by capacity", async () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, max: 1, expiryMs: 30, onResolved });

    const evicted = queue.add(input({ body: "evicted" }));
    queue.add(input({ body: "kept" }));

    // Eviction resolves the oldest immediately, without waiting for its timer.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.message.id, evicted.id);
    assert.equal(calls[0]!.outcome, "expired");

    await delay(120);

    // The evicted entry's own timer must not fire a second resolution.
    const evictedCalls = calls.filter((call) => call.message.id === evicted.id);
    assert.equal(evictedCalls.length, 1);
    assert.equal(queue.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

describe("expireAll", () => {
  it("resolves every entry as expired and empties the queue", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, onResolved });
    const first = queue.add(input({ body: "first" }));
    const second = queue.add(input({ body: "second" }));
    const third = queue.add(input({ body: "third" }));
    assert.equal(queue.size, 3);

    queue.expireAll();

    assert.equal(queue.size, 0);
    assert.deepEqual(queue.list(), []);
    assert.deepEqual(
      calls.map((call) => call.message.id),
      [first.id, second.id, third.id],
    );
    assert.equal(
      calls.every((call) => call.outcome === "expired"),
      true,
    );
  });

  it("is a no-op on an empty queue", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, onResolved });

    queue.expireAll();

    assert.equal(queue.size, 0);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("close", () => {
  it("empties the queue without resolving", () => {
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({ sessionId: SESSION_ID, onResolved });
    queue.add(input());
    queue.add(input());

    queue.close();

    assert.equal(queue.size, 0);
    assert.deepEqual(queue.list(), []);
    assert.equal(calls.length, 0);
  });

  it("drops armed timers so no callback fires afterwards", async () => {
    const held: HeldMessage[] = [];
    const { calls, onResolved } = recorder();
    const queue = new HeldQueue({
      sessionId: SESSION_ID,
      expiryMs: 30,
      onHeld: (message) => held.push(message),
      onResolved,
    });
    queue.add(input());
    queue.add(input());

    queue.close();
    await delay(120);

    assert.equal(held.length, 2);
    assert.equal(calls.length, 0);
    assert.equal(queue.size, 0);
  });
});
