/**
 * qoder-peer — a client for Qoder CLI's cross-session messaging socket.
 *
 * Qoder sessions announce themselves in `<configDir>/sessions/<pid>.json` and
 * listen on a private Unix socket. This module speaks the same protocol, so it
 * can send work to a session, receive the reply, and behave like a session in
 * its own right.
 *
 * ```ts
 * const daemon = new PeerDaemon({ name: "my-orchestrator" });
 * await daemon.start();
 *
 * daemon.on("held", (message) => console.log("held:", message.id, message.body));
 *
 * const peers = await daemon.listPeers();
 * const target = resolveTarget(peers[0].ref, peers).peer!;
 * await daemon.send(target, "Summarise the failing test in this repo.");
 * ```
 */

export {
  PeerDaemon,
  type InboundMessage,
  type InboundPolicyOptions,
  type PeerDaemonEvents,
  type PeerDaemonOptions,
  type ReceiptEvent,
  type SendOptions,
  type SendResult,
} from "./peer.ts";

// ---------------------------------------------------------------------------
// Inbound policy
// ---------------------------------------------------------------------------

export {
  INBOUND_POLICIES,
  evaluateInboundPolicy,
  isDialogEligible,
  isInboundPolicy,
  loadProjectPolicy,
  loadUserSettings,
  projectSettingsPath,
  readSettings,
  resolveDialogExpiryMs,
  resolveInboundPolicy,
  userSettingsPath,
  type DialogExpiryOptions,
  type EvaluatePolicyOptions,
  type InboundPolicy,
  type PermissionMode,
  type PolicyCause,
  type PolicyDecision,
  type PolicyHints,
  type PolicyScope,
  type PolicySource,
  type ResolveInboundOptions,
  type ResolvedSetting,
  type UserSettings,
} from "./policy.ts";

// ---------------------------------------------------------------------------
// Held messages and drop reporting
// ---------------------------------------------------------------------------

export {
  HeldQueue,
  type HeldMessage,
  type HeldOutcome,
  type HeldQueueOptions,
} from "./held.ts";

export {
  DropReporter,
  type DropEvent,
  type DropReason,
  type DropReporterOptions,
} from "./guard.ts";

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export {
  applyAttachments,
  discardAttachments,
  receiveAttachments,
  uploadsDir,
  validateOutbound,
  type InboundAttachments,
  type OutboundAttachments,
} from "./attachments.ts";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export {
  SESSION_KINDS,
  SESSION_STATUSES,
  SessionRecordWriter,
  defaultSocketPath,
  globalConfigDir,
  isProcessAlive,
  listPeers,
  probeSocket,
  processStartTime,
  readAllSessions,
  readSessionRecord,
  recordPath,
  removeSessionRecord,
  resolveTarget,
  sessionsDir,
  toPeer,
  writeSessionRecord,
  type Peer,
  type ResolvedTarget,
  type SessionKind,
  type SessionRecord,
  type SessionRecordWriterOptions,
  type SessionStatus,
} from "./registry.ts";

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export {
  FrameDecoder,
  GUARD_MAX_KEYS,
  GUARD_MAX_REPORTS,
  GUARD_WINDOW_MS,
  HELD_QUEUE_MAX,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_FRAME_BYTES,
  MAX_MENTION_LENGTH,
  OUTBOUND_TRACK_MAX,
  PEER_PROTOCOL,
  RECEIPT_STATUSES,
  UDS_ADDRESS_PREFIX,
  addressFromSocketPath,
  buildEnvelope,
  encodeFrame,
  escapeMention,
  handleForSocketPath,
  hopIdForAddress,
  isLocalSocketPath,
  isReceiptFrame,
  isUserFrame,
  isValidMention,
  mentionPaths,
  parseEnvelope,
  parseMentions,
  refForSocketPath,
  socketPathFromAddress,
  type Envelope,
  type FileAttachment,
  type Frame,
  type FromMode,
  type Priority,
  type ReceiptFrame,
  type ReceiptStatus,
  type UserFrame,
} from "./protocol.ts";
