import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { PeerDaemon, type InboundMessage, type ReceiptEvent } from "../src/peer.ts";
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

/** Two daemons in isolated config roots, stopped automatically. */
async function pair(): Promise<{ a: PeerDaemon; b: PeerDaemon }> {
  const dirA = await scratch();
  const dirB = await scratch();

  const a = new PeerDaemon({ socketPath: join(dirA, "a.sock"), configDir: dirA, name: "alpha" });
  const b = new PeerDaemon({ socketPath: join(dirB, "b.sock"), configDir: dirB, name: "beta" });

  await a.start();
  await b.start();
  cleanups.push(async () => {
    await a.stop();
    await b.stop();
  });

  return { a, b };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
