/**
 * File attachments for cross-session messages.
 *
 * A message may carry up to {@link MAX_ATTACHMENTS} files. The sender validates
 * each candidate path and advertises the survivors as `file_attachments`; the
 * receiver treats that list as untrusted, copies whatever passes inspection
 * into a private per-session directory, and rewrites the body so its agent sees
 * the local copies as `@"<absolute path>"` mentions.
 *
 * Copies land in `<root>/uploads/<sessionId>/`, where `root` is `$QODER_HOME`
 * or `~/.qoder-cli`. The directory is owner-only (0700) and so is every file
 * inside it (0600), because a peer's payload may be sensitive.
 */

import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  mentionPaths,
  type FileAttachment,
} from "./protocol.ts";

export interface OutboundAttachments {
  files: FileAttachment[];
  /** Human-readable rejection reasons, shaped like `"<path> (not an absolute path)"`. */
  rejected: string[];
}

export interface InboundAttachments {
  received: number;
  /** Absolute paths the copies were written to. */
  paths: string[];
  /** Sanitised file names (not paths) that were refused. */
  rejected: string[];
}

/** Subdirectory of the Qoder home that holds per-session uploads. */
const UPLOADS_DIR_NAME = "uploads";

/** Owner-only, for both the directory and the files it holds. */
const UPLOADS_DIR_MODE = 0o700;
const COPIED_FILE_MODE = 0o600;

/** Prefix on every stored copy, so uploads are recognisable on sight. */
const COPIED_FILE_PREFIX = "peer-";

/** Random hex characters inserted into a stored name to keep copies distinct. */
const RANDOM_HEX = 8;

/** Longest file name kept, matching the reference implementation. */
const NAME_MAX = 64;

/** Name used when the peer sent something with no usable characters. */
const FALLBACK_NAME = "attachment";

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** Root of the user-level Qoder tree: `$QODER_HOME` or `~/.qoder-cli`. */
function qoderHome(): string {
  return process.env.QODER_HOME ?? join(homedir(), ".qoder-cli");
}

/** Attachment directory: `<root>/uploads/<sessionId>`. */
export function uploadsDir(sessionId: string, root: string = qoderHome()): string {
  return join(root, UPLOADS_DIR_NAME, sessionId).replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Vet the files a caller wants to attach. Only the first
 * {@link MAX_ATTACHMENTS} paths are inspected; the surplus is reported as a
 * single rejection rather than silently dropped.
 */
export async function validateOutbound(
  files: readonly string[],
): Promise<OutboundAttachments> {
  const accepted: FileAttachment[] = [];
  const rejected: string[] = [];

  for (const candidate of files.slice(0, MAX_ATTACHMENTS)) {
    if (!isAbsolute(candidate)) {
      rejected.push(`${candidate} (not an absolute path)`);
      continue;
    }

    try {
      const info = await stat(candidate);
      if (!info.isFile()) {
        rejected.push(`${candidate} (not a regular file)`);
        continue;
      }
      if (info.size > MAX_ATTACHMENT_BYTES) {
        rejected.push(`${candidate} (exceeds ${MAX_ATTACHMENT_BYTES} bytes)`);
        continue;
      }
      accepted.push({ path: candidate, name: basename(candidate), bytes: info.size });
    } catch {
      rejected.push(`${candidate} (unreadable)`);
    }
  }

  if (files.length > MAX_ATTACHMENTS) {
    rejected.push(`${files.length - MAX_ATTACHMENTS} file(s) beyond the limit`);
  }

  return { files: accepted, rejected };
}

/** Header injected ahead of a body by {@link applyAttachments}. */
const NOT_DELIVERED_PREFIX = "\n[Attachments not delivered: ";

/**
 * Render the outcome of {@link receiveAttachments} onto a body: copied files
 * become leading `@"<abs>"` mentions, refused ones a trailing notice. An
 * outcome with nothing to say leaves the body byte-for-byte unchanged.
 */
export function applyAttachments(body: string, result: InboundAttachments): string {
  if (result.received === 0 && result.rejected.length === 0) return body;

  const mentions = mentionPaths(result.paths);
  const notice =
    result.rejected.length > 0
      ? `${NOT_DELIVERED_PREFIX}${result.rejected.join(", ")}]`
      : "";

  return mentions ? `${mentions} ${body}${notice}` : `${body}${notice}`;
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

/**
 * Shape check for `file_attachments` entries. Anything that is not an object
 * with a non-empty string `path`, a string `name` and a numeric `bytes` is
 * discarded before it can reach the filesystem.
 */
function isAttachmentShaped(value: unknown): value is FileAttachment {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    typeof entry.name === "string" &&
    typeof entry.bytes === "number"
  );
}

/** A source we are willing to copy: absolute, and free of NUL. */
function isSafeSourcePath(value: string): boolean {
  return isAbsolute(value) && !value.includes("\0");
}

/** Characters that can never appear in a stored file name. */
const UNSAFE_NAME_RE = /[^A-Za-z0-9._-]/g;

/** Control and format characters, which could smuggle invisible text. */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/gu;

/**
 * Reduce a peer-supplied name to something safe to create on disk: its
 * basename, with every character outside `[A-Za-z0-9._-]` replaced, and capped
 * at {@link NAME_MAX} characters.
 */
function sanitizeFileName(name: string): string {
  const cleaned = basename(name).replace(UNSAFE_NAME_RE, "_").slice(0, NAME_MAX);
  return cleaned || FALLBACK_NAME;
}

/**
 * Name shown for a rejected entry. This is for a human to read, never for a
 * path lookup, so it is only stripped of invisible characters and trimmed.
 */
function displayName(name: string): string {
  const cleaned = name.replace(INVISIBLE_RE, "").trim().slice(0, NAME_MAX);
  return cleaned || FALLBACK_NAME;
}

/**
 * Land the attachments of an inbound message.
 *
 * `files` arrives from the network and is `unknown` on purpose: it is filtered
 * structurally, then every path is re-validated on this machine — the sender's
 * claims about size and type are not trusted. Each accepted file is copied into
 * the session's uploads directory under a fresh, non-colliding name, and its
 * mode is forced to 0600 (a `chmod` failure is ignored; the copy itself is not
 * swallowed).
 */
export async function receiveAttachments(
  files: unknown,
  sessionId: string,
  root?: string,
): Promise<InboundAttachments> {
  const result: InboundAttachments = { received: 0, paths: [], rejected: [] };

  const candidates = (Array.isArray(files) ? files : [])
    .filter(isAttachmentShaped)
    .slice(0, MAX_ATTACHMENTS);

  // Nothing usable: do not even create the directory.
  if (candidates.length === 0) return result;

  const dir = uploadsDir(sessionId, root);
  try {
    await mkdir(dir, { recursive: true, mode: UPLOADS_DIR_MODE });
  } catch {
    return result;
  }

  for (const attachment of candidates) {
    if (!isSafeSourcePath(attachment.path)) {
      result.rejected.push(displayName(attachment.name));
      continue;
    }

    // Each entry is isolated: a source that vanished, is unreadable, or is
    // otherwise unusable must reject only itself. The sender controls these
    // paths, so one bad entry could otherwise deny every other attachment --
    // and would orphan whatever had already been copied.
    let target: string | undefined;
    try {
      const info = await stat(attachment.path);
      if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) {
        result.rejected.push(displayName(attachment.name));
        continue;
      }

      const tag = randomBytes(RANDOM_HEX / 2).toString("hex");
      target = join(dir, `${COPIED_FILE_PREFIX}${tag}-${sanitizeFileName(attachment.name)}`);

      await copyFile(attachment.path, target);
      await chmod(target, COPIED_FILE_MODE).catch(() => {});
    } catch {
      if (target !== undefined) await unlink(target).catch(() => {});
      result.rejected.push(displayName(attachment.name));
      continue;
    }

    result.paths.push(target);
    result.received += 1;
  }

  return result;
}

/**
 * Delete copies made by {@link receiveAttachments}, returning how many went
 * away. Only direct children of the session directory are eligible, so a
 * caller cannot be tricked into unlinking arbitrary files; anything else is
 * skipped and left in place.
 */
export async function discardAttachments(
  paths: readonly string[],
  sessionId: string,
  root?: string,
): Promise<number> {
  if (paths.length === 0) return 0;

  const dir = resolve(uploadsDir(sessionId, root));
  let removed = 0;

  for (const candidate of paths) {
    const target = resolve(candidate);
    if (dirname(target) !== dir) continue;

    // One failure must not stop the rest of the cleanup.
    try {
      await unlink(target);
      removed += 1;
    } catch {
      // Already gone, or not ours to remove.
    }
  }

  return removed;
}
