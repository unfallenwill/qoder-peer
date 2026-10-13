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
  FrameDecoder,
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
  type Priority,
  type ReceiptFrame,
  type ReceiptStatus,
  type UserFrame,
  type FromMode,
} from "./protocol.ts";
import {
  defaultSocketPath,
  globalConfigDir,
  isProcessAlive,
  listPeers,
  probeSocket,
  processStartTime,
  removeSessionRecord,
  writeSessionRecord,
  type Peer,
  type SessionKind,
  type SessionStatus,
} from "./registry.ts";

const SEND_TIMEOUT_MS = 5_000;
const SOCKET_FILE_MODE = 0o600;
const DIR_MODE = 0o700;

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
  /** Receipt status reported back for inbound messages. */
  receiptStatus?: ReceiptStatus;
}

export interface InboundMessage {
  from: string;
  fromName?: string;
  fromMode?: FromMode;
  hopChain?: string[];
  body: string;
  msgId?: string;
  frame: UserFrame;
  envelope: Envelope;
}

export interface ReceiptEvent {
  status: ReceiptStatus;
  from: string;
  /** Id of the message this receipt refers to. */
  origMsgId?: string;
  frame: ReceiptFrame;
}

export interface PeerDaemonEvents {
  message: [InboundMessage];
  receipt: [ReceiptEvent];
  error: [Error];
}

export interface SendOptions {
  /** Name shown to the recipient. Defaults to the daemon's name. */
  senderName?: string;
  fromMode?: FromMode;
  priority?: Priority;
  files?: FileAttachment[];
  /** Skip the hop-chain loop guard. Only useful for testing. */
  omitHopChain?: boolean;
}

export class PeerDaemon extends EventEmitter<PeerDaemonEvents> {
  readonly socketPath: string;
  readonly address: string;
  readonly handle: string;
  readonly ref: string;
  readonly sessionId: string;
  readonly selfToken: string;
  /** Mutable: peers see the new value after {@link PeerDaemon.rename}. */
  name: string;
  readonly configDir: string;
  readonly startedAt: number;

  #server?: Server;
  #kind: SessionKind;
  #status: SessionStatus;
  #cwd: string;
  #receiptStatus: ReceiptStatus;
  #connections = new Set<Socket>();
  #started = false;

  constructor(options: PeerDaemonOptions = {}) {
    super();

    this.configDir = options.configDir ?? globalConfigDir();
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.address = addressFromSocketPath(this.socketPath);
    this.handle = handleForSocketPath(this.socketPath);
    this.ref = refForSocketPath(this.socketPath);
    this.sessionId = options.sessionId ?? randomUUID();
    this.selfToken = options.selfToken ?? randomUUID();
    this.#cwd = options.cwd ?? process.cwd();
    this.#kind = options.kind ?? "bg";
    this.#status = options.status ?? "idle";
    this.#receiptStatus = options.receiptStatus ?? "delivered";
    this.name = options.name ?? `${basename(this.#cwd)}-${process.pid}`;
    this.startedAt = Date.now();

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

    const dir = dirname(this.socketPath);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await enforceOwnerOnlyDir(dir);
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

    // The socket must be owner-only; the process umask is not enough.
    await chmod(this.socketPath, SOCKET_FILE_MODE);

    server.unref();
    server.on("error", (error: Error) => this.emit("error", error));
    this.#server = server;

    const registered = await writeSessionRecord(
      {
        pid: process.pid,
        procStart: processStartTime(),
        startedAt: this.startedAt,
        cwd: this.#cwd,
        sessionId: this.sessionId,
        name: this.name,
        kind: this.#kind,
        status: this.#status,
        messagingSocketPath: this.socketPath,
        peerProtocol: 1,
      },
      this.configDir,
    );

    if (!registered) {
      this.emit("error", new Error("Failed to write session registry record"));
    }

    this.#started = true;
  }

  /** Deregister, close the socket, and remove the socket file. */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;

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

    await removeSessionRecord(process.pid, this.configDir);
    await unlink(this.socketPath).catch(() => {});
  }

  /** Live peers, excluding this daemon. */
  listPeers(): Promise<Peer[]> {
    return listPeers(this.configDir, process.pid);
  }

  /** Update the display name in the registry, as `/rename` does. */
  async rename(name: string): Promise<void> {
    this.name = name;
    await this.#publish();
  }

  /** Update the status peers see in listings. */
  async setStatus(status: SessionStatus): Promise<void> {
    this.#status = status;
    await this.#publish();
  }

  async #publish(): Promise<void> {
    await writeSessionRecord(
      {
        pid: process.pid,
        procStart: processStartTime(),
        startedAt: this.startedAt,
        cwd: this.#cwd,
        sessionId: this.sessionId,
        name: this.name,
        kind: this.#kind,
        status: this.#status,
        messagingSocketPath: this.socketPath,
        peerProtocol: 1,
      },
      this.configDir,
    );
  }

  /**
   * Send a message to a peer. Returns the generated message id, which the
   * peer echoes back in its receipt.
   */
  async send(
    target: string | Peer,
    text: string,
    options: SendOptions = {},
  ): Promise<{ msgId: string }> {
    // A string target may be a bare path or a `uds:` address.
    const socketPath =
      typeof target === "string"
        ? (socketPathFromAddress(target) ?? target)
        : target.messagingSocketPath;

    const envelope = buildEnvelope({
      from: this.address,
      ...(options.omitHopChain ? {} : { hopChain: [this.hopId] }),
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
      ...(options.files?.length ? { file_attachments: options.files } : {}),
    };

    await this.#write(socketPath, frame);
    return { msgId: frame.msg_id };
  }

  /** Send a receipt for a message we received. */
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

    const frame: ReceiptFrame = {
      type: "control",
      action: "peer_message_status",
      status,
      from: this.address,
      ...(origMsgId !== undefined ? { orig_msg_id: origMsgId } : {}),
    };

    await this.#write(socketPath, frame).catch(() => {});
  }

  async #write(socketPath: string, frame: Frame): Promise<void> {
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

      socket.setTimeout(SEND_TIMEOUT_MS, () =>
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
    const decoder = new FrameDecoder((frame) => {
      void this.#handleFrame(frame).catch((error: unknown) => {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      });
    });

    socket.on("data", (chunk: Buffer) => {
      if (!decoder.push(chunk)) socket.destroy();
    });

    // The server listens with `allowHalfOpen`, so a peer that ends its side
    // leaves this one open. Close it in turn, otherwise the sender never sees
    // `close` and its send promise never settles.
    socket.on("end", () => socket.end());
    socket.on("error", () => socket.destroy());
  }

  async #handleFrame(frame: Frame): Promise<void> {
    if (isReceiptFrame(frame)) {
      this.emit("receipt", {
        status: frame.status,
        from: frame.from,
        ...(frame.orig_msg_id !== undefined ? { origMsgId: frame.orig_msg_id } : {}),
        frame,
      });
      return;
    }

    if (!isUserFrame(frame)) return;

    const envelope = parseEnvelope(frame.message.content);
    if (!envelope) return;

    const from = envelope.from ?? frame.from ?? "";
    if (from === this.address) return; // self-echo
    if (envelope.hopChain?.includes(this.hopId)) return; // loop

    this.emit("message", {
      from,
      ...(envelope.fromName !== undefined ? { fromName: envelope.fromName } : {}),
      ...(envelope.fromMode !== undefined ? { fromMode: envelope.fromMode } : {}),
      ...(envelope.hopChain !== undefined ? { hopChain: envelope.hopChain } : {}),
      body: envelope.body,
      ...(frame.msg_id !== undefined ? { msgId: frame.msg_id } : {}),
      frame,
      envelope,
    });

    if (from) await this.sendReceipt(from, this.#receiptStatus, frame.msg_id);
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

async function enforceOwnerOnlyDir(dir: string): Promise<void> {
  const stats = await lstat(dir);
  if ((stats.mode & 0o777) !== DIR_MODE) await chmod(dir, DIR_MODE);
}
