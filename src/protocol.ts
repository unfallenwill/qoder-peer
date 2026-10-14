/**
 * Wire protocol for Qoder CLI cross-session messaging.
 *
 * Qoder sessions talk to each other over a Unix domain socket using
 * newline-delimited JSON. Each frame carries a `message.content` string that is
 * itself a small tagged envelope holding the actual text plus routing metadata.
 *
 * Layout of one frame on the wire:
 *
 *     {"type":"user","msg_id":"…","message":{"role":"user","content":"<envelope>"},…}\n
 *
 * The constants and shapes below mirror the ones the CLI itself uses, so that a
 * third-party client is indistinguishable from a Qoder session.
 */

import { createHash } from "node:crypto";

/** Every peer address is a `uds:` prefixed, percent-encoded absolute path. */
export const UDS_ADDRESS_PREFIX = "uds:";

/** Tag wrapping the payload inside `message.content`. */
export const ENVELOPE_TAG = "cross-session-message";

/** Frames are newline-delimited (`0x0a`). */
export const FRAME_DELIMITER = 0x0a;

/** A frame larger than this kills the connection. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Directory holding per-session sockets, under `$XDG_RUNTIME_DIR` or `/tmp`. */
export const SOCKET_DIR_NAME = "qoder-socks";

/** Directory holding `sessions/<pid>.json` registration records. */
export const SESSIONS_DIR_NAME = "sessions";

/** Protocol version advertised in the registration record. */
export const PEER_PROTOCOL = 1;

/** `sun_path` is 108 bytes including the NUL, so paths must stay under 104. */
const MAX_SOCKET_PATH_BYTES = 104;

const MAX_HOP_CHAIN = 32;
const HOP_ID_HEX = 24;
const REF_HEX = 6;
const HANDLE_HEX = 2;
const MAX_ADDRESS_BYTES = 300;
const MAX_FROM_NAME = 120;

// ---------------------------------------------------------------------------
// Limits shared with the reference implementation
// ---------------------------------------------------------------------------

/** Attachments accepted per message. Anything beyond this is reported as rejected. */
export const MAX_ATTACHMENTS = 10;

/** Per-file attachment ceiling. */
export const MAX_ATTACHMENT_BYTES = 52_428_800;

/** Entries kept in the inbound hold queue before the oldest is evicted. */
export const HELD_QUEUE_MAX = 100;

/** How long a held message waits for a decision before it expires. */
export const DEFAULT_DIALOG_EXPIRY_MS = 300_000;

/** Default timeout for writing a receipt. */
export const RECEIPT_TIMEOUT_MS = 5_000;

/** `expired` receipts use a shorter timeout so shutdown is not held up. */
export const EXPIRED_RECEIPT_TIMEOUT_MS = 300;

/** Sent messages tracked for receipt correlation, split across two tables. */
export const OUTBOUND_TRACK_MAX = 200;

/** Fixed window used to coalesce drop reports. */
export const GUARD_WINDOW_MS = 60_000;

/** Drop reports emitted per window before the rest are only counted. */
export const GUARD_MAX_REPORTS = 20;

/** Distinct `(from, reason)` keys remembered for de-duplication. */
export const GUARD_MAX_KEYS = 256;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Percent-encode a socket path the way the CLI does: safe characters pass
 * through untouched, anything else is encoded per UTF-8 byte.
 */
function encodeAddressTarget(target: string): string {
  let out = "";
  for (const char of target) {
    if (/[A-Za-z0-9_/.-]/.test(char)) {
      out += char;
      continue;
    }
    for (const byte of Buffer.from(char, "utf8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

export function addressFromSocketPath(socketPath: string): string {
  return `${UDS_ADDRESS_PREFIX}${encodeAddressTarget(socketPath)}`;
}

/** Inverse of {@link addressFromSocketPath}. Returns undefined for foreign schemes. */
export function socketPathFromAddress(address: string): string | undefined {
  if (address.startsWith(UDS_ADDRESS_PREFIX)) {
    const raw = address.slice(UDS_ADDRESS_PREFIX.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** A socket path is accepted only if it is an absolute, local, NUL-free path. */
export function isLocalSocketPath(value: string | undefined): value is string {
  if (!value || value.includes("\0")) return false;
  if (value.includes("://")) return false;
  return value.startsWith("/");
}

export function isAddressShaped(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_ADDRESS_BYTES &&
    /^[A-Za-z0-9%:_/.-]+$/.test(value)
  );
}

// ---------------------------------------------------------------------------
// Derived identifiers
// ---------------------------------------------------------------------------

const sha256 = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

/** Short, stable id for a socket path. Two hex characters — `/peers` shows this. */
export function handleForSocketPath(socketPath: string): string {
  return sha256(`session:${socketPath}`).slice(0, HANDLE_HEX);
}

/** Six hex characters, used as a stable reference in listings. */
export function refForSocketPath(socketPath: string): string {
  return sha256(`session:${socketPath}`).slice(0, REF_HEX);
}

/** Hop entries are hashes of addresses; a chain of them detects loops. */
export function hopIdForAddress(address: string): string {
  return sha256(address).slice(0, HOP_ID_HEX);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

const FROM_PATTERN = String.raw`[A-Za-z0-9%:_/.\\-]{1,${MAX_ADDRESS_BYTES}}`;
const HOP_CHAIN_PATTERN = String.raw`[0-9a-f]{${HOP_ID_HEX}}(?:,[0-9a-f]{${HOP_ID_HEX}})*`;
const FROM_NAME_PATTERN = String.raw`[^"<>\n\r]{1,${MAX_FROM_NAME}}`;

const ENVELOPE_RE = new RegExp(
  String.raw`^<${ENVELOPE_TAG}` +
    String.raw`(?: from="(${FROM_PATTERN})")?` +
    String.raw`(?: hop-chain="(${HOP_CHAIN_PATTERN})")?` +
    String.raw`(?: from-name="(${FROM_NAME_PATTERN})")?` +
    String.raw`(?: from-mode="(bypass|prompting)")?>` +
    String.raw`\n([\s\S]*)\n</${ENVELOPE_TAG}>$`,
);

const ESCAPE_RE = new RegExp(
  String.raw`<(?=/?${ENVELOPE_TAG}(?:[>\s/]|$))`,
  "gi",
);
const UNESCAPE_RE = new RegExp(
  String.raw`<\\(?=/?${ENVELOPE_TAG}(?:[>\s/]|$))`,
  "gi",
);

export type FromMode = "bypass" | "prompting";

export interface Envelope {
  from?: string;
  hopChain?: string[];
  fromName?: string;
  fromMode?: FromMode;
  body: string;
}

/** Strip characters that would break the quoting around `from-name`. */
function sanitizeFromName(name: string): string {
  return name.replace(/["<>\n\r]/g, "").trim().slice(0, MAX_FROM_NAME);
}

/** Escape body text so it cannot forge a closing tag. */
function escapeBody(body: string): string {
  return body.replace(ESCAPE_RE, "<\\");
}

function unescapeBody(body: string): string {
  return body.replace(UNESCAPE_RE, "<");
}

export function buildEnvelope(envelope: Envelope): string {
  const attributes: string[] = [];
  if (envelope.from) attributes.push(`from="${envelope.from}"`);
  if (envelope.hopChain?.length) {
    attributes.push(`hop-chain="${envelope.hopChain.join(",")}"`);
  }
  const name =
    envelope.fromName === undefined ? "" : sanitizeFromName(envelope.fromName);
  if (name) attributes.push(`from-name="${name}"`);
  if (envelope.fromMode) attributes.push(`from-mode="${envelope.fromMode}"`);

  const header = attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
  return `<${ENVELOPE_TAG}${header}>\n${escapeBody(envelope.body)}\n</${ENVELOPE_TAG}>`;
}

/**
 * Parse an envelope. Returns undefined when the text is not a well-formed
 * envelope; a round-trip check rejects anything the CLI would also reject.
 */
export function parseEnvelope(text: string): Envelope | undefined {
  const match = ENVELOPE_RE.exec(text);
  if (!match) return undefined;

  const hopChain = match[2] ? match[2].split(",") : undefined;
  if (hopChain && hopChain.length > MAX_HOP_CHAIN) return undefined;

  const parsed: Envelope = {
    ...(match[1] !== undefined ? { from: match[1] } : {}),
    ...(hopChain ? { hopChain } : {}),
    ...(match[3] !== undefined ? { fromName: match[3] } : {}),
    ...(match[4] !== undefined ? { fromMode: match[4] as FromMode } : {}),
    body: match[5] ?? "",
  };

  // The CLI performs the same check: re-serializing must reproduce the input
  // exactly, which catches any header the regex accepted too loosely.
  if (buildEnvelope(parsed) !== text) return undefined;

  return { ...parsed, body: unescapeBody(parsed.body) };
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export type Priority = "now" | "later" | "next";

export interface FileAttachment {
  /** Absolute path on the sender's machine. */
  path: string;
  /** Basename captured at send time; the receiver sanitises and re-prefixes it. */
  name: string;
  /** Size in bytes at send time; the receiver re-checks it against the limit. */
  bytes: number;
}

export interface UserFrame {
  type: "user";
  msg_id: string;
  message: { role: "user"; content: string };
  priority?: Priority;
  from?: string;
  self_token?: string;
  file_attachments?: FileAttachment[];
}

export const RECEIPT_STATUSES = ["held", "denied", "expired", "delivered"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export interface ReceiptFrame {
  type: "control";
  action: "peer_message_status";
  status: ReceiptStatus;
  from: string;
  orig_msg_id?: string;
  msg_id?: string;
}

export type Frame = UserFrame | ReceiptFrame | { type: string; [key: string]: unknown };

export function isReceiptFrame(frame: Frame): frame is ReceiptFrame {
  return (
    frame.type === "control" &&
    (frame as ReceiptFrame).action === "peer_message_status"
  );
}

export function isUserFrame(frame: Frame): frame is UserFrame {
  return frame.type === "user" && typeof (frame as UserFrame).message?.content === "string";
}

/**
 * Incremental newline-delimited JSON decoder.
 *
 * Chunks are buffered until a `\n` arrives. An oversized frame is reported to
 * the caller, which is expected to drop the connection — same as the CLI.
 */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  readonly #onFrame: (frame: Frame) => void;
  readonly #onInvalidFrame?: () => void;

  // Written out longhand rather than as a parameter property, so the source can
  // be executed directly by Node's type stripping.
  constructor(onFrame: (frame: Frame) => void, onInvalidFrame?: () => void) {
    this.#onFrame = onFrame;
    if (onInvalidFrame) this.#onInvalidFrame = onInvalidFrame;
  }

  /** Returns false when the stream should be destroyed (oversized frame). */
  push(chunk: Buffer): boolean {
    let rest = chunk;

    for (;;) {
      const index = rest.indexOf(FRAME_DELIMITER);
      if (index === -1) break;

      const head = rest.subarray(0, index);
      rest = rest.subarray(index + 1);

      const combined =
        this.#buffer.length === 0 ? head : Buffer.concat([this.#buffer, head]);
      this.#buffer = Buffer.alloc(0);

      if (combined.length > MAX_FRAME_BYTES) return false;

      // Blank lines are keep-alives, not frames.
      const text = combined.toString("utf8");
      if (!text.trim()) continue;

      try {
        this.#onFrame(JSON.parse(text) as Frame);
      } catch {
        // Malformed JSON is dropped; the connection stays usable.
        this.#onInvalidFrame?.();
      }
    }

    if (rest.length > 0) {
      this.#buffer =
        this.#buffer.length === 0 ? rest : Buffer.concat([this.#buffer, rest]);
      if (this.#buffer.length > MAX_FRAME_BYTES) return false;
    }

    return true;
  }
}

export function encodeFrame(frame: Frame): Buffer {
  return Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
}

export const socketPathLimit = MAX_SOCKET_PATH_BYTES;

// ---------------------------------------------------------------------------
// `@`-mention syntax
// ---------------------------------------------------------------------------
//
// Mentions do not select a delivery target — that is always the explicit
// recipient. They are a reference syntax: the CLI uses them for autocomplete,
// for injecting context into the agent's prompt, and to point at files it has
// just copied into the session (`@"<absolute path>"`).

/** Longest mention the CLI will accept. */
export const MAX_MENTION_LENGTH = 120;

/**
 * `@` only starts a mention at the beginning of a line or after whitespace.
 * The capture accepts an escaped pair, any character outside the shell/quote
 * special set, or a dot that is neither trailing nor followed by whitespace.
 */
const MENTION_RE = /(?:^|\s)@((?:\\.|[^\s()\[\]{};|*?$`'"#&<>!~\\,.]+|\.(?!$|\s))+)/g;

const MENTION_SPECIAL_RE = /[ \t\n\r()\[\]{};|*?$`'"#&<>!~\\,]/g;

/** Characters that make a mention ambiguous or unrenderable. */
const RENDER_HOSTILE_RE = /[<>\n\r\t]/;

/** Control and format characters, which could smuggle invisible text. */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/gu;

function unescapeMention(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

function stripInvisible(value: string): string {
  return value.replace(INVISIBLE_RE, "");
}

/**
 * A mention is usable only if it is non-empty, within the length limit, free of
 * render-hostile characters, and unchanged by invisible-character stripping —
 * the last check rejects spoofed names that look identical to a real one.
 */
export function isValidMention(value: string): boolean {
  if (value.length === 0) return false;
  if (value.length > MAX_MENTION_LENGTH) return false;
  if (RENDER_HOSTILE_RE.test(value)) return false;
  return stripInvisible(value) === value;
}

/** Extract the distinct, valid mentions referenced by a body of text. */
export function parseMentions(text: string): string[] {
  if (!text.includes("@")) return [];

  const found = new Set<string>();
  MENTION_RE.lastIndex = 0;

  for (let match = MENTION_RE.exec(text); match !== null; match = MENTION_RE.exec(text)) {
    const name = unescapeMention(match[1] ?? "");
    if (isValidMention(name)) found.add(name);
  }

  return [...found];
}

/**
 * Escape a name so it round-trips through {@link parseMentions}. Commas matter
 * most: `from-name` and `hop-chain` are comma-separated, so an unescaped comma
 * would split a mention when it is offered as a completion.
 */
export function escapeMention(name: string): string {
  return name.replace(MENTION_SPECIAL_RE, "\\$&");
}

/**
 * Render already-copied attachment paths as leading mentions, matching the way
 * the CLI hands received files to its agent.
 */
export function mentionPaths(paths: readonly string[]): string {
  return paths.map((path) => `@"${path}"`).join(" ");
}
