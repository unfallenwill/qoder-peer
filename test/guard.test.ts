import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DropReporter, type DropEvent, type DropReason } from "../src/guard.ts";
import {
  GUARD_MAX_KEYS,
  GUARD_MAX_REPORTS,
  GUARD_WINDOW_MS,
} from "../src/protocol.ts";

const REASONS: DropReason[] = [
  "invalid-envelope",
  "self-echo",
  "loop-detected",
  "invalid-frame",
  "oversized",
  "refused",
];

/**
 * A clock that only moves when a test says so. It starts at a realistic epoch
 * so that the guard's very first report sees an elapsed window, exactly as it
 * would against `Date.now()`.
 */
function fakeClock(start: number = 1_700_000_000_000) {
  let current = start;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

interface HarnessOptions {
  windowMs?: number;
  maxReports?: number;
  maxKeys?: number;
}

/** A reporter wired to a fake clock, recording both callbacks. */
function harness(options: HarnessOptions = {}) {
  const clock = fakeClock();
  const drops: DropEvent[] = [];
  const rollovers: number[] = [];
  const reporter = new DropReporter({
    now: clock.now,
    onDrop: (event) => drops.push(event),
    onWindowRollover: (suppressed) => rollovers.push(suppressed),
    ...options,
  });
  return { clock, drops, rollovers, reporter };
}

// ---------------------------------------------------------------------------

describe("de-duplication", () => {
  it("reports a new key once and folds the repeats into the next report", () => {
    const { clock, drops, reporter } = harness();

    assert.equal(reporter.report("uds:/a", "self-echo"), true);
    assert.equal(reporter.report("uds:/a", "self-echo"), false);
    assert.equal(reporter.report("uds:/a", "self-echo"), false);

    assert.deepEqual(drops, [{ from: "uds:/a", reason: "self-echo", suppressed: 0 }]);

    // Once the per-key window lapses the key is reported again, carrying the
    // number of drops that were swallowed in between.
    clock.advance(GUARD_WINDOW_MS);
    assert.equal(reporter.report("uds:/a", "self-echo"), true);

    assert.deepEqual(drops[1], {
      from: "uds:/a",
      reason: "self-echo",
      suppressed: 2,
    });
  });

  it("keys on both the origin and the reason", () => {
    const { drops, reporter } = harness();

    assert.equal(reporter.report("uds:/a", "self-echo"), true);
    assert.equal(reporter.report("uds:/b", "self-echo"), true);
    assert.equal(reporter.report("uds:/a", "refused"), true);
    assert.equal(reporter.report("uds:/a", "self-echo"), false);

    assert.equal(drops.length, 3);
  });

  it("keeps every reason distinct", () => {
    const { drops, reporter } = harness();

    for (const reason of REASONS) {
      assert.equal(reporter.report("uds:/a", reason), true);
    }
    assert.equal(drops.length, REASONS.length);

    for (const reason of REASONS) {
      assert.equal(reporter.report("uds:/a", reason), false);
    }
    assert.equal(drops.length, REASONS.length);
  });

  it("holds a key until the window has fully elapsed", () => {
    const { clock, drops, reporter } = harness();

    reporter.report("uds:/a", "refused");
    clock.advance(GUARD_WINDOW_MS - 1);
    assert.equal(reporter.report("uds:/a", "refused"), false);

    clock.advance(1);
    assert.equal(reporter.report("uds:/a", "refused"), true);
    assert.equal(drops[1]!.suppressed, 1);
  });

  it("ignores any injected delay: the clock alone decides", () => {
    const { reporter } = harness();
    assert.equal(reporter.report("uds:/a", "refused"), true);
    assert.equal(reporter.report("uds:/a", "refused"), false);
    assert.equal(reporter.report("uds:/a", "refused"), false);
  });
});

describe("report budget", () => {
  it("emits up to maxReports per window and only counts the rest", () => {
    const { drops, rollovers, reporter } = harness({ maxReports: 3 });

    assert.equal(reporter.report("uds:/a", "refused"), true);
    assert.equal(reporter.report("uds:/b", "refused"), true);
    assert.equal(reporter.report("uds:/c", "refused"), true);
    assert.equal(reporter.report("uds:/d", "refused"), false);
    assert.equal(reporter.report("uds:/e", "refused"), false);

    assert.equal(drops.length, 3);
    assert.deepEqual(rollovers, []);
  });

  it("summarises the over-budget drops at the next rollover", () => {
    const { clock, drops, rollovers, reporter } = harness({ maxReports: 3 });

    for (const from of ["uds:/a", "uds:/b", "uds:/c", "uds:/d", "uds:/e"]) {
      reporter.report(from, "refused");
    }

    // The rollover is announced by the first report of the new window, not by
    // a timer, and only when the previous window actually suppressed something.
    clock.advance(GUARD_WINDOW_MS);
    assert.equal(reporter.report("uds:/f", "refused"), true);

    assert.deepEqual(rollovers, [2]);
    assert.equal(drops.length, 4);
  });

  it("stays quiet about a window that suppressed nothing", () => {
    const { clock, rollovers, reporter } = harness({ maxReports: 3 });

    reporter.report("uds:/a", "refused");
    clock.advance(GUARD_WINDOW_MS);
    reporter.report("uds:/b", "refused");
    clock.advance(GUARD_WINDOW_MS);
    reporter.report("uds:/c", "refused");

    assert.deepEqual(rollovers, []);
  });

  it("restores the full budget after a rollover", () => {
    const { clock, reporter } = harness({ maxReports: 2 });

    reporter.report("uds:/a", "refused");
    reporter.report("uds:/b", "refused");
    assert.equal(reporter.report("uds:/c", "refused"), false);

    clock.advance(GUARD_WINDOW_MS);
    assert.equal(reporter.report("uds:/d", "refused"), true);
    assert.equal(reporter.report("uds:/e", "refused"), true);
    assert.equal(reporter.report("uds:/f", "refused"), false);
  });

  it("checks de-duplication before rolling the window over", () => {
    // A repeat is counted without advancing the window, so a pending rollover
    // summary is held back until a report that is not de-duplicated arrives.
    const windowMs = 1_000;
    const { clock, rollovers, reporter } = harness({ windowMs, maxReports: 2 });

    reporter.report("uds:/a", "refused"); // window opens at t
    clock.advance(900);
    reporter.report("uds:/b", "refused"); // budget now spent
    clock.advance(50);
    assert.equal(reporter.report("uds:/c", "refused"), false); // suppressed

    // The window has now elapsed, but this key was reported recently enough to
    // be de-duplicated, and that check short-circuits the rollover.
    clock.advance(50);
    assert.equal(reporter.report("uds:/b", "refused"), false);
    assert.deepEqual(rollovers, [], "a de-duplicated report must not roll over");

    // The first report that is not de-duplicated performs the rollover.
    assert.equal(reporter.report("uds:/d", "refused"), true);
    assert.deepEqual(rollovers, [1]);
  });
});

describe("key table", () => {
  it("evicts the oldest key once maxKeys is reached", () => {
    const { drops, reporter } = harness({ maxKeys: 2 });

    for (const from of ["uds:/a", "uds:/b", "uds:/c", "uds:/d"]) {
      assert.equal(reporter.report(from, "refused"), true);
    }
    assert.equal(drops.length, 4);

    // The two most recent keys are remembered; the first two are forgotten.
    assert.equal(reporter.report("uds:/c", "refused"), false);
    assert.equal(reporter.report("uds:/d", "refused"), false);
    assert.equal(reporter.report("uds:/a", "refused"), true);
    assert.equal(reporter.report("uds:/b", "refused"), true);
  });

  it("re-inserts a re-reported key instead of letting the table grow", () => {
    const { clock, reporter } = harness({ maxKeys: 1 });

    assert.equal(reporter.report("uds:/a", "refused"), true);

    // The window lapses, so the key is re-reported even though it is already
    // the oldest entry: it is evicted and re-inserted, and the table stays at
    // one entry, which is why `b` can evict it again immediately.
    clock.advance(GUARD_WINDOW_MS);
    assert.equal(reporter.report("uds:/a", "refused"), true);
    assert.equal(reporter.report("uds:/b", "refused"), true);
    assert.equal(reporter.report("uds:/a", "refused"), true);
  });
});

describe("reset", () => {
  it("forgets keys and restarts the window without flushing the summary", () => {
    const { drops, rollovers, reporter } = harness({ maxReports: 1 });

    reporter.report("uds:/a", "refused"); // budget spent
    assert.equal(reporter.report("uds:/b", "refused"), false); // suppressed -> 1

    reporter.reset();

    // The key is forgotten and the budget is whole again.
    assert.equal(reporter.report("uds:/a", "refused"), true);
    assert.equal(drops.length, 2);
    // The pending summary belonged to the window that was discarded.
    assert.deepEqual(rollovers, []);
  });

  it("clears the suppressed count attached to a key", () => {
    const { clock, drops, reporter } = harness();

    reporter.report("uds:/a", "refused");
    reporter.report("uds:/a", "refused");
    reporter.reset();

    reporter.report("uds:/a", "refused");
    clock.advance(GUARD_WINDOW_MS);
    reporter.report("uds:/a", "refused");

    assert.equal(drops.at(-1)!.suppressed, 0);
  });
});

describe("defaults", () => {
  it("uses the protocol window", () => {
    const { clock, reporter } = harness();

    assert.equal(reporter.report("uds:/a", "refused"), true);
    clock.advance(GUARD_WINDOW_MS - 1);
    assert.equal(reporter.report("uds:/a", "refused"), false);
    clock.advance(1);
    assert.equal(reporter.report("uds:/a", "refused"), true);
  });

  it("uses the protocol report budget", () => {
    const { drops, reporter } = harness();

    for (let n = 0; n < GUARD_MAX_REPORTS + 5; n += 1) {
      reporter.report(`uds:/p${n}`, "refused");
    }

    assert.equal(drops.length, GUARD_MAX_REPORTS);
  });

  it("uses the protocol key-table size", () => {
    const { reporter } = harness({ maxReports: 10_000 });

    for (let n = 0; n < GUARD_MAX_KEYS + 1; n += 1) {
      assert.equal(reporter.report(`uds:/k${n}`, "refused"), true);
    }

    // The first key fell out of the table; the last one is still cached.
    assert.equal(reporter.report("uds:/k0", "refused"), true);
    assert.equal(reporter.report(`uds:/k${GUARD_MAX_KEYS}`, "refused"), false);
  });

  it("works with the real clock when none is injected", () => {
    const reporter = new DropReporter({ onDrop: () => {} });

    assert.equal(reporter.report("uds:/a", "refused"), true);
    assert.equal(reporter.report("uds:/a", "refused"), false);
  });
});
