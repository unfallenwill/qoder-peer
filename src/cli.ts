#!/usr/bin/env node
/**
 * qpeer — talk to Qoder CLI sessions over their cross-session socket protocol.
 */

import { parseArgs } from "node:util";

import {
  PeerDaemon,
  type InboundMessage,
  type InboundPolicyOptions,
  type PeerDaemonOptions,
} from "./peer.ts";
import {
  isDialogEligible,
  isInboundPolicy,
  type InboundPolicy,
  type PermissionMode,
} from "./policy.ts";
import type { HeldMessage } from "./held.ts";
import { globalConfigDir, listPeers, resolveTarget, type Peer } from "./registry.ts";

const USAGE = `qpeer — drive Qoder CLI sessions over their cross-session socket

Usage:
  qpeer list [options]                       List reachable Qoder sessions
  qpeer send <target> <text...> [options]    Send a message and wait for the reply
  qpeer watch [options]                      Stay registered; print inbound messages
                                             and review held ones from stdin
  qpeer self [options]                       Print this tool's own identity

Targets:
  a handle (-3f), a "name [ref]" pair, a session name, a socket path,
  or a full uds: address. Run \`qpeer list\` to see what is reachable.

Options:
  --socket <path>          Bind to a specific socket path
  --config-dir <dir>       Use a different Qoder config root
  --name <name>            Display name for this session
  --attach <path>          Attach a file to the message (repeatable, max 10)
  --inbound-policy <p>     accept | hold | refuse (overrides settings)
  --permission-mode <m>    bypass | prompting (default prompting)
  --expiry-ms <ms>         How long a held message waits (default from settings)
  --held-max <n>           Held queue capacity before the oldest expires
  --reply-ms <ms>          How long to wait for a reply after sending (default 120000)
  --receipt-ms <ms>        How long to wait for the delivery receipt (default 5000)
  --no-reply               Send and exit without waiting for a reply
  --no-receipt             Do not wait for the delivery receipt either
  --json                   Machine-readable output
  -h, --help               Show this help

In watch, review a held message by typing "a <id>" to approve or "d <id>" to deny.
The queue lives in this process, so approving has to happen here rather than in
a separate invocation.
`;

interface Options {
  socket?: string;
  configDir: string;
  name?: string;
  attachments: string[];
  inboundPolicy?: InboundPolicy;
  permissionMode?: PermissionMode;
  expiryMs?: number;
  heldMax?: number;
  replyMs: number;
  receiptMs: number;
  waitReply: boolean;
  waitReceipt: boolean;
  json: boolean;
}

const ERROR_NO_TARGET = 2;

/**
 * Handles look like `-3f`, which collides with option syntax. Insert a `--`
 * separator so the handle is treated as a positional. Options must therefore
 * come before the target, which the usage text already implies.
 */
function normalizeArgv(argv: string[]): string[] {
  if (argv.includes("--")) return argv;

  const index = argv.findIndex((token) => /^-[0-9a-f]{2}$/.test(token));
  if (index === -1) return argv;

  return [...argv.slice(0, index), "--", ...argv.slice(index)];
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: normalizeArgv(argv),
    allowPositionals: true,
    strict: true,
    options: {
      socket: { type: "string" },
      "config-dir": { type: "string" },
      name: { type: "string" },
      attach: { type: "string", multiple: true, default: [] },
      "inbound-policy": { type: "string" },
      "permission-mode": { type: "string" },
      "expiry-ms": { type: "string" },
      "held-max": { type: "string" },
      "reply-ms": { type: "string" },
      "receipt-ms": { type: "string" },
      "no-reply": { type: "boolean", default: false },
      "no-receipt": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const inboundPolicy = values["inbound-policy"];
  if (inboundPolicy !== undefined && !isInboundPolicy(inboundPolicy)) {
    process.stderr.write(
      `--inbound-policy must be accept, hold or refuse (got "${inboundPolicy}")\n`,
    );
    return 1;
  }

  const permissionMode = values["permission-mode"];
  if (
    permissionMode !== undefined &&
    permissionMode !== "bypass" &&
    permissionMode !== "prompting"
  ) {
    process.stderr.write(
      `--permission-mode must be bypass or prompting (got "${permissionMode}")\n`,
    );
    return 1;
  }

  const options: Options = {
    ...(values.socket ? { socket: values.socket } : {}),
    configDir: values["config-dir"] ?? globalConfigDir(),
    ...(values.name ? { name: values.name } : {}),
    attachments: values.attach,
    ...(inboundPolicy !== undefined ? { inboundPolicy } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(values["expiry-ms"] !== undefined
      ? { expiryMs: toMs(values["expiry-ms"], 0) }
      : {}),
    ...(values["held-max"] !== undefined
      ? { heldMax: toMs(values["held-max"], 100) }
      : {}),
    replyMs: toMs(values["reply-ms"], 120_000),
    receiptMs: toMs(values["receipt-ms"], 5_000),
    waitReply: !values["no-reply"],
    waitReceipt: !values["no-receipt"],
    json: values.json,
  };

  const [command, ...rest] = positionals;

  switch (command) {
    case "list":
      return await runList(options);
    case "self":
      return await runSelf(options);
    case "send":
      return await runSend(rest, options);
    case "watch":
      return await runWatch(options);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

// ---------------------------------------------------------------------------

async function runList(options: Options): Promise<number> {
  const peers = await listPeers(options.configDir);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(peers, null, 2)}\n`);
    return 0;
  }

  if (peers.length === 0) {
    process.stdout.write("No reachable Qoder sessions.\n");
    return 0;
  }

  process.stdout.write(`Qoder sessions (${peers.length}):\n`);
  for (const peer of peers) {
    process.stdout.write(`${formatPeer(peer)}\n`);
  }
  return 0;
}

function formatPeer(peer: Peer): string {
  const label = peer.name ?? "(untitled)";
  const status = peer.status ?? "?";
  const kind = peer.kind ?? "?";
  const age = humanizeAge(Date.now() - peer.startedAt);
  return [
    `  ${label} [${peer.ref}]`,
    `handle -${peer.handle}`,
    `${kind}/${status}`,
    `pid ${peer.pid}`,
    `started ${age} ago`,
    peer.cwd,
  ].join("  ");
}

async function runSelf(options: Options): Promise<number> {
  const daemon = new PeerDaemon(optionsToDaemon(options));
  const info = {
    socketPath: daemon.socketPath,
    address: daemon.address,
    handle: daemon.handle,
    ref: daemon.ref,
    hopId: daemon.hopId,
    sessionId: daemon.sessionId,
    selfToken: daemon.selfToken,
    name: daemon.name,
    configDir: daemon.configDir,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    [
      `name         ${info.name}`,
      `handle       -${info.handle}`,
      `ref          ${info.ref}`,
      `socket       ${info.socketPath}`,
      `address      ${info.address}`,
      `hop id       ${info.hopId}`,
      `session id   ${info.sessionId}`,
      `self token   ${info.selfToken}`,
      `config dir   ${info.configDir}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function runSend(positionals: string[], options: Options): Promise<number> {
  if (positionals.length < 2) {
    process.stderr.write(`send requires a target and a message\n\n${USAGE}`);
    return 1;
  }

  const [targetName, ...words] = positionals;
  const text = words.join(" ");

  const daemon = new PeerDaemon(optionsToDaemon(options));
  await daemon.start();

  const cleanup = (): Promise<void> => daemon.stop();
  process.once("SIGINT", () => void cleanup().then(() => process.exit(130)));

  try {
    const peers = await daemon.listPeers();
    const resolved = resolveTarget(targetName!, peers);

    if (!resolved.peer) {
      // Fail loudly rather than silently dropping the message.
      const message = resolved.stale
        ? `No live Qoder session matches "${targetName}". Run \`qpeer list\`.`
        : `Could not resolve "${targetName}".`;
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      } else {
        process.stderr.write(`${message}\n`);
      }
      return ERROR_NO_TARGET;
    }

    const peer = resolved.peer;
    const { msgId, rejected } = await daemon.send(peer, text, {
      senderName: daemon.name,
      ...(options.attachments.length ? { files: options.attachments } : {}),
    });

    if (rejected.length > 0) {
      process.stderr.write(`Not attached: ${rejected.join(", ")}.\n`);
    }

    if (!options.json) {
      process.stderr.write(
        `Sent to ${peer.name ?? "(untitled)"} [${peer.ref}] as ${msgId}\n`,
      );
    }

    const receipt = options.waitReceipt
      ? (await daemon.waitForReceipt(msgId, options.receiptMs))?.status
      : undefined;

    if (receipt && !options.json) {
      process.stderr.write(`Receipt: ${receipt}\n`);
    }

    if (!options.waitReply) {
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, to: peer.ref, msgId, receipt })}\n`,
        );
      }
      return 0;
    }

    const reply = await waitForReply(daemon, peer, options.replyMs);

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          to: peer.ref,
          msgId,
          receipt,
          reply: reply?.body ?? null,
        })}\n`,
      );
      return reply ? 0 : 1;
    }

    if (reply) {
      process.stdout.write(`${reply.body}\n`);
      return 0;
    }

    process.stderr.write(`Timed out waiting for a reply after ${options.replyMs}ms.\n`);
    return 1;
  } finally {
    await daemon.stop();
  }
}

type WatchEvent =
  | { kind: "message"; message: InboundMessage }
  | { kind: "receipt"; status: string; from: string; origMsgId?: string; wasHeld: boolean }
  | { kind: "held"; message: HeldMessage }
  | { kind: "dropped"; from: string; reason: string; suppressed: number };

async function runWatch(options: Options): Promise<number> {
  // A watcher exists to stay bound, so it must hold the event loop open. It is
  // also the only subcommand with somewhere to review a held message, which is
  // what lets a posture-derived hold stay a hold instead of becoming a refusal.
  const daemon = new PeerDaemon(
    optionsToDaemon(options, { keepAlive: true }, { reviewSurface: true }),
  );
  await daemon.start();

  const emit = (event: WatchEvent): void => {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }

    switch (event.kind) {
      case "message": {
        const who = event.message.fromName ?? event.message.from;
        const self = event.message.selfSent ? " (sent by this session)" : "";
        const files = event.message.attachments.length
          ? `\n(${event.message.attachments.length} attachment(s) copied into this session)`
          : "";
        process.stdout.write(`\n[from ${who}${self}]${files}\n${event.message.body}\n`);
        return;
      }
      case "held": {
        // Upstream prompts only for some causes; the rest are held silently and
        // reviewed on demand. Say which is which.
        const prompted = isDialogEligible(event.message.cause);
        process.stdout.write(
          `\n[held ${event.message.id}] ${event.message.cause} · ` +
            `from ${event.message.fromName ?? event.message.from}` +
            `${prompted ? "" : " · would not prompt upstream"}\n` +
            `  ${preview(event.message.body)}\n` +
            `  approve: a ${event.message.id}   deny: d ${event.message.id}\n`,
        );
        return;
      }
      case "dropped":
        process.stderr.write(
          `[dropped] from ${event.from}: ${event.reason}` +
            `${event.suppressed > 0 ? ` (${event.suppressed} similar suppressed)` : ""}\n`,
        );
        return;
      case "receipt":
        process.stdout.write(
          `[receipt ${event.status} from ${event.from}` +
            `${event.origMsgId ? ` for ${event.origMsgId}` : ""}` +
            `${event.wasHeld ? " (previously held)" : ""}]\n`,
        );
    }
  };

  daemon.on("message", (message) => emit({ kind: "message", message }));
  daemon.on("receipt", (receipt) => emit({ kind: "receipt", ...receipt }));
  daemon.on("held", (message) => emit({ kind: "held", message }));
  daemon.on("dropped", (event) => emit({ kind: "dropped", ...event }));
  daemon.on("error", (error) => process.stderr.write(`[error] ${error.message}\n`));

  if (!options.json) {
    process.stderr.write(
      `watching as ${daemon.name} (handle -${daemon.handle}) on ${daemon.socketPath}\n` +
        `peers can reach you with: qpeer send -${daemon.handle} "..."\n` +
        `review a held message with "a <id>" or "d <id>"\n`,
    );
  }

  // The hold queue lives in this process, so a decision has to be typed here.
  const stopReading = readApprovalCommands(daemon);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  stopReading();
  await daemon.stop();
  return 0;
}

/** Read `a <id>` / `d <id>` lines from stdin until it closes. */
function readApprovalCommands(daemon: PeerDaemon): () => void {
  const onData = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split("\n")) {
      const [verb, id] = line.trim().split(/\s+/);
      if (!verb || !id) continue;

      const approving = verb === "a" || verb === "approve";
      const denying = verb === "d" || verb === "deny";
      if (!approving && !denying) continue;

      const resolved = approving ? daemon.approve(id) : daemon.deny(id);
      process.stderr.write(
        resolved
          ? `${approving ? "Approved" : "Denied"} ${id}\n`
          : `No held message with id ${id}\n`,
      );
    }
  };

  process.stdin.on("data", onData);
  process.stdin.resume();

  return () => {
    process.stdin.off("data", onData);
    process.stdin.pause();
  };
}

function preview(body: string, limit = 200): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

// ---------------------------------------------------------------------------

function waitForReply(
  daemon: PeerDaemon,
  peer: Peer,
  timeoutMs: number,
): Promise<InboundMessage | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      daemon.off("message", onMessage);
      resolve(undefined);
    }, timeoutMs);

    const onMessage = (message: InboundMessage): void => {
      // Accept only replies from the session we wrote to.
      const fromPath = message.from.startsWith("uds:")
        ? message.from.slice("uds:".length)
        : message.from;
      if (fromPath !== peer.messagingSocketPath && message.from !== peer.address) return;
      clearTimeout(timer);
      daemon.off("message", onMessage);
      resolve(message);
    };

    daemon.on("message", onMessage);
  });
}

function optionsToDaemon(
  options: Options,
  extra: Partial<PeerDaemonOptions> = {},
  inboundExtra: InboundPolicyOptions = {},
): ConstructorParameters<typeof PeerDaemon>[0] {
  return {
    ...(options.socket ? { socketPath: options.socket } : {}),
    configDir: options.configDir,
    ...(options.name ? { name: options.name } : {}),
    ...extra,
    inbound: {
      ...(options.inboundPolicy !== undefined ? { policy: options.inboundPolicy } : {}),
      ...(options.permissionMode !== undefined
        ? { permissionMode: options.permissionMode }
        : {}),
      ...(options.expiryMs !== undefined ? { expiryMs: options.expiryMs } : {}),
      ...(options.heldMax !== undefined ? { maxHeld: options.heldMax } : {}),
      ...inboundExtra,
    },
  };
}

function toMs(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function humanizeAge(deltaMs: number): string {
  const seconds = Math.max(0, Math.round(deltaMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
