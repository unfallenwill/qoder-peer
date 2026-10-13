/**
 * The session registry: how Qoder sessions find each other.
 *
 * Every session binds a private Unix socket and drops a record at
 * `<configDir>/sessions/<pid>.json` describing itself. Peers read that
 * directory, probe each socket, and discard records whose process is gone.
 *
 * Both the directory and the records are owner-only (0700 / 0600).
 */

import { connect } from "node:net";
import { statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  SESSIONS_DIR_NAME,
  SOCKET_DIR_NAME,
  addressFromSocketPath,
  handleForSocketPath,
  isLocalSocketPath,
  refForSocketPath,
  socketPathFromAddress,
  socketPathLimit,
} from "./protocol.ts";

export const SESSION_KINDS = ["interactive", "bg", "daemon", "daemon-worker"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const SESSION_STATUSES = ["busy", "shell", "idle", "waiting"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionRecord {
  pid: number;
  procStart: number;
  startedAt: number;
  cwd: string;
  sessionId?: string;
  name?: string;
  kind?: SessionKind;
  status?: SessionStatus;
  messagingSocketPath: string;
  peerProtocol: number;
}

/** A session record enriched with the identifiers used to address it. */
export interface Peer extends SessionRecord {
  /** `uds:` address a peer can reply to. */
  address: string;
  /** Two hex characters, stable for the life of the session. */
  handle: string;
  /** Six hex characters, shown in listings. */
  ref: string;
  /** File the record was read from, used to reap dead sessions. */
  file: string;
}

const MAX_TIMESTAMP = 4_000_000_000_000_000;
const PROBE_TIMEOUT_MS = 250;
const MAX_PATH_FIELD = 512;
const MAX_NAME_FIELD = 120;

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/**
 * Root of the user-level config tree. Qoder honours `QODER_CONFIG_DIR` and
 * defaults to `~/.qoder`.
 */
export function globalConfigDir(): string {
  const override = process.env.QODER_CONFIG_DIR?.trim();
  return override && override.length > 0 ? override : join(homedir(), ".qoder");
}

export function sessionsDir(configDir: string = globalConfigDir()): string {
  return join(configDir, SESSIONS_DIR_NAME);
}

export function recordPath(pid: number, configDir: string = globalConfigDir()): string {
  return join(sessionsDir(configDir), `${pid}.json`);
}

export function uid(): number {
  return process.getuid?.() ?? 0;
}

/**
 * Default socket path, matching the CLI:
 * `$XDG_RUNTIME_DIR/qoder-socks/<pid>.sock`, falling back under `/tmp` when the
 * runtime directory is owned by someone else or the path would overflow
 * `sun_path`.
 */
export function defaultSocketPath(pid: number = process.pid): string {
  const base = process.env.XDG_RUNTIME_DIR || "/tmp";
  const preferred = join(base, SOCKET_DIR_NAME);
  const dir = isOwnedByUs(preferred)
    ? preferred
    : join(base, `${SOCKET_DIR_NAME}-${uid()}`);

  const candidate = join(dir, `${pid}.sock`);
  if (Buffer.byteLength(candidate) <= socketPathLimit) return candidate;

  return join("/tmp", `${SOCKET_DIR_NAME}-${uid()}`, `${pid}.sock`);
}

/** A missing path counts as ours, since we are about to create it. */
function isOwnedByUs(path: string): boolean {
  try {
    return statSync(path).uid === uid();
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/** True when `pid` exists and is signalable by us. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Liveness probe taken from the CLI: a bare `connect()` that resolves on
 * success and gives up after `timeoutMs`.
 */
export function probeSocket(
  socketPath: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isLocalSocketPath(socketPath)) {
      resolve(false);
      return;
    }

    const socket = connect({ path: socketPath });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.on("connect", () => finish(true));
    socket.on("error", (error: NodeJS.ErrnoException) => finish(error?.code === "EBUSY"));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function asTimestamp(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_TIMESTAMP
    ? value
    : undefined;
}

function asString(value: unknown, max: number = MAX_PATH_FIELD): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : undefined;
}

/** Read one `sessions/<pid>.json`, tolerating partial or malformed records. */
export async function readSessionRecord(
  file: string,
  pid: number,
): Promise<SessionRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    parsed = value as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const socketPath = asString(parsed.messagingSocketPath) ?? "";
  const sessionId = asString(parsed.sessionId, MAX_NAME_FIELD);
  const name = asString(parsed.name, MAX_NAME_FIELD);
  const kind = oneOf(parsed.kind, SESSION_KINDS);
  const status = oneOf(parsed.status, SESSION_STATUSES);

  return {
    pid,
    procStart: asTimestamp(parsed.procStart) ?? 0,
    startedAt: asTimestamp(parsed.startedAt) ?? 0,
    cwd: asString(parsed.cwd) ?? "?",
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(status !== undefined ? { status } : {}),
    messagingSocketPath: isLocalSocketPath(socketPath) ? socketPath : "",
    peerProtocol: typeof parsed.peerProtocol === "number" ? parsed.peerProtocol : 0,
  };
}

/**
 * Enumerate every record in the sessions directory. Files whose name is not a
 * pid are removed, matching the CLI's self-cleaning behaviour.
 */
export async function readAllSessions(
  configDir: string = globalConfigDir(),
): Promise<Array<{ file: string; record: SessionRecord }>> {
  const dir = sessionsDir(configDir);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const file = join(dir, name);
        const stem = basename(name, ".json");
        const pid = Number.parseInt(stem, 10);

        if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== stem) {
          await unlink(file).catch(() => {});
          return undefined;
        }

        const record = await readSessionRecord(file, pid);
        return record ? { file, record } : undefined;
      }),
  );

  return results.filter(
    (entry): entry is { file: string; record: SessionRecord } => entry !== undefined,
  );
}

export function toPeer(file: string, record: SessionRecord): Peer {
  return {
    ...record,
    file,
    address: addressFromSocketPath(record.messagingSocketPath),
    handle: handleForSocketPath(record.messagingSocketPath),
    ref: refForSocketPath(record.messagingSocketPath),
  };
}

/**
 * Live peers: registered sessions other than `selfPid` whose socket still
 * accepts a connection. Records whose process has exited are reaped.
 */
export async function listPeers(
  configDir: string = globalConfigDir(),
  selfPid: number = process.pid,
): Promise<Peer[]> {
  const sessions = await readAllSessions(configDir);
  const candidates: Array<{ file: string; record: SessionRecord }> = [];

  for (const entry of sessions) {
    if (entry.record.pid === selfPid) continue;

    // Reap on the pid alone, so records with a missing or malformed socket
    // path cannot linger forever.
    if (!isProcessAlive(entry.record.pid)) {
      await unlink(entry.file).catch(() => {});
      continue;
    }

    if (entry.record.messagingSocketPath === "") continue;
    candidates.push(entry);
  }

  const alive = await Promise.all(
    candidates.map((entry) => probeSocket(entry.record.messagingSocketPath)),
  );

  return candidates
    .filter((_, index) => alive[index])
    .map((entry) => toPeer(entry.file, entry.record))
    .sort((a, b) => b.startedAt - a.startedAt || a.pid - b.pid);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Write a record atomically: temp file at 0600, then rename into place. */
export async function writeSessionRecord(
  record: SessionRecord,
  configDir: string = globalConfigDir(),
): Promise<boolean> {
  const dir = sessionsDir(configDir);
  const finalPath = recordPath(record.pid, configDir);
  const tempPath = `${finalPath}.${process.pid}.tmp`;

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(tempPath, JSON.stringify(record), { mode: 0o600 });
    await rename(tempPath, finalPath);
    return true;
  } catch {
    await unlink(tempPath).catch(() => {});
    return false;
  }
}

export async function removeSessionRecord(
  pid: number = process.pid,
  configDir: string = globalConfigDir(),
): Promise<void> {
  await unlink(recordPath(pid, configDir)).catch(() => {});
}

/** Process start time, derived the same way the CLI does. */
export function processStartTime(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

export interface ResolvedTarget {
  peer?: Peer;
  /** Set when the target parses as a path but no live session matches it. */
  stale: boolean;
  /** The path that was requested, when it did not resolve to a live peer. */
  socketPath?: string;
}

/**
 * Resolve a user-supplied target to a peer. Accepts, in order of specificity:
 * a raw socket path, a `uds:` address, a 2-hex handle, a `name [ref]` pair, a
 * display name, or a bare socket basename.
 */
export function resolveTarget(target: string, peers: Peer[]): ResolvedTarget {
  const trimmed = target.trim();
  if (!trimmed) return { stale: true };

  const asPath = socketPathFromAddress(trimmed) ?? (trimmed.startsWith("/") ? trimmed : undefined);
  if (asPath) {
    const match = peers.find((peer) => peer.messagingSocketPath === asPath);
    return match ? { peer: match, stale: false } : { socketPath: asPath, stale: true };
  }

  const handleMatch = /^-?([0-9a-f]{2})$/.exec(trimmed);
  if (handleMatch) {
    const handle = handleMatch[1]!;
    const match = peers.find((peer) => peer.handle === handle);
    return match ? { peer: match, stale: false } : { stale: true };
  }

  const refMatch = /^(.*?)\s*\[([0-9a-f]{6})\]$/.exec(trimmed);
  if (refMatch) {
    const ref = refMatch[2]!;
    const match = peers.find((peer) => peer.ref === ref);
    return match ? { peer: match, stale: false } : { stale: true };
  }

  const byName = peers.filter((peer) => (peer.name ?? "") === trimmed);
  if (byName.length === 1) return { peer: byName[0]!, stale: false };
  if (byName.length > 1) {
    // Ambiguous names are disambiguated by ref, same as the CLI.
    throw new Error(
      `Target "${trimmed}" matches ${byName.length} sessions. ` +
        `Use one of: ${byName.map((peer) => `${peer.name} [${peer.ref}]`).join(", ")}`,
    );
  }

  const basenameMatches = peers.filter(
    (peer) => basename(peer.messagingSocketPath) === trimmed,
  );
  if (basenameMatches.length === 1) return { peer: basenameMatches[0]!, stale: false };

  // A bare ref, tried last so that names and basenames always take precedence.
  if (/^[0-9a-f]{6}$/.test(trimmed)) {
    const match = peers.find((peer) => peer.ref === trimmed);
    if (match) return { peer: match, stale: false };
  }

  return { stale: true };
}
