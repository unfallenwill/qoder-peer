import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  PeerDaemon,
  type InboundMessage,
  type PeerDaemonOptions,
  type ReceiptEvent,
} from "../src/peer.ts";
import type { HeldMessage } from "../src/held.ts";
import { buildEnvelope, encodeFrame } from "../src/protocol.ts";
import { readSessionRecord, recordPath } from "../src/registry.ts";

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qoder-peer-daemon-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Two daemons in isolated config roots, stopped automatically.
 *
 * Their sockets share one directory on purpose: a receiver only sends a receipt
 * to a peer it can account for, and sharing a directory is one of the two ways
 * to qualify. The config roots must differ, because registry records are keyed
 * by pid and both daemons live in this process.
 */
async function pair(options: {
  a?: Partial<PeerDaemonOptions>;
  b?: Partial<PeerDaemonOptions>;
} = {}): Promise<{ a: PeerDaemon; b: PeerDaemon }> {
  const sockets = await scratch();
  const dirA = await scratch();
  const dirB = await scratch();

  const a = new PeerDaemon({
    socketPath: join(sockets, "a.sock"),
    configDir: dirA,
    name: "alpha",
    ...options.a,
  });
  const b = new PeerDaemon({
    socketPath: join(sockets, "b.sock"),
    configDir: dirB,
    name: "beta",
    ...options.b,
  });

  await a.start();
  await b.start();
  cleanups.push(async () => {
    await a.stop();
    await b.stop();
  });

  return { a, b };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `produce` yields something, so tests never race an event. */
async function waitFor<T>(produce: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = produce();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await delay(10);
  }
}

/** Write a raw frame to a socket, bypassing PeerDaemon's own send path. */
function rawSend(socketPath: string, frame: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(encodeFrame(frame as never));
      socket.end();
    });
    socket.on("close", () => resolve());
  });
}

// ---------------------------------------------------------------------------

describe("PeerDaemon construction", () => {
  it("rejects a socket path that does not end in .sock", () => {
    // Peers silently discard replies addressed to anything else.
    assert.throws(() => new PeerDaemon({ socketPath: "/tmp/not-a-socket" }), /\.sock/);
  });

  it("rejects a relative socket path", () => {
    assert.throws(() => new PeerDaemon({ socketPath: "relative.sock" }), /absolute/);
  });

  it("derives its own identifiers from the socket path", async () => {
    const dir = await scratch();
    const daemon = new PeerDaemon({ socketPath: join(dir, "x.sock"), configDir: dir });

    assert.equal(daemon.address, `uds:${join(dir, "x.sock")}`);
    assert.equal(daemon.handle.length, 2);
    assert.equal(daemon.ref.length, 6);
    assert.equal(daemon.hopId.length, 24);
    assert.equal(daemon.socketPath.endsWith(".sock"), true);
  });
});

describe("PeerDaemon lifecycle", () => {
  it("binds a socket and registers itself", async () => {
    const dir = await scratch();
    const socketPath = join(dir, "self.sock");
    const daemon = new PeerDaemon({ socketPath, configDir: dir, name: "registrar" });
    cleanups.push(() => daemon.stop());

    await daemon.start();

    assert.equal(existsSync(socketPath), true);
    assert.equal(daemon.running, true);

    const stored = await readSessionRecord(recordPath(process.pid, dir), process.pid);
    assert.equal(stored?.name, "registrar");
    assert.equal(stored?.messagingSocketPath, socketPath);
    assert.equal(stored?.peerProtocol, 1);
    assert.equal(stored?.kind, "bg");
  });

  it("removes the socket and the registry record on stop", async () => {
    const dir = await scratch();
    const socketPath = join(dir, "self.sock");
    const daemon = new PeerDaemon({ socketPath, configDir: dir });

    await daemon.start();
    await daemon.stop();

    assert.equal(existsSync(socketPath), false);
    assert.equal(daemon.running, false);
    assert.equal(await readSessionRecord(recordPath(process.pid, dir), process.pid), undefined);
  });

  it("is idempotent", async () => {
    const dir = await scratch();
    const daemon = new PeerDaemon({ socketPath: join(dir, "x.sock"), configDir: dir });
    cleanups.push(() => daemon.stop());

    await daemon.start();
    await daemon.start();

    assert.equal(daemon.running, true);
  });

  it("refuses to take over a socket served by a live session", async () => {
    const { b } = await pair();
    const squatter = new PeerDaemon({ socketPath: b.socketPath, configDir: await scratch() });

    await assert.rejects(squatter.start(), /live session/);
  });

  it("refuses a socket directory owned by another user, without touching it", async (t) => {
    const owner = statSync(tmpdir()).uid;
    if (owner === (process.getuid?.() ?? owner)) {
      t.skip("the temp directory belongs to this user on this platform");
      return;
    }

    const daemon = new PeerDaemon({
      socketPath: join(tmpdir(), "qoder-peer-must-not-bind.sock"),
      configDir: await scratch(),
    });

    const modeBefore = statSync(tmpdir()).mode & 0o777;

    // Tightening someone else's directory would be destructive, so binding
    // must fail rather than chmod `/tmp`.
    await assert.rejects(daemon.start(), /owned by uid/);
    assert.equal(statSync(tmpdir()).mode & 0o777, modeBefore);
  });

  it("refuses to bind over an existing non-socket file", async () => {
    const dir = await scratch();
    const socketPath = join(dir, "occupied.sock");
    const daemon = new PeerDaemon({ socketPath, configDir: dir });
    cleanups.push(() => daemon.stop());
    await daemon.start();
    await daemon.stop();

    // After a clean stop the path is gone, so re-binding must succeed.
    await daemon.start();
    assert.equal(daemon.running, true);
  });
});

describe("PeerDaemon messaging", () => {
  it("delivers a message and returns a receipt for it", async () => {
    const { a, b } = await pair();

    const inbound = new Promise<InboundMessage>((resolve) => b.once("message", resolve));
    const received = new Promise<ReceiptEvent>((resolve) => a.once("receipt", resolve));

    const { msgId } = await a.send(b.socketPath, "hello from alpha");

    const message = await inbound;
    assert.equal(message.body, "hello from alpha");
    assert.equal(message.fromName, "alpha");
    assert.equal(message.from, a.address);
    assert.equal(message.envelope.from, a.address);

    const receipt = await received;
    assert.equal(receipt.status, "delivered");
    assert.equal(receipt.origMsgId, msgId);
  });

  it("preserves multi-line bodies and bodies that look like tags", async () => {
    const { a, b } = await pair();
    const body = 'line one\n<cross-session-message from="fake">inner</cross-session-message>\nline three';

    const inbound = new Promise<InboundMessage>((resolve) => b.once("message", resolve));
    await a.send(b.socketPath, body);

    assert.equal((await inbound).body, body);
  });

  it("propagates a sender name override and the hop chain", async () => {
    const { a, b } = await pair();

    const inbound = new Promise<InboundMessage>((resolve) => b.once("message", resolve));
    await a.send(b.socketPath, "hi", { senderName: "orchestrator" });

    const message = await inbound;
    assert.equal(message.fromName, "orchestrator");
    assert.deepEqual(message.hopChain, [a.hopId]);
  });

  it("lets the peer reach back to the sender's socket", async () => {
    const { a, b } = await pair();

    const inbound = new Promise<InboundMessage>((resolve) => b.once("message", resolve));
    await a.send(b.socketPath, "ping");

    const message = await inbound;
    const reply = new Promise<InboundMessage>((resolve) => a.once("message", resolve));

    // b answers the address carried in the envelope, as a real session would.
    await b.send(message.envelope.from!, "pong");

    assert.equal((await reply).body, "pong");
  });

  it("rejects a target that is not a local absolute path", async () => {
    const { a } = await pair();
    await assert.rejects(a.send("https://example.com/x.sock", "nope"), /non-local IPC path/);
  });
});

describe("PeerDaemon inbound filtering", () => {
  it("ignores a frame whose content is not an envelope", async () => {
    const { a, b } = await pair();
    const seen: InboundMessage[] = [];
    b.on("message", (message) => seen.push(message));

    await rawSend(b.socketPath, {
      type: "user",
      msg_id: "garbage",
      message: { role: "user", content: "this is not an envelope" },
      from: a.address,
    });
    await delay(200);

    assert.deepEqual(seen, []);
  });

  it("ignores its own echo", async () => {
    const { b } = await pair();
    const seen: InboundMessage[] = [];
    b.on("message", (message) => seen.push(message));

    await rawSend(b.socketPath, {
      type: "user",
      msg_id: "echo",
      message: { role: "user", content: buildEnvelope({ from: b.address, body: "myself" }) },
      from: b.address,
    });
    await delay(200);

    assert.deepEqual(seen, []);
  });

  it("ignores a message that already passed through this session", async () => {
    const { a, b } = await pair();
    const seen: InboundMessage[] = [];
    b.on("message", (message) => seen.push(message));

    await rawSend(b.socketPath, {
      type: "user",
      msg_id: "loop",
      message: {
        role: "user",
        content: buildEnvelope({ from: a.address, hopChain: [b.hopId], body: "looped" }),
      },
      from: a.address,
    });
    await delay(200);

    assert.deepEqual(seen, []);
  });

  it("ignores a frame that is not a user or receipt frame", async () => {
    const { b } = await pair();
    const seen: InboundMessage[] = [];
    b.on("message", (message) => seen.push(message));

    await rawSend(b.socketPath, { type: "telemetry", payload: 1 });
    await delay(200);

    assert.deepEqual(seen, []);
  });
});

describe("PeerDaemon inbound policy", () => {
  it("accepts by default and reports delivery", async () => {
    const { a, b } = await pair();
    const received: InboundMessage[] = [];
    const receipts: ReceiptEvent[] = [];
    b.on("message", (message) => received.push(message));
    a.on("receipt", (receipt) => receipts.push(receipt));

    const { msgId } = await a.send(b.socketPath, "hello");

    assert.equal((await waitFor(() => received[0])).body, "hello");
    const receipt = await waitFor(() => receipts.find((r) => r.origMsgId === msgId));
    assert.equal(receipt.status, "delivered");
  });

  it("reports a refusal as denied, since the wire has no `refused`", async () => {
    const { a, b } = await pair({ b: { inbound: { policy: "refuse" } } });
    const received: InboundMessage[] = [];
    const receipts: ReceiptEvent[] = [];
    b.on("message", (message) => received.push(message));
    a.on("receipt", (receipt) => receipts.push(receipt));

    const { msgId } = await a.send(b.socketPath, "nope");

    const receipt = await waitFor(() => receipts.find((r) => r.origMsgId === msgId));
    assert.equal(receipt.status, "denied");

    await delay(50);
    assert.deepEqual(received, []);
  });

  it("holds a message, then delivers it once approved", async () => {
    const { a, b } = await pair({ b: { inbound: { policy: "hold" } } });
    const receipts: ReceiptEvent[] = [];
    const received: InboundMessage[] = [];
    a.on("receipt", (receipt) => receipts.push(receipt));
    b.on("message", (message) => received.push(message));

    const { msgId } = await a.send(b.socketPath, "please review this");

    const entry = await waitFor(() => b.held[0] as HeldMessage | undefined);
    assert.equal(entry.body, "please review this");
    assert.equal(entry.knownPeer, false); // separate config roots in this fixture

    await waitFor(() => receipts.find((r) => r.origMsgId === msgId && r.status === "held"));

    assert.equal(b.approve(entry.id), true);
    assert.equal((await waitFor(() => received[0])).body, "please review this");

    const final = await waitFor(() =>
      receipts.find((r) => r.origMsgId === msgId && r.status === "delivered"),
    );
    assert.equal(final.wasHeld, true);
  });

  it("tells the sender when a held message is denied", async () => {
    const { a, b } = await pair({ b: { inbound: { policy: "hold" } } });
    const receipts: ReceiptEvent[] = [];
    const received: InboundMessage[] = [];
    a.on("receipt", (receipt) => receipts.push(receipt));
    b.on("message", (message) => received.push(message));

    const { msgId } = await a.send(b.socketPath, "decline me");
    const entry = await waitFor(() => b.held[0] as HeldMessage | undefined);
    await waitFor(() => receipts.find((r) => r.origMsgId === msgId && r.status === "held"));

    assert.equal(b.deny(entry.id), true);

    await waitFor(() => receipts.find((r) => r.origMsgId === msgId && r.status === "denied"));
    assert.deepEqual(received, []);
    assert.equal(b.held.length, 0);
  });

  it("expires a held message that nobody reviews", async () => {
    const { a, b } = await pair({
      b: { inbound: { policy: "hold", expiryMs: 40 } },
    });
    const receipts: ReceiptEvent[] = [];
    a.on("receipt", (receipt) => receipts.push(receipt));

    const { msgId } = await a.send(b.socketPath, "forgotten");

    const held = await waitFor(() =>
      receipts.find((r) => r.origMsgId === msgId && r.status === "held"),
    );
    assert.equal(held.wasHeld, false);

    const expired = await waitFor(() =>
      receipts.find((r) => r.origMsgId === msgId && r.status === "expired"),
    );
    assert.equal(expired.wasHeld, true);
    assert.equal(b.held.length, 0);
  });

  it("evicts the oldest held message when the queue overflows", async () => {
    const { a, b } = await pair({
      b: { inbound: { policy: "hold", maxHeld: 2 } },
    });
    const receipts: ReceiptEvent[] = [];
    a.on("receipt", (receipt) => receipts.push(receipt));

    const first = await a.send(b.socketPath, "one");
    await waitFor(() => b.held[0] as HeldMessage | undefined);

    await a.send(b.socketPath, "two");
    await waitFor(() => (b.held.length === 2 ? true : undefined));

    await a.send(b.socketPath, "three");
    await waitFor(() => (b.held.length === 2 ? true : undefined));

    // The oldest was evicted and its sender told it expired.
    await waitFor(() =>
      receipts.find((r) => r.origMsgId === first.msgId && r.status === "expired"),
    );
    assert.deepEqual(
      b.held.map((entry) => entry.body),
      ["two", "three"],
    );
  });

  it("accepts a message carrying this session's own token", async () => {
    // A bypass posture would normally hold an unasserted message.
    const { b } = await pair({ b: { inbound: { permissionMode: "bypass" } } });
    const received: InboundMessage[] = [];
    b.on("message", (message) => received.push(message));

    await rawSend(b.socketPath, {
      type: "user",
      msg_id: "self",
      message: { role: "user", content: buildEnvelope({ from: "uds:/tmp/other.sock", body: "mine" }) },
      from: "uds:/tmp/other.sock",
      self_token: b.selfToken,
    });

    const message = await waitFor(() => received[0]);
    assert.equal(message.selfSent, true);
    assert.equal(message.cause, "self-sent");
  });

  it("refuses a posture-derived hold when there is nowhere to review it", async () => {
    const { a, b } = await pair({
      b: {
        inbound: { permissionMode: "prompting", modeEmit: true, reviewSurface: false },
      },
    });
    const receipts: ReceiptEvent[] = [];
    const received: InboundMessage[] = [];
    a.on("receipt", (receipt) => receipts.push(receipt));
    b.on("message", (message) => received.push(message));

    // `a` asserts a posture that does not match `b`'s own.
    const { msgId } = await a.send(b.socketPath, "mismatched", { fromMode: "bypass" });

    // Rather than park it in a queue nobody will ever review, the sender is
    // told immediately.
    const receipt = await waitFor(() => receipts.find((r) => r.origMsgId === msgId));
    assert.equal(receipt.status, "denied");
    assert.deepEqual(received, []);
    assert.equal(b.held.length, 0);
  });

  it("holds a message asserting a different posture when it can be reviewed", async () => {
    const { b } = await pair({
      b: { inbound: { permissionMode: "prompting", modeEmit: true, reviewSurface: true } },
    });
    const received: InboundMessage[] = [];
    b.on("message", (message) => received.push(message));

    await rawSend(b.socketPath, {
      type: "user",
      msg_id: "mismatch",
      message: {
        role: "user",
        content: buildEnvelope({ from: "uds:/tmp/other.sock", fromMode: "bypass", body: "hi" }),
      },
      from: "uds:/tmp/other.sock",
    });

    const entry = await waitFor(() => b.held[0] as HeldMessage | undefined);
    assert.equal(entry.cause, "mode-mismatch");
    assert.deepEqual(received, []);
  });

  it("expires anything still held when the session stops", async () => {
    const { a, b } = await pair({ b: { inbound: { policy: "hold" } } });
    const receipts: ReceiptEvent[] = [];
    a.on("receipt", (receipt) => receipts.push(receipt));

    const { msgId } = await a.send(b.socketPath, "still waiting");
    await waitFor(() => b.held[0] as HeldMessage | undefined);

    await b.stop();

    await waitFor(() =>
      receipts.find((r) => r.origMsgId === msgId && r.status === "expired"),
    );
  });
});

describe("PeerDaemon attachments", () => {
  it("copies an attachment into the receiving session", async () => {
    const root = await scratch();
    const { a, b } = await pair({ b: { attachmentsRoot: root } });

    const source = join(root, "notes.txt");
    await writeFile(source, "hello attachment");

    const received: InboundMessage[] = [];
    b.on("message", (message) => received.push(message));

    const { rejected } = await a.send(b.socketPath, "see attached", { files: [source] });
    assert.deepEqual(rejected, []);

    const message = await waitFor(() => received[0]);
    assert.equal(message.attachments.length, 1);

    const copied = message.attachments[0]!;
    assert.ok(copied.startsWith(join(root, "uploads", b.sessionId)));
    assert.match(copied, /peer-[0-9a-f]{8}-notes\.txt$/);
    assert.equal(await readFile(copied, "utf8"), "hello attachment");
    assert.equal((await stat(copied)).mode & 0o777, 0o600);

    // The receiver is handed the copy as a leading mention.
    assert.ok(message.body.startsWith(`@"${copied}" `));
    assert.ok(message.body.endsWith("see attached"));
  });

  it("reports an attachment it could not read", async () => {
    const { a, b } = await pair();
    const missing = join(await scratch(), "missing.txt");

    const { rejected } = await a.send(b.socketPath, "x", { files: [missing] });

    assert.equal(rejected.length, 1);
    assert.match(rejected[0]!, /unreadable/);
  });

  it("removes a copied attachment when the message is denied", async () => {
    const root = await scratch();
    const { a, b } = await pair({
      b: { attachmentsRoot: root, inbound: { policy: "hold" } },
    });

    const source = join(root, "report.txt");
    await writeFile(source, "confidential");

    await a.send(b.socketPath, "review this", { files: [source] });
    const entry = await waitFor(() => b.held[0] as HeldMessage | undefined);

    const copied = entry.attachmentPaths?.[0];
    assert.ok(copied !== undefined);
    assert.equal(existsSync(copied), true);

    assert.equal(b.deny(entry.id), true);
    await waitFor(() => (existsSync(copied) ? undefined : true));
  });
});

describe("PeerDaemon environment", () => {
  it("exports the bound socket path and drops it on stop", async () => {
    const dir = await scratch();
    const daemon = new PeerDaemon({ socketPath: join(dir, "env.sock"), configDir: dir });
    cleanups.push(() => daemon.stop());

    await daemon.start();
    assert.equal(process.env["QODER_MESSAGING_SOCKET"], daemon.socketPath);
    assert.equal(process.env["QODER_MESSAGING_SELF_TOKEN"], daemon.selfToken);

    await daemon.stop();
    assert.notEqual(process.env["QODER_MESSAGING_SOCKET"], daemon.socketPath);
  });

  it("mints its own token rather than inheriting one", async () => {
    const dir = await scratch();
    const previous = process.env["QODER_MESSAGING_SELF_TOKEN"];
    process.env["QODER_MESSAGING_SELF_TOKEN"] = "token-from-environment";

    try {
      // Inheriting would let a foreign session's message be judged self-sent,
      // which policy accepts without review.
      const daemon = new PeerDaemon({ socketPath: join(dir, "token.sock"), configDir: dir });
      assert.notEqual(daemon.selfToken, "token-from-environment");

      const explicit = new PeerDaemon({
        socketPath: join(dir, "explicit.sock"),
        configDir: dir,
        selfToken: "explicitly-supplied",
      });
      assert.equal(explicit.selfToken, "explicitly-supplied");
    } finally {
      if (previous === undefined) delete process.env["QODER_MESSAGING_SELF_TOKEN"];
      else process.env["QODER_MESSAGING_SELF_TOKEN"] = previous;
    }
  });
});
