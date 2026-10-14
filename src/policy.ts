/**
 * Inbound policy: deciding what to do with a message that arrives from a peer.
 *
 * Three outcomes exist — accept it, hold it for a decision, or refuse it. The
 * decision is made in two stages: an explicit setting wins outright, otherwise
 * a default is derived from this session's permission posture and what the
 * sender asserted about its own. Holds that cannot be surfaced for a decision
 * are downgraded to a refusal so the sender always gets an answer.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_DIALOG_EXPIRY_MS } from "./protocol.ts";
import { globalConfigDir } from "./registry.ts";

export type InboundPolicy = "accept" | "hold" | "refuse";

export const INBOUND_POLICIES: readonly InboundPolicy[] = ["accept", "hold", "refuse"];

/** Higher rank is stricter. A project setting may only raise the rank. */
const STRICTNESS: Record<InboundPolicy, number> = { accept: 0, hold: 1, refuse: 2 };

export type PolicyScope = "flag" | "user" | "project";

/** Who owns the setting that was applied. */
export type PolicySource = "user" | "repo";

export type PolicyCause =
  | "explicit-setting"
  | "repo-setting"
  | "self-sent"
  | "mode-unknown"
  | "default-accept"
  | "mode-mismatch"
  | "no-mode-asserted"
  | "no-review-surface";

export interface ResolvedSetting {
  policy: InboundPolicy;
  source: PolicySource;
  scope: PolicyScope;
  path?: string;
}

export interface PolicyDecision {
  policy: InboundPolicy;
  cause: PolicyCause;
}

export interface PolicyHints {
  /** The message carries this session's own token, so it originated here. */
  selfSent?: boolean;
  /** The posture the sender asserted for itself. */
  fromMode?: PermissionMode;
}

export type PermissionMode = "bypass" | "prompting";

export interface EvaluatePolicyOptions {
  /** This session's own posture. Undefined means it is not known yet. */
  permissionMode?: PermissionMode;
  /** Whether a hold can be put in front of someone for a decision. */
  reviewSurface: boolean;
  /** An explicit setting, if one resolved. */
  setting?: ResolvedSetting;
  /** Whether a sender's `fromMode` assertion is honoured. */
  modeEmit?: boolean;
}

export function isInboundPolicy(value: unknown): value is InboundPolicy {
  return typeof value === "string" && (INBOUND_POLICIES as readonly string[]).includes(value);
}

/**
 * Holds with these causes are derived from posture rather than from an explicit
 * setting, so they are the ones a missing review surface degrades.
 */
const MODE_DERIVED_CAUSES: readonly PolicyCause[] = [
  "mode-mismatch",
  "mode-unknown",
  "no-mode-asserted",
];

/**
 * Holds that may raise an approval prompt. Anything else holds silently and is
 * reviewed on demand.
 */
const DIALOG_ELIGIBLE_CAUSES: readonly PolicyCause[] = [
  "mode-mismatch",
  "no-mode-asserted",
  "repo-setting",
];

export function isDialogEligible(cause: PolicyCause): boolean {
  return DIALOG_ELIGIBLE_CAUSES.includes(cause);
}

// ---------------------------------------------------------------------------
// Stage 1: the explicit setting
// ---------------------------------------------------------------------------

export interface UserSettings {
  policy?: InboundPolicy;
  /** `general.dialogExpiry`, one of `60s | 5m | 10m | never`. */
  dialogExpiry?: string;
}

export interface ResolveInboundOptions {
  /** An explicit value, equivalent to the CLI flag. Highest priority. */
  flag?: InboundPolicy;
  /** Parsed user-level settings. */
  user?: UserSettings;
  /** Parsed project-level policy, if any. */
  project?: InboundPolicy;
  userPath?: string;
  projectPath?: string;
}

/**
 * Apply the settings chain: an explicit flag wins, then the user's own settings,
 * and finally the repository's — but only when the repository is *stricter*.
 * A repository can tighten its own sessions' policy, never loosen it.
 */
export function resolveInboundPolicy(
  options: ResolveInboundOptions = {},
): ResolvedSetting | undefined {
  let chosen: ResolvedSetting | undefined;

  if (options.flag) {
    // A flag names no file, so it carries no path — unlike the settings sources.
    chosen = { policy: options.flag, source: "user", scope: "flag" };
  }

  if (!chosen && options.user?.policy) {
    chosen = {
      policy: options.user.policy,
      source: "user",
      scope: "user",
      ...(options.userPath !== undefined ? { path: options.userPath } : {}),
    };
  }

  const project = options.project;
  if (project && STRICTNESS[project] > STRICTNESS[chosen?.policy ?? "accept"]) {
    chosen = {
      policy: project,
      source: "repo",
      scope: "project",
      ...(options.projectPath !== undefined ? { path: options.projectPath } : {}),
    };
  }

  return chosen;
}

// ---------------------------------------------------------------------------
// Stage 2: the derived default
// ---------------------------------------------------------------------------

/**
 * Decide what to do with an inbound message.
 *
 * Order: an explicit setting, then a message this session sent itself, then a
 * comparison against the sender's asserted posture, and finally a posture-based
 * default. When no review surface exists, posture-derived holds become refusals.
 */
export function evaluateInboundPolicy(
  hints: PolicyHints,
  options: EvaluatePolicyOptions,
): PolicyDecision {
  return downgradeWithoutReview(derive(hints, options), options.reviewSurface);
}

function derive(hints: PolicyHints, options: EvaluatePolicyOptions): PolicyDecision {
  if (options.setting) {
    return {
      policy: options.setting.policy,
      cause: options.setting.source === "repo" ? "repo-setting" : "explicit-setting",
    };
  }

  // A message carrying our own token came from us; accept it unconditionally.
  if (hints.selfSent) return { policy: "accept", cause: "self-sent" };

  const mode = options.permissionMode;
  if (mode === undefined) return { policy: "hold", cause: "mode-unknown" };

  const asserted = options.modeEmit ? hints.fromMode : undefined;
  if (asserted !== undefined) {
    return asserted === mode
      ? { policy: "accept", cause: "default-accept" }
      : { policy: "hold", cause: "mode-mismatch" };
  }

  return mode === "bypass"
    ? { policy: "hold", cause: "no-mode-asserted" }
    : { policy: "accept", cause: "default-accept" };
}

function downgradeWithoutReview(decision: PolicyDecision, reviewSurface: boolean): PolicyDecision {
  if (reviewSurface) return decision;
  if (decision.policy !== "hold") return decision;
  // An explicit or repository setting is a deliberate decision; honour it.
  if (!MODE_DERIVED_CAUSES.includes(decision.cause)) return decision;
  return { policy: "refuse", cause: "no-review-surface" };
}

// ---------------------------------------------------------------------------
// Settings files
// ---------------------------------------------------------------------------

export function userSettingsPath(configDir: string = globalConfigDir()): string {
  return join(configDir, "settings.json");
}

export function projectSettingsPath(cwd: string = process.cwd()): string {
  return join(cwd, ".qoder", "settings.json");
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read the policy and dialog expiry from a settings object. */
export function readSettings(settings: Record<string, unknown> | undefined): UserSettings {
  if (!settings) return {};

  const policy = (settings["security"] as Record<string, unknown> | undefined)?.[
    "crossSessionInbound"
  ];
  const dialogExpiry = (settings["general"] as Record<string, unknown> | undefined)?.[
    "dialogExpiry"
  ];

  return {
    ...(isInboundPolicy(policy) ? { policy } : {}),
    ...(typeof dialogExpiry === "string" ? { dialogExpiry } : {}),
  };
}

export async function loadUserSettings(path: string = userSettingsPath()): Promise<UserSettings> {
  return readSettings(await readJson(path));
}

export async function loadProjectPolicy(
  path: string = projectSettingsPath(),
): Promise<InboundPolicy | undefined> {
  return readSettings(await readJson(path)).policy;
}

// ---------------------------------------------------------------------------
// Dialog expiry
// ---------------------------------------------------------------------------

const CONFIGURED_EXPIRY: Record<string, number> = {
  "60s": 60_000,
  "5m": 300_000,
  "10m": 600_000,
  never: 0,
};

export interface DialogExpiryOptions {
  /** An explicit override, equivalent to a flag. */
  expiryMs?: number;
  /** `general.dialogExpiry` from the user's own settings. */
  configured?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve how long a held message waits before it expires.
 *
 * Priority: `QODER_USER_DIALOG_TIMEOUT_MS`, then an explicit override, then the
 * configured value, then the default. A resolved value of zero — whether from
 * `never` or an explicit zero — still gets the default, because one unanswered
 * prompt must not suppress every later one.
 */
export function resolveDialogExpiryMs(options: DialogExpiryOptions = {}): number {
  const env = options.env ?? process.env;
  const fromEnv = readEnvMs(env["QODER_USER_DIALOG_TIMEOUT_MS"]);

  let resolved: number;
  if (fromEnv !== undefined) {
    resolved = fromEnv;
  } else if (options.expiryMs !== undefined) {
    resolved = options.expiryMs;
  } else if (
    options.configured !== undefined &&
    // Own keys only: `"toString" in CONFIGURED_EXPIRY` is true via the
    // prototype, which would yield a function as the timeout.
    Object.hasOwn(CONFIGURED_EXPIRY, options.configured)
  ) {
    resolved = CONFIGURED_EXPIRY[options.configured]!;
  } else {
    resolved = DEFAULT_DIALOG_EXPIRY_MS;
  }

  return resolved === 0 ? DEFAULT_DIALOG_EXPIRY_MS : resolved;
}

function readEnvMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
