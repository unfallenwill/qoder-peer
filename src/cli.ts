#!/usr/bin/env node
/**
 * qpeer — talk to Qoder CLI sessions over their cross-session socket protocol.
 */

import { parseArgs } from "node:util";

import { PeerDaemon, type InboundMessage } from "./peer.ts";
import { globalConfigDir, listPeers, resolveTarget, type Peer } from "./registry.ts";

const USAGE = `qpeer — drive Qoder CLI sessions over their cross-session socket

Usage:
  qpeer list [options]                       List reachable Qoder sessions
  qpeer send <target> <text...> [options]    Send a message and wait for the reply
  qpeer watch [options]                      Stay registered and print inbound messages
  qpeer self [options]                       Print this tool's own identity

Targets:
  a handle (-3f), a "name [ref]" pair, a session name, a socket path,
  or a full uds: address. Run \`qpeer list\` to see what is reachable.

Options:
  --socket <path>       Bind to a specific socket path
  --config-dir <dir>    Use a different Qoder config root
  --name <name>         Display name for this session
  --reply-ms <ms>       How long to wait for a reply after sending (default 120000)
  --receipt-ms <ms>     How long to wait for the delivery receipt (default 5000)
  --no-reply            Send and exit without waiting for a reply
  --no-receipt          Do not wait for the delivery receipt either
  --json                Machine-readable output
  -h, --help            Show this help
`;

interface Options {
  socket?: string;
  configDir: string;
  name?: string;
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

  const options: Options = {
    ...(values.socket ? { socket: values.socket } : {}),
    configDir: values["config-dir"] ?? globalConfigDir(),
    ...(values.name ? { name: values.name } : {}),
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
    const { msgId } = await daemon.send(peer, text, { senderName: daemon.name });

    if (!options.json) {
      process.stderr.write(
        `Sent to ${peer.name ?? "(untitled)"} [${peer.ref}] as ${msgId}\n`,
      );
    }

    const receipt = options.waitReceipt
      ? await waitForReceipt(daemon, msgId, options.receiptMs)
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

async function runWatch(options: Options): Promise<number> {
  const daemon = new PeerDaemon(optionsToDaemon(options));
  await daemon.start();

  const emit = (payload: unknown): void => {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    const event = payload as
      | { kind: "message"; message: InboundMessage }
      | { kind: "receipt"; status: string; from: string; origMsgId?: string };
    if (event.kind === "message") {
      const who = event.message.fromName ?? event.message.from;
      process.stdout.write(`\n[from ${who}]\n${event.message.body}\n`);
    } else {
      process.stdout.write(
        `[receipt ${event.status} from ${event.from}${event.origMsgId ? ` for ${event.origMsgId}` : ""}]\n`,
      );
    }
  };

  daemon.on("message", (message) => emit({ kind: "message", message }));
  daemon.on("receipt", (receipt) => emit({ kind: "receipt", ...receipt }));

  if (!options.json) {
    process.stderr.write(
      `watching as ${daemon.name} (handle -${daemon.handle}) on ${daemon.socketPath}\n` +
        `peers can reach you with: qpeer send -${daemon.handle} "..."\n`,
    );
  }

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  await daemon.stop();
  return 0;
}

// ---------------------------------------------------------------------------

function waitForReceipt(
  daemon: PeerDaemon,
  msgId: string,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      daemon.off("receipt", onReceipt);
      resolve(undefined);
    }, timeoutMs);

    const onReceipt = (receipt: { status: string; origMsgId?: string }): void => {
      if (receipt.origMsgId !== msgId) return;
      clearTimeout(timer);
      daemon.off("receipt", onReceipt);
      resolve(receipt.status);
    };

    daemon.on("receipt", onReceipt);
  });
}

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

function optionsToDaemon(options: Options): ConstructorParameters<typeof PeerDaemon>[0] {
  return {
    ...(options.socket ? { socketPath: options.socket } : {}),
    configDir: options.configDir,
    ...(options.name ? { name: options.name } : {}),
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
