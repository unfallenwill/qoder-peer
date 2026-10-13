import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  listPeers,
  readAllSessions,
  readSessionRecord,
  recordPath,
  resolveTarget,
  sessionsDir,
  toPeer,
  writeSessionRecord,
  type SessionRecord,
} from "../src/registry.ts";

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qoder-peer-registry-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A pid that is certainly not running, obtained by reaping a child process. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid!;
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    pid: process.pid,
    procStart: 1,
    startedAt: Date.now(),
    cwd: "/tmp",
    sessionId: "11111111-1111-1111-1111-111111111111",
    name: "fixture",
    kind: "interactive",
    status: "idle",
    messagingSocketPath: "/tmp/qoder-peer-fixture.sock",
    peerProtocol: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("writeSessionRecord", () => {
  it("creates the directory 0700 and the record 0600", async () => {
    const dir = await scratch();
    const socket = join(dir, "s.sock");

    assert.equal(await writeSessionRecord(record({ messagingSocketPath: socket }), dir), true);

    assert.equal((await stat(sessionsDir(dir))).mode & 0o777, 0o700);
    assert.equal((await stat(recordPath(process.pid, dir))).mode & 0o777, 0o600);
  });
});

describe("readSessionRecord", () => {
  it("parses a well-formed record", async () => {
    const dir = await scratch();
    const socket = join(dir, "s.sock");
    await writeSessionRecord(record({ messagingSocketPath: socket, name: "parser" }), dir);

    const parsed = await readSessionRecord(recordPath(process.pid, dir), process.pid);

    assert.equal(parsed?.name, "parser");
    assert.equal(parsed?.messagingSocketPath, socket);
    assert.equal(parsed?.kind, "interactive");
    assert.equal(parsed?.peerProtocol, 1);
  });

  it("returns undefined for a missing file", async () => {
    const dir = await scratch();
    assert.equal(await readSessionRecord(join(dir, "nope.json"), 1), undefined);
  });

  it("returns undefined for malformed JSON", async () => {
    const dir = await scratch();
    const file = join(dir, "broken.json");
    await writeFile(file, "{ not json");

    assert.equal(await readSessionRecord(file, 1), undefined);
  });

  it("returns undefined when the payload is not an object", async () => {
    const dir = await scratch();
    const file = join(dir, "scalar.json");
    await writeFile(file, '"a string"');

    assert.equal(await readSessionRecord(file, 1), undefined);
  });

  it("blanks out a socket path that is not a local absolute path", async () => {
    const dir = await scratch();
    const file = join(dir, "remote.json");
    await writeFile(file, JSON.stringify(record({ messagingSocketPath: "https://x/y.sock" })));

    assert.equal((await readSessionRecord(file, 1))?.messagingSocketPath, "");
  });

  it("drops unknown enum values and non-finite timestamps", async () => {
    const dir = await scratch();
    const file = join(dir, "weird.json");
    await writeFile(
      file,
      JSON.stringify({
        ...record(),
        kind: "wizard",
        status: "sleeping",
        procStart: -1,
        peerProtocol: "1",
      }),
    );

    const parsed = await readSessionRecord(file, 1);

    assert.equal(parsed?.kind, undefined);
    assert.equal(parsed?.status, undefined);
    assert.equal(parsed?.procStart, 0);
    assert.equal(parsed?.peerProtocol, 0);
  });
});

describe("readAllSessions", () => {
  it("returns an empty list when the directory does not exist", async () => {
    const dir = await scratch();
    assert.deepEqual(await readAllSessions(dir), []);
  });

  it("removes files that are not named after a pid", async () => {
    const dir = await scratch();
    await mkdir(sessionsDir(dir), { recursive: true, mode: 0o700 });
    const junk = join(sessionsDir(dir), "not-a-pid.json");
    await writeFile(junk, "{}");

    assert.deepEqual(await readAllSessions(dir), []);
    assert.equal(existsSync(junk), false);
  });

  it("ignores non-JSON entries", async () => {
    const dir = await scratch();
    await mkdir(sessionsDir(dir), { recursive: true, mode: 0o700 });
    await writeFile(join(sessionsDir(dir), "1234.lock"), "");

    assert.deepEqual(await readAllSessions(dir), []);
  });
});

describe("listPeers", () => {
  it("reaps a record whose process is gone", async () => {
    const dir = await scratch();
    const pid = await deadPid();
    const file = recordPath(pid, dir);
    await writeSessionRecord(record({ pid, messagingSocketPath: join(dir, "dead.sock") }), dir);
    assert.equal(existsSync(file), true);

    assert.deepEqual(await listPeers(dir), []);
    assert.equal(existsSync(file), false);
  });

  it("reaps a record with a dead pid even when its socket path is unusable", async () => {
    const dir = await scratch();
    const pid = await deadPid();
    const file = recordPath(pid, dir);
    await writeSessionRecord(record({ pid, messagingSocketPath: "not-absolute" }), dir);

    assert.deepEqual(await listPeers(dir), []);
    assert.equal(existsSync(file), false);
  });

  it("skips the calling session", async () => {
    const dir = await scratch();
    await writeSessionRecord(record({ messagingSocketPath: join(dir, "self.sock") }), dir);

    assert.deepEqual(await listPeers(dir, process.pid), []);
  });

  it("returns a session whose socket accepts connections", async () => {
    const dir = await scratch();
    const socketPath = join(dir, "live.sock");
    const server = createServer();
    await listen(server, socketPath);
    cleanups.push(async () => closeServer(server));

    await writeSessionRecord(record({ messagingSocketPath: socketPath, name: "live" }), dir);

    const peers = await listPeers(dir, -1);

    assert.equal(peers.length, 1);
    assert.equal(peers[0]!.name, "live");
    assert.equal(peers[0]!.address, `uds:${socketPath}`);
    assert.equal(peers[0]!.handle.length, 2);
    assert.equal(peers[0]!.ref.length, 6);
  });

  it("skips a session whose socket is not listening", async () => {
    const dir = await scratch();
    await writeSessionRecord(record({ messagingSocketPath: join(dir, "absent.sock") }), dir);

    assert.deepEqual(await listPeers(dir, -1), []);
  });
});

describe("resolveTarget", () => {
  const peers = [
    toPeer("/x/a.json", record({ name: "alpha", messagingSocketPath: "/run/a.sock" })),
    toPeer("/x/b.json", record({ name: "beta", messagingSocketPath: "/run/b.sock" })),
    toPeer("/x/c.json", record({ name: "beta", messagingSocketPath: "/run/c.sock" })),
  ];

  it("resolves a handle, with or without the leading dash", () => {
    const handle = peers[0]!.handle;
    assert.equal(resolveTarget(`-${handle}`, peers).peer?.name, "alpha");
    assert.equal(resolveTarget(handle, peers).peer?.name, "alpha");
  });

  it("resolves a ref, alone or with a name", () => {
    assert.equal(resolveTarget(peers[1]!.ref, peers).peer?.name, "beta");
    assert.equal(resolveTarget(`beta [${peers[1]!.ref}]`, peers).peer?.name, "beta");
  });

  it("resolves a socket path and a uds address", () => {
    assert.equal(resolveTarget("/run/b.sock", peers).peer?.name, "beta");
    assert.equal(resolveTarget("uds:/run/b.sock", peers).peer?.name, "beta");
  });

  it("resolves a bare socket basename", () => {
    assert.equal(resolveTarget("b.sock", peers).peer?.name, "beta");
  });

  it("refuses to guess between duplicate names", () => {
    assert.throws(() => resolveTarget("beta", peers), /matches 2 sessions/);
  });

  it("reports a stale address rather than silently succeeding", () => {
    const resolved = resolveTarget("/run/gone.sock", peers);
    assert.equal(resolved.peer, undefined);
    assert.equal(resolved.stale, true);
    assert.equal(resolved.socketPath, "/run/gone.sock");
  });

  it("reports staleness for an unknown handle", () => {
    assert.equal(resolveTarget("-zz", peers).stale, true);
  });
});

// ---------------------------------------------------------------------------

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
