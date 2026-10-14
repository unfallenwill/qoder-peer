import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  applyAttachments,
  discardAttachments,
  receiveAttachments,
  uploadsDir,
  validateOutbound,
} from "../src/attachments.ts";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../src/protocol.ts";

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qoder-peer-attachments-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a file with known contents and return its absolute path. */
async function fixture(dir: string, name: string, contents = "hello"): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, contents);
  return file;
}

/**
 * A file whose reported size is `size` bytes without writing that many. Works
 * on sparse-capable filesystems, so a 50 MiB ceiling test stays cheap.
 */
async function sparseFile(dir: string, name: string, size: number): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, "");
  await truncate(file, size);
  return file;
}

/** The name a copy was stored under, with the `peer-<hex>-` prefix removed. */
function storedName(copied: string): string {
  return basename(copied).slice("peer-".length + 8 + 1);
}

/** Run `body` with `$QODER_HOME` set to `value` (or removed when undefined). */
function withQoderHome(value: string | undefined, body: () => void): void {
  const previous = process.env.QODER_HOME;
  if (value === undefined) delete process.env.QODER_HOME;
  else process.env.QODER_HOME = value;

  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.QODER_HOME;
    else process.env.QODER_HOME = previous;
  }
}

// ---------------------------------------------------------------------------

describe("uploadsDir", () => {
  it("joins the given root, `uploads` and the session id", () => {
    assert.equal(uploadsDir("session-1", "/srv/qoder"), "/srv/qoder/uploads/session-1");
  });

  it("honours $QODER_HOME when no root is given", () => {
    withQoderHome("/srv/custom", () => {
      assert.equal(uploadsDir("session-1"), "/srv/custom/uploads/session-1");
    });
  });

  it("falls back to ~/.qoder-cli", () => {
    withQoderHome(undefined, () => {
      assert.equal(uploadsDir("session-1"), join(homedir(), ".qoder-cli", "uploads", "session-1"));
    });
  });
});

describe("validateOutbound", () => {
  it("accepts a regular file and reports its basename and size", async () => {
    const dir = await scratch();
    const file = await fixture(dir, "notes.txt", "hello");

    const result = await validateOutbound([file]);

    assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.files, [{ path: file, name: "notes.txt", bytes: 5 }]);
  });

  it("rejects a relative path", async () => {
    const result = await validateOutbound(["notes.txt"]);

    assert.deepEqual(result.files, []);
    assert.deepEqual(result.rejected, ["notes.txt (not an absolute path)"]);
  });

  it("rejects a directory", async () => {
    const dir = await scratch();
    const sub = join(dir, "sub");
    await mkdir(sub);

    const result = await validateOutbound([sub]);

    assert.deepEqual(result.files, []);
    assert.deepEqual(result.rejected, [`${sub} (not a regular file)`]);
  });

  it("rejects a path that cannot be read", async () => {
    const dir = await scratch();
    const missing = join(dir, "missing.txt");

    const result = await validateOutbound([missing]);

    assert.deepEqual(result.files, []);
    assert.deepEqual(result.rejected, [`${missing} (unreadable)`]);
  });

  it("rejects a file above the per-file ceiling", async () => {
    const dir = await scratch();
    const big = await sparseFile(dir, "big.bin", MAX_ATTACHMENT_BYTES + 1);

    const result = await validateOutbound([big]);

    assert.deepEqual(result.files, []);
    assert.deepEqual(result.rejected, [`${big} (exceeds ${MAX_ATTACHMENT_BYTES} bytes)`]);
  });

  it("keeps at most the limit and reports the surplus once", async () => {
    const dir = await scratch();
    const paths = await Promise.all(
      Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, index) => fixture(dir, `f${index}.txt`)),
    );

    const result = await validateOutbound(paths);

    assert.equal(result.files.length, MAX_ATTACHMENTS);
    assert.equal(result.files[MAX_ATTACHMENTS - 1]!.name, `f${MAX_ATTACHMENTS - 1}.txt`);
    assert.deepEqual(result.rejected, ["2 file(s) beyond the limit"]);
  });

  it("reports accepted and rejected entries together", async () => {
    const dir = await scratch();
    const good = await fixture(dir, "good.txt");

    const result = await validateOutbound([good, "relative.txt"]);

    assert.equal(result.files.length, 1);
    assert.deepEqual(result.rejected, ["relative.txt (not an absolute path)"]);
  });
});

describe("receiveAttachments", () => {
  it("copies the file into the per-session uploads directory", async () => {
    const root = await scratch();
    const src = await scratch();
    const file = await fixture(src, "report.txt", "contents");
    const dir = uploadsDir("session-a", root);

    const result = await receiveAttachments(
      [{ path: file, name: "report.txt", bytes: 8 }],
      "session-a",
      root,
    );

    assert.equal(result.received, 1);
    assert.deepEqual(result.rejected, []);
    assert.equal(result.paths.length, 1);

    const copied = result.paths[0]!;
    assert.equal(dirname(copied), dir);
    assert.match(basename(copied), /^peer-[0-9a-f]{8}-report\.txt$/);
    assert.equal(await readFile(copied, "utf8"), "contents");
  });

  it("makes the directory 0700 and the copy 0600", async () => {
    const root = await scratch();
    const src = await scratch();
    const file = await fixture(src, "secret.txt");

    const result = await receiveAttachments(
      [{ path: file, name: "secret.txt", bytes: 5 }],
      "session-a",
      root,
    );

    assert.equal((await stat(uploadsDir("session-a", root))).mode & 0o777, 0o700);
    assert.equal((await stat(result.paths[0]!)).mode & 0o777, 0o600);
  });

  it("gives each copy a distinct name", async () => {
    const root = await scratch();
    const src = await scratch();
    const first = await fixture(src, "a.txt");
    const second = await fixture(src, "b.txt");

    const result = await receiveAttachments(
      [
        { path: first, name: "a.txt", bytes: 5 },
        { path: second, name: "b.txt", bytes: 5 },
      ],
      "session-a",
      root,
    );

    assert.equal(result.received, 2);
    assert.notEqual(result.paths[0], result.paths[1]);
    assert.equal(storedName(result.paths[0]!), "a.txt");
    assert.equal(storedName(result.paths[1]!), "b.txt");
  });

  it("drops malformed entries without reporting them", async () => {
    const root = await scratch();

    const result = await receiveAttachments(
      [
        null,
        42,
        "path",
        {},
        { path: "/tmp/x" },
        { path: 1, name: "a", bytes: 1 },
        { path: "/tmp/x", name: 1, bytes: 1 },
        { path: "/tmp/x", name: "a", bytes: "1" },
        { path: "", name: "a", bytes: 1 },
      ],
      "session-a",
      root,
    );

    assert.deepEqual(result, { received: 0, paths: [], rejected: [] });
    assert.equal(existsSync(uploadsDir("session-a", root)), false);
  });

  it("treats a non-array payload as no attachments", async () => {
    const root = await scratch();

    for (const value of [undefined, null, "nope", 7, {}, true]) {
      assert.deepEqual(await receiveAttachments(value, "session-a", root), {
        received: 0,
        paths: [],
        rejected: [],
      });
    }

    assert.equal(existsSync(uploadsDir("session-a", root)), false);
  });

  it("rejects a relative source path", async () => {
    const root = await scratch();

    const result = await receiveAttachments(
      [{ path: "relative.txt", name: "relative.txt", bytes: 1 }],
      "session-a",
      root,
    );

    assert.equal(result.received, 0);
    assert.deepEqual(result.rejected, ["relative.txt"]);
  });

  it("rejects a source path containing NUL", async () => {
    const root = await scratch();

    const result = await receiveAttachments(
      [{ path: "/tmp/a\u0000b", name: "evil.txt", bytes: 1 }],
      "session-a",
      root,
    );

    assert.equal(result.received, 0);
    assert.deepEqual(result.rejected, ["evil.txt"]);
  });

  it("rejects a source that is not a regular file", async () => {
    const root = await scratch();
    const src = await scratch();
    const sub = join(src, "directory");
    await mkdir(sub);

    const result = await receiveAttachments(
      [{ path: sub, name: "directory", bytes: 0 }],
      "session-a",
      root,
    );

    assert.equal(result.received, 0);
    assert.deepEqual(result.rejected, ["directory"]);
  });

  it("re-checks the size rather than trusting the sender", async () => {
    const root = await scratch();
    const src = await scratch();
    const big = await sparseFile(src, "big.bin", MAX_ATTACHMENT_BYTES + 1);

    const result = await receiveAttachments(
      [{ path: big, name: "big.bin", bytes: 1 }],
      "session-a",
      root,
    );

    assert.equal(result.received, 0);
    assert.deepEqual(result.rejected, ["big.bin"]);
  });

  it("keeps only the basename and replaces unsafe characters", async () => {
    const root = await scratch();
    const src = await scratch();
    const file = await fixture(src, "payload", "x");
    const dir = uploadsDir("session-a", root);

    const result = await receiveAttachments(
      [{ path: file, name: "../../evil name?.sh", bytes: 1 }],
      "session-a",
      root,
    );

    const copied = result.paths[0]!;
    assert.equal(dirname(copied), dir);
    assert.equal(storedName(copied), "evil_name_.sh");
    assert.equal(existsSync(copied), true);
  });

  it("truncates an over-long name to 64 characters", async () => {
    const root = await scratch();
    const src = await scratch();
    const file = await fixture(src, "payload", "x");

    const result = await receiveAttachments(
      [{ path: file, name: `${"a".repeat(80)}.txt`, bytes: 1 }],
      "session-a",
      root,
    );

    assert.equal(storedName(result.paths[0]!), "a".repeat(64));
  });

  it("falls back to `attachment` when the name has nothing usable", async () => {
    const root = await scratch();
    const src = await scratch();
    const file = await fixture(src, "payload", "x");

    const result = await receiveAttachments(
      [{ path: file, name: "", bytes: 1 }],
      "session-a",
      root,
    );

    assert.equal(storedName(result.paths[0]!), "attachment");
  });

  it("sanitises and caps the name shown for a rejected entry", async () => {
    const root = await scratch();

    const invisible = await receiveAttachments(
      [{ path: "relative.txt", name: "​\u0000   ", bytes: 1 }],
      "session-a",
      root,
    );
    assert.deepEqual(invisible.rejected, ["attachment"]);

    const long = await receiveAttachments(
      [{ path: "relative.txt", name: "n".repeat(100), bytes: 1 }],
      "session-a",
      root,
    );
    assert.deepEqual(long.rejected, ["n".repeat(64)]);
  });

  it("accepts at most the limit, silently ignoring the rest", async () => {
    const root = await scratch();
    const src = await scratch();
    const file = await fixture(src, "a.txt");
    const entries = Array.from({ length: MAX_ATTACHMENTS + 2 }, () => ({
      path: file,
      name: "a.txt",
      bytes: 5,
    }));

    const result = await receiveAttachments(entries, "session-a", root);

    assert.equal(result.received, MAX_ATTACHMENTS);
    assert.deepEqual(result.rejected, []);
  });
});

describe("applyAttachments", () => {
  it("leaves the body untouched when nothing happened", () => {
    assert.equal(
      applyAttachments("hello", { received: 0, paths: [], rejected: [] }),
      "hello",
    );
  });

  it("prefixes copies as quoted absolute-path mentions", () => {
    assert.equal(
      applyAttachments("hello", {
        received: 2,
        paths: ["/a/peer-1-x.txt", "/a/peer-2-y.txt"],
        rejected: [],
      }),
      '@"/a/peer-1-x.txt" @"/a/peer-2-y.txt" hello',
    );
  });

  it("appends a notice listing rejected attachments", () => {
    assert.equal(
      applyAttachments("hello", { received: 0, paths: [], rejected: ["a.txt", "b.txt"] }),
      "hello\n[Attachments not delivered: a.txt, b.txt]",
    );
  });

  it("does both when some copies and some rejections happened", () => {
    assert.equal(
      applyAttachments("hello", { received: 1, paths: ["/a/peer-1-x.txt"], rejected: ["b.txt"] }),
      '@"/a/peer-1-x.txt" hello\n[Attachments not delivered: b.txt]',
    );
  });
});

describe("discardAttachments", () => {
  it("removes direct children of the session directory and counts them", async () => {
    const root = await scratch();
    const src = await scratch();
    const first = await fixture(src, "a.txt");
    const second = await fixture(src, "b.txt");

    const received = await receiveAttachments(
      [
        { path: first, name: "a.txt", bytes: 5 },
        { path: second, name: "b.txt", bytes: 5 },
      ],
      "session-a",
      root,
    );

    assert.equal(await discardAttachments(received.paths, "session-a", root), 2);
    assert.equal(existsSync(received.paths[0]!), false);
    assert.equal(existsSync(received.paths[1]!), false);
  });

  it("returns zero for an empty list", async () => {
    const root = await scratch();
    assert.equal(await discardAttachments([], "session-a", root), 0);
  });

  it("refuses paths outside the session directory", async () => {
    const root = await scratch();
    const src = await scratch();
    const outside = await fixture(src, "outside.txt");

    const received = await receiveAttachments(
      [{ path: outside, name: "outside.txt", bytes: 5 }],
      "session-a",
      root,
    );
    const copied = received.paths[0]!;

    // One file beside the uploads directory, one nested a level below it.
    const nested = join(uploadsDir("session-a", root), "nested");
    await mkdir(nested);
    const deep = await fixture(nested, "deep.txt");

    assert.equal(await discardAttachments([outside, deep], "session-a", root), 0);
    assert.equal(existsSync(outside), true);
    assert.equal(existsSync(deep), true);
    assert.equal(existsSync(copied), true);
  });

  it("will not touch another session's uploads", async () => {
    const root = await scratch();
    const src = await scratch();
    const file = await fixture(src, "a.txt");

    const other = await receiveAttachments(
      [{ path: file, name: "a.txt", bytes: 5 }],
      "session-b",
      root,
    );

    assert.equal(await discardAttachments(other.paths, "session-a", root), 0);
    assert.equal(existsSync(other.paths[0]!), true);
  });
});
