/**
 * A Qoder-compatible peer session.
 *
 * Starting a daemon binds a Unix socket, registers itself in the session
 * registry (so Qoder sessions can discover and reply to it), and accepts
 * inbound NDJSON frames. Outbound messages are sent on a fresh connection that
 * is immediately half-closed after the frame is written, exactly as the CLI
 * does.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import {
  createServer,
  connect,
  type Server,
  type Socket,
} from "node:net";
import { basename, dirname } from "node:path";

import {
  EXPIRED_RECEIPT_TIMEOUT_MS,
  FrameDecoder,
  OUTBOUND_TRACK_MAX,
  PEER_PROTOCOL,
  RECEIPT_STATUSES,
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
import {
  applyAttachments,
  discardAttachments,
  receiveAttachments,
  validateOutbound,
  type InboundAttachments,
} from "./attachments.ts";
import { DropReporter, type DropEvent, type DropReason } from "./guard.ts";
import { HeldQueue, type HeldMessage, type HeldOutcome } from "./held.ts";
import {
  evaluateInboundPolicy,
  loadProjectPolicy,
  loadUserSettings,
  resolveDialogExpiryMs,
  resolveInboundPolicy,
  projectSettingsPath,
  userSettingsPath,
  type InboundPolicy,
  type PermissionMode,
  type PolicyCause,
  type ResolvedSetting,
} from "./policy.ts";
import {
  SessionRecordWriter,
  defaultSocketPath,
  globalConfigDir,
  isProcessAlive,
  listPeers,
  probeSocket,
  processStartTime,
  readAllSessions,
  uid,
  type Peer,
  type SessionKind,
  type SessionRecord,
  type SessionStatus,
} from "./registry.ts";

const SEND_TIMEOUT_MS = 5_000;
const SOCKET_FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Exported once bound, so anything this process spawns can address the session.
 * The CLI writes both and never reads them back.
 */
const MESSAGING_SOCKET_ENV = "QODER_MESSAGING_SOCKET";
const MESSAGING_TOKEN_ENV = "QODER_MESSAGING_SELF_TOKEN";

/** How long a peer listing is trusted when judging whether a sender is known. */
const PEER_CACHE_MS = 1_000;

export interface InboundPolicyOptions {
  /** Explicit policy, equivalent to the CLI flag. Highest priority. */
  policy?: InboundPolicy;
  /**
   * This session's own permission posture. Defaults to `"prompting"`, which
   * accepts inbound messages unless a setting says otherwise.
   */
  permissionMode?: PermissionMode;
  /** Whether a hold can be put in front of someone for a decision. */
  reviewSurface?: boolean;
  /** Hold queue capacity before the oldest entry is evicted. */
  maxHeld?: number;
  /** How long a held message waits. Resolved from settings and the
   *  environment when omitted. */
  expiryMs?: number;
  /** Honour a sender's assertion about its own posture. */
  modeEmit?: boolean;
  /** Read `security.crossSessionInbound` from settings files. Default true. */
  readSettings?: boolean;
}

export interface PeerDaemonOptions {
  /** Explicit socket path. Defaults to the same location the CLI picks. */
  socketPath?: string;
  configDir?: string;
  /** Display name; defaults to `<cwd basename>-<pid>`. */
  name?: string;
  kind?: SessionKind;
  status?: SessionStatus;
  sessionId?: string;
  /** Stable token identifying this session on the wire. */
  selfToken?: string;
  cwd?: string;
  /** How inbound messages from other sessions are handled. */
  inbound?: InboundPolicyOptions;
  /** Attachment upload root. Defaults to `$QODER_HOME` or `~/.qoder-cli`. */
  attachmentsRoot?: string;
  /** Report `busy` while a send is in flight. Default true. */
  autoStatus?: boolean;
  /**
   * Keep the process alive for as long as the socket is bound. By default the
   * server does not hold the event loop open, which is what a library embedding
   * the daemon wants; a long-running watcher opts in.
   */
  keepAlive?: boolean;
}

export interface InboundMessage {
  from: string;
  fromName?: string;
  fromMode?: FromMode;
  hopChain?: string[];
  /** Body with any received attachments referenced as leading `@"path"`. */
  body: string;
  msgId?: string;
  /** The message carried our own token, so it originated from this session. */
  selfSent: boolean;
  /** The sender is a session currently listed in the registry. */
  knownPeer: boolean;
  /** Why policy handled it the way it did. */
  cause: PolicyCause;
  /** Absolute paths of attachments copied into this session. */
  attachments: string[];
  frame: UserFrame;
  envelope: Envelope;
}

export interface ReceiptEvent {
  status: ReceiptStatus;
  from: string;
  /** Id of the message this receipt refers to. */
  origMsgId?: string;
  /**
   * The message had been held before this receipt. A plain `delivered` for a
   * message that was never held carries no news and stays `false`.
   */
  wasHeld: boolean;
  frame: ReceiptFrame;
}

export interface SendResult {
  msgId: string;
  /** Attachment paths rejected locally, each with the reason. */
  rejected: string[];
}

export interface PeerDaemonEvents {
  message: [InboundMessage];
  receipt: [ReceiptEvent];
  /** A message policy says should be reviewed rather than delivered. */
  held: [HeldMessage];
  /** A message was dropped. Reporting is rate-limited, so not every drop emits. */
  dropped: [DropEvent];
  error: [Error];
}

export interface SendOptions {
  /** Name shown to the recipient. Defaults to the daemon's name. */
  senderName?: string;
  fromMode?: FromMode;
  priority?: Priority;
  /** Absolute paths to attach; validated before sending. */
  files?: readonly string[];
  /** Override the hop chain, e.g. when relaying a message for someone else. */
  hopChain?: readonly string[];
  /** Skip the hop-chain loop guard. Only useful for testing. */
  omitHopChain?: boolean;
}

export class PeerDaemon extends EventEmitter<PeerDaemonEvents> {
  readonly socketPath: string;
  readonly address: string;
  readonly handle: string;
  readonly ref: string;
  /** Mutable: reset by {@link PeerDaemon.resetSession}, as `/clear` does. */
  sessionId: string;
  readonly selfToken: string;
  /** Mutable: peers see the new value after {@link PeerDaemon.rename}. */
  name: string;
  readonly configDir: string;
  readonly startedAt: number;

  #server?: Server;
  #kind: SessionKind;
  #status: SessionStatus;
  #cwd: string;
  #connections = new Set<Socket>();
  #started = false;

  readonly #writer: SessionRecordWriter;
  readonly #guard: DropReporter;
  readonly #inboundOptions: InboundPolicyOptions;
  readonly #attachmentsRoot?: string;
  readonly #autoStatus: boolean;
  readonly #keepAlive: boolean;

  #held?: HeldQueue;
  #setting?: ResolvedSetting;
  /** Outstanding sends; drives the automatic busy status. */
  #busy = 0;
  /** Set when the caller pinned a status explicitly. */
  #pinnedStatus?: SessionStatus;
  #peerCache?: { at: number; paths: Set<string> };

  /** Sent messages awaiting a receipt, keyed by message id. */
  readonly #outbound = new Map<string, string>();
  /** Messages that were held by the peer and may still be delivered. */
  readonly #heldOutbound = new Map<string, string>();
  readonly #receiptWaiters = new Map<string, (receipt: ReceiptEvent) => void>();

  constructor(options: PeerDaemonOptions = {}) {
    super();

    this.configDir = options.configDir ?? globalConfigDir();
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.address = addressFromSocketPath(this.socketPath);
    this.handle = handleForSocketPath(this.socketPath);
    this.ref = refForSocketPath(this.socketPath);
    this.sessionId = options.sessionId ?? randomUUID();
    // Deliberately not read from the environment: the token identifies *this*
    // session, and inheriting one would make a foreign session's message look
    // self-sent — which policy accepts unconditionally.
    this.selfToken = options.selfToken ?? randomUUID();
    this.#cwd = options.cwd ?? process.cwd();
    this.#kind = options.kind ?? "bg";
    this.#status = options.status ?? "idle";
    this.name = options.name ?? `${basename(this.#cwd)}-${process.pid}`;
    this.startedAt = Date.now();

    this.#inboundOptions = options.inbound ?? {};
    if (options.attachmentsRoot !== undefined) {
      this.#attachmentsRoot = options.attachmentsRoot;
    }
    this.#autoStatus = options.autoStatus ?? true;
    this.#keepAlive = options.keepAlive ?? false;

    this.#writer = new SessionRecordWriter({ configDir: this.configDir });
    this.#guard = new DropReporter({ onDrop: (event) => this.emit("dropped", event) });

    if (!isLocalSocketPath(this.socketPath)) {
      throw new Error(`Socket path must be an absolute local path: ${this.socketPath}`);
    }
    if (!this.socketPath.endsWith(".sock")) {
      // Peers silently drop receipts for paths that do not look like sockets.
      throw new Error(`Socket path must end with ".sock": ${this.socketPath}`);
    }
  }

  get hopId(): string {
    return hopIdForAddress(this.address);
  }

  get running(): boolean {
    return this.#started;
  }

  /** Bind the socket and publish a registration record. */
  async start(): Promise<void> {
    if (this.#started) return;

    await this.#loadInboundConfiguration();

    await prepareSocketDir(dirname(this.socketPath));
    await this.#clearStaleSocket();

    const server = createServer({ allowHalfOpen: true }, (socket) => {
      this.#connections.add(socket);
      socket.on("close", () => this.#connections.delete(socket));
      socket.on("error", () => socket.destroy());
      this.#serve(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });

    // Adopt the server before any further await, so a failure below still
    // leaves it closable rather than bound to a daemon that never started.
    this.#server = server;
    if (!this.#keepAlive) server.unref();
    server.on("error", (error: Error) => this.emit("error", error));

    try {
      // The socket must be owner-only; the process umask is not enough.
      await chmod(this.socketPath, SOCKET_FILE_MODE);
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.#server = undefined;
      throw error;
    }

    const registered = await this.#writer.open(this.#record());
    if (!registered) {
      this.emit("error", new Error("Failed to write session registry record"));
    }

    // The CLI exports both of these once it is bound, so that anything it
    // spawns can address the session. It never reads them back itself.
    process.env[MESSAGING_SOCKET_ENV] = this.socketPath;
    process.env[MESSAGING_TOKEN_ENV] = this.selfToken;

    this.#started = true;
  }

  /** Resolve the inbound policy and build the hold queue from it. */
  async #loadInboundConfiguration(): Promise<void> {
    const options = this.#inboundOptions;
    const readSettings = options.readSettings ?? true;

    const settingsPath = userSettingsPath(this.configDir);
    const projectFile = projectSettingsPath(this.#cwd);

    const user = readSettings ? await loadUserSettings(settingsPath) : {};
    const project = readSettings ? await loadProjectPolicy(projectFile) : undefined;

    this.#setting = resolveInboundPolicy({
      ...(options.policy !== undefined ? { flag: options.policy } : {}),
      user,
      ...(project !== undefined ? { project } : {}),
      userPath: settingsPath,
      projectPath: projectFile,
    });

    this.#held = new HeldQueue({
      // Read live, so entries stay consistent with where attachments land even
      // after `resetSession()`.
      sessionId: () => this.sessionId,
      ...(options.maxHeld !== undefined ? { max: options.maxHeld } : {}),
      expiryMs: resolveDialogExpiryMs({
        ...(options.expiryMs !== undefined ? { expiryMs: options.expiryMs } : {}),
        ...(user.dialogExpiry !== undefined ? { configured: user.dialogExpiry } : {}),
      }),
      onHeld: (message) => this.emit("held", message),
      onResolved: (message, outcome) => {
        const task = this.#resolveHeld(message, outcome).catch(() => {});
        this.#pendingResolutions.add(task);
        void task.finally(() => this.#pendingResolutions.delete(task));
      },
    });
  }

  #record(): SessionRecord {
    return {
      pid: process.pid,
      procStart: processStartTime(),
      startedAt: this.startedAt,
      cwd: this.#cwd,
      sessionId: this.sessionId,
      name: this.name,
      kind: this.#kind,
      status: this.#status,
      messagingSocketPath: this.socketPath,
      peerProtocol: PEER_PROTOCOL,
    };
  }

  /** Held messages, oldest first. */
  get held(): readonly HeldMessage[] {
    return this.#held?.list() ?? [];
  }

  /** The policy that was resolved at startup, if any. */
  get inboundSetting(): ResolvedSetting | undefined {
    return this.#setting;
  }

  /** Receipt sends still in flight, awaited during shutdown. */
  #pendingReceipts: Array<Promise<void>> = [];
  /** Holds being resolved, awaited during shutdown before the receipt drain. */
  readonly #pendingResolutions = new Set<Promise<void>>();
  /** Messages waiting on a decision, kept until they are resolved. */
  readonly #pendingDelivery = new Map<string, InboundMessage>();

  /** Expire anything still held, deregister, and remove the socket. */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;

    // Nothing still queued will ever get a decision now, so tell those senders.
    // Resolving a hold may await an attachment cleanup before it queues its
    // receipt, so the resolutions themselves have to settle before the drain.
    this.#held?.expireAll();
    await Promise.allSettled([...this.#pendingResolutions]);
    await Promise.allSettled(this.#pendingReceipts);
    this.#pendingReceipts = [];
    this.#held?.close();
    this.#pendingDelivery.clear();

    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();

    await new Promise<void>((resolve) => {
      const server = this.#server;
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    this.#server = undefined;

    await this.#writer.close();
    await unlink(this.socketPath).catch(() => {});

    if (process.env[MESSAGING_SOCKET_ENV] === this.socketPath) {
      delete process.env[MESSAGING_SOCKET_ENV];
    }
    if (process.env[MESSAGING_TOKEN_ENV] === this.selfToken) {
      delete process.env[MESSAGING_TOKEN_ENV];
    }
  }

  /** Live peers, excluding this daemon. */
  listPeers(): Promise<Peer[]> {
    return listPeers(this.configDir, process.pid);
  }

  /**
   * Rename the session, as `/rename` does. The registry write is debounced;
   * call {@link PeerDaemon.flushRegistry} to wait for it.
   */
  rename(name: string): void {
    this.name = name;
    this.#writer.patch({ name });
  }

  /** Pin the status peers see, overriding the automatic busy tracking. */
  setStatus(status: SessionStatus): void {
    this.#status = status;
    this.#pinnedStatus = status;
    this.#writer.patch({ status });
  }

  /** Reset the session identity, as `/clear` and `/new` do. */
  resetSession(sessionId: string = randomUUID()): void {
    this.sessionId = sessionId;
    this.#writer.patch({ sessionId, name: undefined });
  }

  /** Wait for any debounced registry write to land. */
  flushRegistry(): Promise<void> {
    return this.#writer.flush();
  }

  /** Approve a held message, delivering it to this session. */
  approve(id: string): boolean {
    return this.#held?.approve(id) ?? false;
  }

  /** Decline a held message. The sender is told it was denied. */
  deny(id: string): boolean {
    return this.#held?.deny(id) ?? false;
  }

  /**
   * Finish a held message: hand it over on approval, drop its attachments when
   * declined, and report the outcome back to the sender in every case.
   */
  async #resolveHeld(message: HeldMessage, outcome: HeldOutcome): Promise<void> {
    const pending = this.#pendingDelivery.get(message.id);
    this.#pendingDelivery.delete(message.id);

    if (outcome === "delivered") {
      if (pending) this.emit("message", pending);
    } else if (message.attachmentPaths?.length) {
      await discardAttachments(
        message.attachmentPaths,
        message.sessionId,
        this.#attachmentsRoot,
      ).catch(() => {});
    }

    if (!message.from) return;
    this.#trackReceipt(this.sendReceipt(message.from, outcome, message.msgId));
  }

  #trackReceipt(send: Promise<void>): void {
    const tracked = send.catch(() => {});
    this.#pendingReceipts.push(tracked);
    void tracked.then(() => {
      const index = this.#pendingReceipts.indexOf(tracked);
      if (index !== -1) this.#pendingReceipts.splice(index, 1);
    });
  }

  /** Automatic `busy`/`idle` tracking, unless the caller pinned a status. */
  #setBusy(busy: boolean): void {
    if (!this.#autoStatus || this.#pinnedStatus !== undefined) return;

    this.#busy += busy ? 1 : -1;
    if (this.#busy < 0) this.#busy = 0;

    const status: SessionStatus = this.#busy > 0 ? "busy" : "idle";
    if (status === this.#status) return;

    this.#status = status;
    this.#writer.patch({ status });
  }

  /**
   * Send a message to a peer. Returns the generated message id, which the
   * peer echoes back in its receipt.
   */
  async send(
    target: string | Peer,
    text: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    // A string target may be a bare path or a `uds:` address.
    const socketPath =
      typeof target === "string"
        ? (socketPathFromAddress(target) ?? target)
        : target.messagingSocketPath;

    const attachments = options.files?.length
      ? await validateOutbound(options.files)
      : { files: [], rejected: [] };

    const hopChain = options.omitHopChain ? undefined : (options.hopChain ?? [this.hopId]);

    const envelope = buildEnvelope({
      from: this.address,
      ...(hopChain?.length ? { hopChain: [...hopChain] } : {}),
      fromName: options.senderName ?? this.name,
      ...(options.fromMode ? { fromMode: options.fromMode } : {}),
      body: text,
    });

    const frame: UserFrame = {
      type: "user",
      msg_id: randomUUID(),
      message: { role: "user", content: envelope },
      priority: options.priority ?? "next",
      from: this.address,
      self_token: this.selfToken,
      ...(attachments.files.length ? { file_attachments: attachments.files } : {}),
    };

    this.#rememberOutbound(frame.msg_id, addressFromSocketPath(socketPath));
    this.#setBusy(true);
    try {
      await this.#write(socketPath, frame);
    } finally {
      this.#setBusy(false);
    }

    return { msgId: frame.msg_id, rejected: attachments.rejected };
  }

  /** Wait for the receipt that refers to `msgId`. */
  waitForReceipt(msgId: string, timeoutMs: number): Promise<ReceiptEvent | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#receiptWaiters.delete(msgId);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();

      this.#receiptWaiters.set(msgId, (receipt) => {
        clearTimeout(timer);
        resolve(receipt);
      });
    });
  }

  /**
   * Send a receipt for a message we received. Receipts only go to a peer we can
   * account for — one in the registry, or one whose socket shares our directory.
   */
  async sendReceipt(
    to: string,
    status: ReceiptStatus,
    origMsgId?: string,
  ): Promise<void> {
    const socketPath = socketPathFromAddress(to);
    if (
      !socketPath ||
      !isLocalSocketPath(socketPath) ||
      !socketPath.endsWith(".sock")
    ) {
      return;
    }

    if (!(await this.#isKnownPeer(to)) && dirname(socketPath) !== dirname(this.socketPath)) {
      return;
    }

    const frame: ReceiptFrame = {
      type: "control",
      action: "peer_message_status",
      status,
      from: this.address,
      ...(origMsgId !== undefined ? { orig_msg_id: origMsgId } : {}),
    };

    // An `expired` receipt is sent during shutdown, so it must not linger.
    const timeout = status === "expired" ? EXPIRED_RECEIPT_TIMEOUT_MS : SEND_TIMEOUT_MS;
    await this.#write(socketPath, frame, timeout).catch(() => {});
  }

  #rememberOutbound(msgId: string, to: string): void {
    this.#outbound.set(msgId, to);
    while (this.#outbound.size > OUTBOUND_TRACK_MAX) {
      const oldest = this.#outbound.keys().next().value;
      if (oldest === undefined) break;
      this.#outbound.delete(oldest);
    }
  }

  /** Match an incoming receipt to a message we sent. Undefined if unmatched. */
  #correlateReceipt(frame: ReceiptFrame): { wasHeld: boolean } | undefined {
    if (!(RECEIPT_STATUSES as readonly string[]).includes(frame.status)) return undefined;

    const origMsgId = frame.orig_msg_id;
    if (!origMsgId) return undefined;

    if (this.#outbound.has(origMsgId)) {
      const to = this.#outbound.get(origMsgId)!;
      this.#outbound.delete(origMsgId);

      // A held message may still be delivered later; remember it so the
      // eventual `delivered` is recognisable as news.
      if (frame.status === "held") {
        this.#heldOutbound.set(origMsgId, to);
        while (this.#heldOutbound.size > OUTBOUND_TRACK_MAX) {
          const oldest = this.#heldOutbound.keys().next().value;
          if (oldest === undefined) break;
          this.#heldOutbound.delete(oldest);
        }
      }

      return { wasHeld: false };
    }

    if (this.#heldOutbound.has(origMsgId) && frame.status !== "held") {
      this.#heldOutbound.delete(origMsgId);
      return { wasHeld: true };
    }

    return undefined;
  }

  /** Whether `address` belongs to a session currently in the registry. */
  async #isKnownPeer(address: string): Promise<boolean> {
    const socketPath = socketPathFromAddress(address);
    if (!socketPath) return false;

    const now = Date.now();
    if (!this.#peerCache || now - this.#peerCache.at > PEER_CACHE_MS) {
      try {
        const sessions = await readAllSessions(this.configDir);
        this.#peerCache = {
          at: now,
          paths: new Set(
            sessions
              .map((entry) => entry.record.messagingSocketPath)
              .filter((path) => path !== ""),
          ),
        };
      } catch {
        return false;
      }
    }

    return this.#peerCache.paths.has(socketPath);
  }

  async #write(
    socketPath: string,
    frame: Frame,
    timeoutMs: number = SEND_TIMEOUT_MS,
  ): Promise<void> {
    if (!isLocalSocketPath(socketPath)) {
      throw new Error(`Refusing to connect to non-local IPC path: ${socketPath}`);
    }

    await new Promise<void>((resolve, reject) => {
      const socket = connect({ path: socketPath });
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.setTimeout(timeoutMs, () =>
        fail(new Error(`Timed out sending to ${socketPath}`)),
      );
      socket.on("error", fail);
      socket.on("connect", () => {
        socket.write(encodeFrame(frame));
        socket.end();
      });
      socket.on("close", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  }

  #serve(socket: Socket): void {
    const decoder = new FrameDecoder(
      (frame) => {
        void this.#handleFrame(frame).catch((error: unknown) => {
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        });
      },
      () => this.#guard.report("unknown", "invalid-frame"),
    );

    socket.on("data", (chunk: Buffer) => {
      if (decoder.push(chunk)) return;
      // The frame was over the limit; the connection cannot be resynchronised.
      this.#guard.report("unknown", "oversized");
      socket.destroy();
    });

    // The server listens with `allowHalfOpen`, so a peer that ends its side
    // leaves this one open. Close it in turn, otherwise the sender never sees
    // `close` and its send promise never settles.
    socket.on("end", () => socket.end());
    socket.on("error", () => socket.destroy());
  }

  async #handleFrame(frame: Frame): Promise<void> {
    if (isReceiptFrame(frame)) {
      const correlated = this.#correlateReceipt(frame);
      if (!correlated) return; // not a receipt for anything we sent

      const event: ReceiptEvent = {
        status: frame.status,
        from: frame.from,
        ...(frame.orig_msg_id !== undefined ? { origMsgId: frame.orig_msg_id } : {}),
        wasHeld: correlated.wasHeld,
        frame,
      };

      if (event.origMsgId !== undefined) {
        const waiter = this.#receiptWaiters.get(event.origMsgId);
        if (waiter) {
          this.#receiptWaiters.delete(event.origMsgId);
          waiter(event);
        }
      }

      this.emit("receipt", event);
      return;
    }

    if (!isUserFrame(frame)) return;

    const envelope = parseEnvelope(frame.message.content);
    if (!envelope) {
      this.#guard.report(frameFrom(frame), "invalid-envelope");
      return;
    }

    const from = envelope.from ?? frame.from ?? "";
    if (from === this.address) {
      this.#guard.report(from, "self-echo");
      return;
    }
    if (envelope.hopChain?.includes(this.hopId)) {
      this.#guard.report(from, "loop-detected");
      return;
    }

    const selfSent =
      frame.self_token !== undefined && frame.self_token === this.selfToken;
    const knownPeer = from.length > 0 ? await this.#isKnownPeer(from) : false;

    const decision = evaluateInboundPolicy(
      { selfSent, ...(envelope.fromMode ? { fromMode: envelope.fromMode } : {}) },
      {
        permissionMode: this.#inboundOptions.permissionMode ?? "prompting",
        // Opt-in: a caller that cannot put a hold in front of someone should
        // not silently park messages in a queue nobody will ever review.
        reviewSurface: this.#inboundOptions.reviewSurface ?? false,
        ...(this.#setting ? { setting: this.#setting } : {}),
        ...(this.#inboundOptions.modeEmit !== undefined
          ? { modeEmit: this.#inboundOptions.modeEmit }
          : {}),
      },
    );

    if (decision.policy === "refuse") {
      // A refusal never fetches attachments — there is nowhere to put them.
      this.#guard.report(from, "refused");
      if (from) this.#trackReceipt(this.sendReceipt(from, "denied", frame.msg_id));
      return;
    }

    const received = await receiveAttachments(
      frame.file_attachments,
      this.sessionId,
      this.#attachmentsRoot,
    ).catch(
      (): InboundAttachments => ({ received: 0, paths: [], rejected: [] }),
    );

    const message: InboundMessage = {
      from,
      ...(envelope.fromName !== undefined ? { fromName: envelope.fromName } : {}),
      ...(envelope.fromMode !== undefined ? { fromMode: envelope.fromMode } : {}),
      ...(envelope.hopChain !== undefined ? { hopChain: envelope.hopChain } : {}),
      body: applyAttachments(envelope.body, received),
      ...(frame.msg_id !== undefined ? { msgId: frame.msg_id } : {}),
      selfSent,
      knownPeer,
      cause: decision.cause,
      attachments: received.paths,
      frame,
      envelope,
    };

    if (decision.policy === "accept") {
      this.emit("message", message);
      if (from) this.#trackReceipt(this.sendReceipt(from, "delivered", frame.msg_id));
      return;
    }

    // The sender controls this field, so only well-formed entries are kept.
    const declared = declaredAttachments(frame.file_attachments);

    const held = this.#held?.add({
      from,
      ...(envelope.fromName !== undefined ? { fromName: envelope.fromName } : {}),
      ...(frame.msg_id !== undefined ? { msgId: frame.msg_id } : {}),
      knownPeer,
      cause: decision.cause,
      body: message.body,
      ...(envelope.fromMode !== undefined ? { fromMode: envelope.fromMode } : {}),
      selfSent,
      priority: frame.priority ?? "next",
      ...(declared.length ? { attachments: declared } : {}),
      ...(received.paths.length ? { attachmentPaths: received.paths } : {}),
    });

    // A full queue evicts as it accepts, so the entry may already be gone.
    if (held && this.#held?.get(held.id)) {
      this.#pendingDelivery.set(held.id, message);
    }
    if (from) this.#trackReceipt(this.sendReceipt(from, "held", frame.msg_id));
  }

  /** Refuse to bind onto an existing live socket; clean up a dead one. */
  async #clearStaleSocket(): Promise<void> {
    let stats;
    try {
      stats = await lstat(this.socketPath);
    } catch {
      return;
    }

    if (!stats.isSocket()) {
      throw new Error(
        `Socket path exists and is not a socket; refusing to remove it: ${this.socketPath}`,
      );
    }
    if (await probeSocket(this.socketPath)) {
      throw new Error(`Socket path is already served by a live session: ${this.socketPath}`);
    }
    if (!isProcessAlive(process.pid)) return;

    await unlink(this.socketPath).catch(() => {});
  }
}

/**
 * Create the socket directory and make it owner-only.
 *
 * Ownership is verified rather than assumed. Tightening a directory that
 * belongs to someone else would be both wrong and destructive — pointing the
 * socket at `/tmp` must fail, not `chmod 0700` on `/tmp`.
 */
async function prepareSocketDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });

  const stats = await lstat(dir);
  if (!stats.isDirectory()) throw new Error(`Not a directory: ${dir}`);
  if (stats.uid !== uid()) {
    throw new Error(`Socket directory is owned by uid ${stats.uid}, not ${uid()}: ${dir}`);
  }

  if ((stats.mode & 0o777) === DIR_MODE) return;
  await chmod(dir, DIR_MODE);

  if (((await lstat(dir)).mode & 0o777) !== DIR_MODE) {
    throw new Error(`Directory mode is still not 0700 after chmod: ${dir}`);
  }
}

/**
 * Keep only the attachment entries that are shaped correctly. The list arrives
 * from a peer, so a malformed entry must not reach consumers that assume it.
 */
function declaredAttachments(files: unknown): FileAttachment[] {
  if (!Array.isArray(files)) return [];

  return files.filter((entry): entry is FileAttachment => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as Partial<FileAttachment>;
    return (
      typeof candidate.path === "string" &&
      typeof candidate.name === "string" &&
      typeof candidate.bytes === "number"
    );
  });
}

/** Best-effort sender for a frame we could not decode far enough to trust. */
function frameFrom(frame: Frame): string {
  const from = (frame as { from?: unknown }).from;
  return typeof from === "string" && from.length > 0 ? from : "unknown";
}

