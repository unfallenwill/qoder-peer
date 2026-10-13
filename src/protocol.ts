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
  name: string;
  path: string;
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

  // Written out longhand rather than as a parameter property, so the source can
  // be executed directly by Node's type stripping.
  constructor(onFrame: (frame: Frame) => void) {
    this.#onFrame = onFrame;
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
