/**
 * The drop-report guard.
 *
 * A busy session can reject thousands of frames a second — malformed envelopes,
 * self-echoes, looped fan-out, oversized frames. Logging every one of them is
 * useless noise, so the CLI funnels them through a guard that does two things:
 *
 * - de-duplicates by `(from, reason)`, so the same peer failing the same way
 *   only produces one report per window plus a running "similar suppressed"
 *   count; and
 * - caps the number of reports per window, so a flood of *distinct* failures
 *   cannot drown out everything else either. Reports that lose the budget race
 *   are counted and summarised once at the next window rollover.
 *
 * Nothing here drops messages — the caller has already decided to drop. The
 * guard only rate-limits how often that decision is reported.
 *
 * Faithful port of the reference implementation: the window is anchored to the
 * timestamp of the first report after a rollover (not to `Date.now()` modulo
 * anything), the per-key de-duplication window is independent of the report
 * budget window, and only a call that survives de-duplication can advance or
 * roll over the window.
 *
 * The reference implementation writes its reports straight to the CLI's debug
 * log. That is deliberately not done here: the caller supplies {@link
 * DropReporterOptions.onDrop} and {@link DropReporterOptions.onWindowRollover}
 * and decides what to do with them. For reference, the messages the CLI emits
 * are formatted as:
 *
 *     [peer-guard] Dropped message from <from>: <reason> (N similar suppressed)
 *     [peer-guard] N further drop(s) suppressed in the previous window
 *
 * where the parenthesised suffix is present only when `suppressed > 0`.
 */

import {
  GUARD_MAX_KEYS,
  GUARD_MAX_REPORTS,
  GUARD_WINDOW_MS,
} from "./protocol.ts";

/** Why an inbound message was dropped. All reasons share one report budget. */
export type DropReason =
  | "invalid-envelope"
  | "self-echo"
  | "loop-detected"
  | "invalid-frame"
  | "oversized"
  | "refused";

export interface DropEvent {
  from: string;
  reason: DropReason;
  /** How many drops of this `(from, reason)` key were suppressed since it was last reported. */
  suppressed: number;
}

export interface DropReporterOptions {
  /** Length of the report window, in ms. Defaults to `GUARD_WINDOW_MS`. */
  windowMs?: number;
  /** Reports per window before further ones are only counted. Defaults to `GUARD_MAX_REPORTS`. */
  maxReports?: number;
  /** Distinct `(from, reason)` keys remembered. Defaults to `GUARD_MAX_KEYS`. */
  maxKeys?: number;
  /** Injectable clock, so tests need not depend on wall time. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Called with one event per report that is actually emitted, in the order the
   * reference implementation would have logged them. The reference text is
   * given in the module doc comment.
   */
  onDrop?: (event: DropEvent) => void;
  /**
   * Called when a new window opens after one in which reports were suppressed
   * by the budget, with the number suppressed. Not called for a window that
   * suppressed nothing, nor for the first window.
   */
  onWindowRollover?: (suppressed: number) => void;
}

/** Per-key de-duplication record. */
interface KeyState {
  /** Timestamp of the last emitted report for this key, used for the dedup window. */
  lastReportedAt: number;
  /** Drops seen since that report. Folded into the next report, then reset. */
  suppressed: number;
}

/**
 * Coalesces duplicate drop reports.
 *
 * ```ts
 * const guard = new DropReporter({ onDrop: (event) => log.warn(event) });
 * if (guard.report(frame.from ?? "unknown", "invalid-envelope")) {
 *   // the report was emitted; the caller need not do anything special
 * }
 * ```
 */
export class DropReporter {
  readonly #windowMs: number;
  readonly #maxReports: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #onDrop: ((event: DropEvent) => void) | undefined;
  readonly #onWindowRollover: ((suppressed: number) => void) | undefined;

  /** `(from, reason)` keys, in insertion order so the oldest can be evicted. */
  #keys = new Map<string, KeyState>();
  /** Start of the current budget window; the timestamp of its first report. */
  #windowStartedAt = 0;
  /** Reports emitted in the current window. */
  #reportsThisWindow = 0;
  /** Reports the budget denied in the current window, reported at the rollover. */
  #suppressedThisWindow = 0;

  // Written out longhand rather than as parameter properties, so the source can
  // be executed directly by Node's type stripping.
  constructor(options: DropReporterOptions = {}) {
    this.#windowMs = options.windowMs ?? GUARD_WINDOW_MS;
    this.#maxReports = options.maxReports ?? GUARD_MAX_REPORTS;
    this.#maxKeys = options.maxKeys ?? GUARD_MAX_KEYS;
    this.#now = options.now ?? (() => Date.now());
    this.#onDrop = options.onDrop;
    this.#onWindowRollover = options.onWindowRollover;
  }

  /**
   * Report one dropped message.
   *
   * Returns `true` when the report was actually emitted — `onDrop` has been
   * called. Returns `false` when it was folded into a recent report for the
   * same `(from, reason)` key, or when the window's report budget is spent; in
   * both cases the drop is still counted, so it shows up in a later
   * `suppressed` count.
   */
  report(from: string, reason: DropReason): boolean {
    const at = this.#now();
    // NUL cannot appear in either part, so the joined key is unambiguous.
    const key = `${from}\u0000${reason}`;
    const existing = this.#keys.get(key);

    // De-duplication wins over everything else: a repeat of a recently
    // reported key is counted even if the window is about to roll over.
    if (existing && at - existing.lastReportedAt < this.#windowMs) {
      existing.suppressed += 1;
      return false;
    }

    if (at - this.#windowStartedAt >= this.#windowMs) {
      if (this.#suppressedThisWindow > 0) {
        this.#onWindowRollover?.(this.#suppressedThisWindow);
      }
      this.#windowStartedAt = at;
      this.#reportsThisWindow = 0;
      this.#suppressedThisWindow = 0;
    }

    if (this.#reportsThisWindow >= this.#maxReports) {
      this.#suppressedThisWindow += 1;
      return false;
    }
    this.#reportsThisWindow += 1;

    // FIFO eviction keeps the key table bounded. It runs even when the key is
    // already present, so re-reporting the oldest key moves it to the back
    // rather than leaving the table over-full — same as the reference.
    if (this.#keys.size >= this.#maxKeys) {
      const oldest = this.#keys.keys().next();
      if (!oldest.done) this.#keys.delete(oldest.value);
    }

    const suppressed = existing?.suppressed ?? 0;
    this.#keys.set(key, { lastReportedAt: at, suppressed: 0 });

    this.#onDrop?.({ from, reason, suppressed });
    return true;
  }

  /** Forget every key and start a fresh window. Counters are not flushed. */
  reset(): void {
    this.#keys.clear();
    this.#windowStartedAt = 0;
    this.#reportsThisWindow = 0;
    this.#suppressedThisWindow = 0;
  }
}
