/**
 * qoder-peer — a client for Qoder CLI's cross-session messaging socket.
 *
 * Qoder sessions announce themselves in `<configDir>/sessions/<pid>.json` and
 * listen on a private Unix socket. This module speaks the same protocol, so it
 * can send work to a session and receive the reply.
 *
 * ```ts
 * const daemon = new PeerDaemon({ name: "my-orchestrator" });
 * await daemon.start();
 *
 * const peers = await daemon.listPeers();
 * const target = resolveTarget(peers[0].ref, peers).peer!;
 *
 * daemon.on("message", (message) => console.log(message.fromName, message.body));
 * await daemon.send(target, "Summarise the failing test in this repo.");
 * ```
 */

export {
  PeerDaemon,
  type InboundMessage,
  type PeerDaemonEvents,
  type PeerDaemonOptions,
  type ReceiptEvent,
  type SendOptions,
} from "./peer.ts";

export {
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
  SESSION_KINDS,
  SESSION_STATUSES,
  type Peer,
  type ResolvedTarget,
  type SessionKind,
  type SessionRecord,
  type SessionStatus,
} from "./registry.ts";

export {
  FrameDecoder,
  RECEIPT_STATUSES,
  UDS_ADDRESS_PREFIX,
  addressFromSocketPath,
  buildEnvelope,
  encodeFrame,
  handleForSocketPath,
  hopIdForAddress,
  isLocalSocketPath,
  isReceiptFrame,
  isUserFrame,
  parseEnvelope,
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
