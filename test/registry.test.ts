import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  SessionRecordWriter,
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

describe("SessionRecordWriter", () => {
  const socket = "/tmp/qoder-peer-writer.sock";

  it("writes the whole record on open and adopts it as the baseline", async () => {
    const dir = await scratch();
    const writer = new SessionRecordWriter({ configDir: dir });
    const initial = record({ name: "opened", messagingSocketPath: join(dir, "s.sock") });

    assert.equal(await writer.open(initial), true);
    assert.deepEqual(writer.record, initial);

    const parsed = await readSessionRecord(recordPath(process.pid, dir), process.pid);
    assert.equal(parsed?.name, "opened");
    assert.equal(parsed?.messagingSocketPath, initial.messagingSocketPath);
    assert.equal(parsed?.kind, "interactive");
    assert.equal(parsed?.peerProtocol, 1);
    assert.equal(writer.failures, 0);
  });

  it("holds a patch made before open, and flush with nothing pending is safe", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir, debounceMs: 10 });

    // No baseline yet, so a patch alone cannot produce a file.
    writer.patch({ status: "busy" });
    await writer.flush();
    assert.equal(existsSync(file), false);

    await writer.open(record({ name: "opened", messagingSocketPath: socket }));
    await writer.flush();

    // The patch survived and was applied once the record existed.
    const written = await snapshot(file);
    assert.equal(written.json.name, "opened");
    assert.equal(written.json.status, "busy");

    await writer.flush();
    const again = await snapshot(file);
    assert.equal(again.inode, written.inode, "flush must not touch a file with no pending patch");
    assert.equal(writer.failures, 0);
  });

  it("coalesces several patches into a single write", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir, debounceMs: 5_000 });
    await writer.open(record({ name: "opened", messagingSocketPath: socket }));
    const opened = await snapshot(file);

    writer.patch({ status: "busy" });
    writer.patch({ name: "renamed" });
    writer.patch({ sessionId: "22222222-2222-2222-2222-222222222222" });

    assert.equal(
      (await snapshot(file)).inode,
      opened.inode,
      "the debounce must hold the write back",
    );

    await writer.flush();
    const written = await snapshot(file);

    assert.notEqual(written.inode, opened.inode);
    assert.equal(written.json.status, "busy");
    assert.equal(written.json.name, "renamed");
    assert.equal(written.json.sessionId, "22222222-2222-2222-2222-222222222222");
    assert.equal(writer.failures, 0);
  });

  it("drops a patch that leaves the record unchanged", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir, debounceMs: 5_000 });
    await writer.open(record({ name: "opened", status: "idle", messagingSocketPath: socket }));
    const opened = await snapshot(file);

    writer.patch({ status: "idle" });
    writer.patch({ name: "opened" });
    await writer.flush();

    const same = await snapshot(file);
    assert.equal(same.inode, opened.inode, "a no-op patch must not rewrite the file");
    assert.deepEqual(same.json, opened.json);
    assert.equal(writer.failures, 0);
  });

  it("writes back the original values after a patch-and-revert round trip", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir, debounceMs: 5_000 });
    await writer.open(record({ name: "original", messagingSocketPath: socket }));
    const opened = await snapshot(file);

    writer.patch({ name: "changed" });
    await writer.flush();
    const changed = await snapshot(file);
    assert.notEqual(changed.inode, opened.inode);
    assert.equal(changed.json.name, "changed");

    writer.patch({ name: "original" });
    await writer.flush();
    const restored = await snapshot(file);

    assert.notEqual(restored.inode, changed.inode, "reverting is a change like any other");
    assert.deepEqual(restored.json, opened.json);
    assert.equal(writer.failures, 0);
  });

  it("caps the wait at maxWaitMs however fast patches keep arriving", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    let clock = 1_000_000;
    const writer = new SessionRecordWriter({
      configDir: dir,
      debounceMs: 10_000,
      maxWaitMs: 40,
      now: () => clock,
    });
    await writer.open(record({ status: "idle", messagingSocketPath: socket }));
    const opened = await snapshot(file);

    writer.patch({ status: "busy" });
    assert.equal((await snapshot(file)).inode, opened.inode, "the 10s debounce cannot have fired");

    const firstWaitStart = Date.now();
    assert.equal(
      await waitFor(async () => (await snapshot(file)).inode !== opened.inode, 5_000),
      true,
      "the max-wait bound must release the write",
    );
    assert.ok(Date.now() - firstWaitStart < 1_000, "the write must not wait out the debounce");
    assert.equal((await snapshot(file)).json.status, "busy");

    // Patches spaced closer together than the debounce must not push the write
    // out past the bound again: the clock is already at the cap.
    const settled = await snapshot(file);
    clock += 25;
    writer.patch({ status: "waiting" });
    clock += 25;
    writer.patch({ status: "shell" });
    clock += 25;
    writer.patch({ status: "waiting" });

    const secondWaitStart = Date.now();
    assert.equal(
      await waitFor(async () => (await snapshot(file)).inode !== settled.inode, 5_000),
      true,
      "a continuing burst must still be written out at the bound",
    );
    assert.ok(Date.now() - secondWaitStart < 1_000);
    assert.equal((await snapshot(file)).json.status, "waiting");
    assert.equal(writer.failures, 0);
  });

  it("keeps the identity fields from the baseline whatever the patch claims", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir, debounceMs: 5_000 });
    const initial = record({ name: "opened", status: "idle", messagingSocketPath: socket });
    await writer.open(initial);
    const opened = await snapshot(file);

    // Identity-only patches leave the record untouched, so they are dropped.
    writer.patch({ pid: 99_999, procStart: 0, startedAt: 0 });
    await writer.flush();
    const unchanged = await snapshot(file);
    assert.equal(unchanged.inode, opened.inode);
    assert.deepEqual(unchanged.json, opened.json);

    writer.patch({ pid: 99_999, procStart: 0, startedAt: 0, status: "busy" });
    await writer.flush();
    const written = await snapshot(file);

    assert.notEqual(written.inode, opened.inode);
    assert.equal(written.json.status, "busy");
    assert.equal(written.json.pid, initial.pid);
    assert.equal(written.json.procStart, initial.procStart);
    assert.equal(written.json.startedAt, initial.startedAt);
    assert.equal(writer.record?.pid, initial.pid);
  });

  it("lets a patch rename the session and change its id", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir, debounceMs: 5_000 });
    await writer.open(record({ name: "before", messagingSocketPath: socket }));

    writer.patch({ name: "after", sessionId: "33333333-3333-3333-3333-333333333333" });
    await writer.flush();
    const written = await snapshot(file);

    assert.equal(written.json.name, "after");
    assert.equal(written.json.sessionId, "33333333-3333-3333-3333-333333333333");
    assert.equal(writer.record?.name, "after");
  });

  it("removes the field from the JSON when a patch clears a name", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir, debounceMs: 5_000 });
    await writer.open(record({ name: "before", messagingSocketPath: socket }));

    writer.patch({ name: undefined });
    await writer.flush();
    const dropped = await snapshot(file);

    assert.equal("name" in dropped.json, false, "name: undefined must not survive as a key");
    assert.equal(dropped.json.sessionId, "11111111-1111-1111-1111-111111111111");
    assert.equal(writer.record?.name, undefined);
    assert.equal(writer.failures, 0);
  });

  it("close cancels the pending write and deletes the record", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir, debounceMs: 20 });
    await writer.open(record({ name: "opened", messagingSocketPath: socket }));

    writer.patch({ status: "busy" });
    await writer.close();

    assert.equal(existsSync(file), false);
    assert.equal(writer.record, undefined);

    // The cancelled patch must not resurrect the record once its timer would
    // have come due.
    await delay(80);
    assert.equal(existsSync(file), false);

    // And a late patch has no baseline left to merge into.
    writer.patch({ status: "busy" });
    await writer.flush();
    assert.equal(existsSync(file), false);
  });

  it("applies a patch issued before open has settled", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir, debounceMs: 20 });

    // There is no baseline until the open write completes, so a patch racing it
    // is held and applied afterwards rather than silently lost.
    const opening = writer.open(record({ status: "idle", messagingSocketPath: socket }));
    writer.patch({ status: "busy" });

    assert.equal(await opening, true);
    await writer.flush();

    assert.equal((await snapshot(file)).json.status, "busy");
  });

  it("close removes the record it wrote, not this process's own", async () => {
    const dir = await scratch();
    const pid = await deadPid();
    const file = recordPath(pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir });

    await writer.open(record({ pid, messagingSocketPath: socket }));
    assert.equal(existsSync(file), true);

    await writer.close();

    assert.equal(existsSync(file), false);
    assert.equal(existsSync(recordPath(process.pid, dir)), false);
  });

  it("close waits for an in-flight write before deleting the record", async () => {
    const dir = await scratch();
    const file = recordPath(process.pid, dir);
    const writer = new SessionRecordWriter({ configDir: dir, debounceMs: 20 });

    // close() runs while the open() write is still queued: it must not unlink
    // first and let the write's rename put the file back.
    const opening = writer.open(record({ name: "opened", messagingSocketPath: socket }));
    await writer.close();

    assert.equal(await opening, true);
    assert.equal(existsSync(file), false);
  });
});

// ---------------------------------------------------------------------------

/** One on-disk version of a record file; a rewrite swaps the inode via rename. */
async function snapshot(file: string): Promise<{ inode: number; json: Record<string, unknown> }> {
  const [stats, raw] = await Promise.all([stat(file), readFile(file, "utf8")]);
  return { inode: stats.ino, json: JSON.parse(raw) as Record<string, unknown> };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` until it holds or `timeoutMs` elapses. */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await delay(5);
  }
}

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
