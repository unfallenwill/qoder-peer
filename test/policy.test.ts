import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INBOUND_POLICIES,
  evaluateInboundPolicy,
  isDialogEligible,
  isInboundPolicy,
  projectSettingsPath,
  readSettings,
  resolveDialogExpiryMs,
  resolveInboundPolicy,
  userSettingsPath,
  type InboundPolicy,
  type PolicyCause,
  type PolicyDecision,
  type PolicySource,
  type ResolvedSetting,
} from "../src/policy.ts";

/** The documented default dialog expiry (5m). */
const DEFAULT_EXPIRY_MS = 300_000;

/** An explicit setting, shaped the way `resolveInboundPolicy` would return it. */
function setting(policy: InboundPolicy, source: PolicySource = "user"): ResolvedSetting {
  return source === "repo"
    ? { policy, source, scope: "project", path: "/repo/.qoder/settings.json" }
    : { policy, source, scope: "user" };
}

/** A review surface is present unless a test says otherwise. */
function options(
  overrides: Partial<Parameters<typeof evaluateInboundPolicy>[1]> = {},
): Parameters<typeof evaluateInboundPolicy>[1] {
  return { permissionMode: "prompting", reviewSurface: true, ...overrides };
}

/** Environment with only the dialog timeout variable set, so process.env never leaks in. */
function envWithTimeout(value: string): NodeJS.ProcessEnv {
  return { QODER_USER_DIALOG_TIMEOUT_MS: value };
}

describe("isInboundPolicy", () => {
  it("accepts exactly the three known policies", () => {
    for (const policy of INBOUND_POLICIES) {
      assert.equal(isInboundPolicy(policy), true);
    }
    assert.deepEqual([...INBOUND_POLICIES], ["accept", "hold", "refuse"]);
  });

  it("rejects anything else", () => {
    assert.equal(isInboundPolicy("ACCEPT"), false);
    assert.equal(isInboundPolicy("allow"), false);
    assert.equal(isInboundPolicy(""), false);
    assert.equal(isInboundPolicy(undefined), false);
    assert.equal(isInboundPolicy(null), false);
    assert.equal(isInboundPolicy(0), false);
    assert.equal(isInboundPolicy({ policy: "accept" }), false);
  });
});

describe("isDialogEligible", () => {
  it("marks posture and repository holds as eligible", () => {
    for (const cause of ["mode-mismatch", "no-mode-asserted", "repo-setting"] as const) {
      assert.equal(isDialogEligible(cause), true, cause);
    }
  });

  it("leaves the silent holds and every non-hold cause out", () => {
    const ineligible: PolicyCause[] = [
      "explicit-setting",
      "self-sent",
      "mode-unknown",
      "default-accept",
      "no-review-surface",
    ];
    for (const cause of ineligible) {
      assert.equal(isDialogEligible(cause), false, cause);
    }
  });
});

describe("resolveInboundPolicy", () => {
  it("returns undefined when no source is configured", () => {
    assert.equal(resolveInboundPolicy(), undefined);
    assert.equal(resolveInboundPolicy({}), undefined);
    assert.equal(resolveInboundPolicy({ user: {}, userPath: "/home/u/.qoder/settings.json" }), undefined);
  });

  it("prefers the flag over the user setting", () => {
    assert.deepEqual(resolveInboundPolicy({ flag: "accept", user: { policy: "refuse" } }), {
      policy: "accept",
      source: "user",
      scope: "flag",
    });
  });

  it("uses the user setting when no flag is given", () => {
    assert.deepEqual(resolveInboundPolicy({ user: { policy: "hold" } }), {
      policy: "hold",
      source: "user",
      scope: "user",
    });
  });

  it("carries a path only for settings-file sources, never for a flag", () => {
    const path = "/home/u/.qoder/settings.json";

    // A flag names no file, so there is no path to report.
    assert.deepEqual(resolveInboundPolicy({ flag: "refuse", userPath: path }), {
      policy: "refuse",
      source: "user",
      scope: "flag",
    });

    assert.deepEqual(resolveInboundPolicy({ user: { policy: "hold" }, userPath: path }), {
      policy: "hold",
      source: "user",
      scope: "user",
      path,
    });

    const withoutPath = resolveInboundPolicy({ user: { policy: "hold" } });
    assert.notEqual(withoutPath, undefined);
    assert.equal(Object.hasOwn(withoutPath!, "path"), false);
  });

  it("applies a project setting that is stricter than the user's", () => {
    assert.deepEqual(
      resolveInboundPolicy({
        user: { policy: "accept" },
        project: "hold",
        projectPath: "/repo/.qoder/settings.json",
      }),
      {
        policy: "hold",
        source: "repo",
        scope: "project",
        path: "/repo/.qoder/settings.json",
      },
    );
    assert.deepEqual(resolveInboundPolicy({ user: { policy: "hold" }, project: "refuse" }), {
      policy: "refuse",
      source: "repo",
      scope: "project",
    });
  });

  it("applies a strict project setting even without a flag or user setting", () => {
    assert.deepEqual(resolveInboundPolicy({ project: "refuse", projectPath: "/repo/s.json" }), {
      policy: "refuse",
      source: "repo",
      scope: "project",
      path: "/repo/s.json",
    });
  });

  it("lets a strict project setting outrank the flag", () => {
    assert.deepEqual(resolveInboundPolicy({ flag: "hold", project: "refuse" }), {
      policy: "refuse",
      source: "repo",
      scope: "project",
    });
  });

  it("ignores a project setting that would loosen the current one", () => {
    assert.deepEqual(resolveInboundPolicy({ user: { policy: "refuse" }, project: "hold" }), {
      policy: "refuse",
      source: "user",
      scope: "user",
    });
    assert.deepEqual(resolveInboundPolicy({ user: { policy: "hold" }, project: "accept" }), {
      policy: "hold",
      source: "user",
      scope: "user",
    });
    assert.deepEqual(resolveInboundPolicy({ flag: "refuse", project: "accept" }), {
      policy: "refuse",
      source: "user",
      scope: "flag",
    });
  });

  it("treats an equal project setting as not stricter", () => {
    assert.deepEqual(resolveInboundPolicy({ user: { policy: "accept" }, project: "accept" }), {
      policy: "accept",
      source: "user",
      scope: "user",
    });
    assert.deepEqual(resolveInboundPolicy({ user: { policy: "hold" }, project: "hold" }), {
      policy: "hold",
      source: "user",
      scope: "user",
    });
  });

  it("never resolves a lone project `accept`, which equals the implicit default", () => {
    // `accept` ranks with the implicit default, so it cannot clear the strictness bar.
    assert.equal(resolveInboundPolicy({ project: "accept" }), undefined);
  });
});

describe("settings paths", () => {
  it("anchors the user and project settings files", () => {
    assert.equal(userSettingsPath("/cfg"), "/cfg/settings.json");
    assert.equal(projectSettingsPath("/work"), "/work/.qoder/settings.json");
  });
});

describe("evaluateInboundPolicy: the derived default", () => {
  it("honours an explicit user setting above everything else", () => {
    assert.deepEqual(
      evaluateInboundPolicy({ selfSent: true }, options({ setting: setting("hold") })),
      { policy: "hold", cause: "explicit-setting" },
    );
    assert.deepEqual(
      evaluateInboundPolicy({ fromMode: "prompting" }, options({ setting: setting("refuse") })),
      { policy: "refuse", cause: "explicit-setting" },
    );
  });

  it("reports a repository setting with its own cause", () => {
    assert.deepEqual(
      evaluateInboundPolicy({}, options({ setting: setting("hold", "repo") })),
      { policy: "hold", cause: "repo-setting" },
    );
    assert.deepEqual(
      evaluateInboundPolicy({}, options({ setting: setting("accept", "repo") })),
      { policy: "accept", cause: "repo-setting" },
    );
  });

  it("accepts a self-sent message even when the posture is unknown", () => {
    assert.deepEqual(
      evaluateInboundPolicy({ selfSent: true }, options({ permissionMode: undefined })),
      { policy: "accept", cause: "self-sent" },
    );
  });

  it("holds when this session's posture is not known yet", () => {
    assert.deepEqual(evaluateInboundPolicy({}, options({ permissionMode: undefined })), {
      policy: "hold",
      cause: "mode-unknown",
    });
  });

  it("accepts a matching asserted posture", () => {
    assert.deepEqual(
      evaluateInboundPolicy({ fromMode: "prompting" }, options({ modeEmit: true })),
      { policy: "accept", cause: "default-accept" },
    );
    assert.deepEqual(
      evaluateInboundPolicy(
        { fromMode: "bypass" },
        options({ permissionMode: "bypass", modeEmit: true }),
      ),
      { policy: "accept", cause: "default-accept" },
    );
  });

  it("holds on a mismatched asserted posture, in either direction", () => {
    assert.deepEqual(
      evaluateInboundPolicy({ fromMode: "bypass" }, options({ modeEmit: true })),
      { policy: "hold", cause: "mode-mismatch" },
    );
    assert.deepEqual(
      evaluateInboundPolicy(
        { fromMode: "prompting" },
        options({ permissionMode: "bypass", modeEmit: true }),
      ),
      { policy: "hold", cause: "mode-mismatch" },
    );
  });

  it("ignores `fromMode` when the sender did not assert it", () => {
    assert.deepEqual(
      evaluateInboundPolicy({ fromMode: "bypass" }, options({ modeEmit: undefined })),
      { policy: "accept", cause: "default-accept" },
    );
    assert.deepEqual(
      evaluateInboundPolicy({ fromMode: "prompting" }, options({ modeEmit: false })),
      { policy: "accept", cause: "default-accept" },
    );
    assert.deepEqual(
      evaluateInboundPolicy(
        { fromMode: "prompting" },
        options({ permissionMode: "bypass", modeEmit: false }),
      ),
      { policy: "hold", cause: "no-mode-asserted" },
    );
  });

  it("falls through to the posture default when `fromMode` is absent", () => {
    assert.deepEqual(evaluateInboundPolicy({}, options({ modeEmit: true })), {
      policy: "accept",
      cause: "default-accept",
    });
    assert.deepEqual(
      evaluateInboundPolicy({}, options({ permissionMode: "bypass", modeEmit: true })),
      { policy: "hold", cause: "no-mode-asserted" },
    );
  });

  it("holds a bypass session that asserted nothing", () => {
    assert.deepEqual(evaluateInboundPolicy({}, options({ permissionMode: "bypass" })), {
      policy: "hold",
      cause: "no-mode-asserted",
    });
  });

  it("accepts by default for a prompting session with no assertion", () => {
    assert.deepEqual(evaluateInboundPolicy({}, options({ permissionMode: "prompting" })), {
      policy: "accept",
      cause: "default-accept",
    });
  });
});

describe("evaluateInboundPolicy: holds without a review surface", () => {
  const noSurface = { reviewSurface: false } as const;

  it("degrades every posture-derived hold to a refusal", () => {
    const refused: PolicyDecision = { policy: "refuse", cause: "no-review-surface" };

    // mode-unknown
    assert.deepEqual(
      evaluateInboundPolicy({}, options({ ...noSurface, permissionMode: undefined })),
      refused,
    );
    // mode-mismatch
    assert.deepEqual(
      evaluateInboundPolicy({ fromMode: "bypass" }, options({ ...noSurface, modeEmit: true })),
      refused,
    );
    // no-mode-asserted
    assert.deepEqual(
      evaluateInboundPolicy({}, options({ ...noSurface, permissionMode: "bypass" })),
      refused,
    );
  });

  it("keeps an explicit user hold as-is", () => {
    assert.deepEqual(
      evaluateInboundPolicy({}, options({ ...noSurface, setting: setting("hold") })),
      { policy: "hold", cause: "explicit-setting" },
    );
  });

  it("keeps a repository hold as-is", () => {
    assert.deepEqual(
      evaluateInboundPolicy({}, options({ ...noSurface, setting: setting("hold", "repo") })),
      { policy: "hold", cause: "repo-setting" },
    );
  });

  it("leaves non-hold decisions alone", () => {
    assert.deepEqual(evaluateInboundPolicy({ selfSent: true }, options({ ...noSurface })), {
      policy: "accept",
      cause: "self-sent",
    });
    assert.deepEqual(
      evaluateInboundPolicy({ fromMode: "prompting" }, options({ ...noSurface, modeEmit: true })),
      { policy: "accept", cause: "default-accept" },
    );
    assert.deepEqual(
      evaluateInboundPolicy({}, options({ ...noSurface, setting: setting("refuse") })),
      { policy: "refuse", cause: "explicit-setting" },
    );
  });

  it("degrades nothing when a review surface exists", () => {
    assert.deepEqual(evaluateInboundPolicy({}, options({ permissionMode: undefined })), {
      policy: "hold",
      cause: "mode-unknown",
    });
    assert.deepEqual(
      evaluateInboundPolicy({ fromMode: "bypass" }, options({ modeEmit: true })),
      { policy: "hold", cause: "mode-mismatch" },
    );
    assert.deepEqual(evaluateInboundPolicy({}, options({ permissionMode: "bypass" })), {
      policy: "hold",
      cause: "no-mode-asserted",
    });
  });
});

describe("readSettings", () => {
  it("returns nothing for an absent settings object", () => {
    assert.deepEqual(readSettings(undefined), {});
    assert.deepEqual(readSettings({}), {});
  });

  it("reads security.crossSessionInbound and general.dialogExpiry", () => {
    assert.deepEqual(
      readSettings({
        security: { crossSessionInbound: "hold" },
        general: { dialogExpiry: "5m" },
      }),
      { policy: "hold", dialogExpiry: "5m" },
    );
  });

  it("reads each field on its own", () => {
    assert.deepEqual(readSettings({ security: { crossSessionInbound: "refuse" } }), {
      policy: "refuse",
    });
    assert.deepEqual(readSettings({ general: { dialogExpiry: "60s" } }), {
      dialogExpiry: "60s",
    });
  });

  it("ignores unknown policies and non-string expiries", () => {
    assert.deepEqual(readSettings({ security: { crossSessionInbound: "allow" } }), {});
    assert.deepEqual(readSettings({ general: { dialogExpiry: 300_000 } }), {});
    assert.deepEqual(
      readSettings({
        security: { crossSessionInbound: 42 },
        general: { dialogExpiry: null },
      }),
      {},
    );
  });

  it("ignores a malformed expiry string rather than validating it here", () => {
    // `readSettings` only checks the shape; unknown values fall back in resolveDialogExpiryMs.
    assert.deepEqual(readSettings({ general: { dialogExpiry: "2h" } }), {
      dialogExpiry: "2h",
    });
  });

  it("survives sections that are not objects", () => {
    assert.deepEqual(readSettings({ security: "nope", general: 7 }), {});
    assert.deepEqual(readSettings({ security: null, general: undefined }), {});
  });

  it("ignores unrelated settings", () => {
    assert.deepEqual(readSettings({ security: { other: "x" }, model: "qoder" }), {});
  });
});

describe("resolveDialogExpiryMs", () => {
  it("falls back to the default when nothing is configured", () => {
    assert.equal(resolveDialogExpiryMs({ env: {} }), DEFAULT_EXPIRY_MS);
    assert.equal(resolveDialogExpiryMs({ env: {}, configured: undefined }), DEFAULT_EXPIRY_MS);
  });

  it("lets the environment variable win over the explicit value and config", () => {
    assert.equal(
      resolveDialogExpiryMs({
        env: envWithTimeout("45000"),
        expiryMs: 12_000,
        configured: "10m",
      }),
      45_000,
    );
  });

  it("accepts a padded numeric environment value", () => {
    assert.equal(resolveDialogExpiryMs({ env: envWithTimeout(" 45000 ") }), 45_000);
  });

  it("ignores an unparsable environment value", () => {
    assert.equal(resolveDialogExpiryMs({ env: envWithTimeout("soon"), expiryMs: 12_000 }), 12_000);
    assert.equal(resolveDialogExpiryMs({ env: envWithTimeout(""), expiryMs: 12_000 }), 12_000);
    assert.equal(resolveDialogExpiryMs({ env: envWithTimeout("   "), expiryMs: 12_000 }), 12_000);
    assert.equal(resolveDialogExpiryMs({ env: envWithTimeout("NaN"), configured: "60s" }), 60_000);
  });

  it("ignores a negative environment value", () => {
    assert.equal(resolveDialogExpiryMs({ env: envWithTimeout("-1"), expiryMs: 12_000 }), 12_000);
    assert.equal(
      resolveDialogExpiryMs({ env: envWithTimeout("-1"), configured: "5m" }),
      DEFAULT_EXPIRY_MS,
    );
  });

  it("prefers the explicit value over the configured one", () => {
    assert.equal(resolveDialogExpiryMs({ env: {}, expiryMs: 12_000, configured: "10m" }), 12_000);
  });

  it("maps the configured values", () => {
    assert.equal(resolveDialogExpiryMs({ env: {}, configured: "60s" }), 60_000);
    assert.equal(resolveDialogExpiryMs({ env: {}, configured: "5m" }), 300_000);
    assert.equal(resolveDialogExpiryMs({ env: {}, configured: "10m" }), 600_000);
  });

  it("falls back to the default for an unknown configured value", () => {
    assert.equal(resolveDialogExpiryMs({ env: {}, configured: "2h" }), DEFAULT_EXPIRY_MS);
    assert.equal(resolveDialogExpiryMs({ env: {}, configured: "" }), DEFAULT_EXPIRY_MS);
  });

  it("maps `never` to zero, then back to the default", () => {
    assert.equal(resolveDialogExpiryMs({ env: {}, configured: "never" }), DEFAULT_EXPIRY_MS);
  });

  it("maps an explicit zero to the default", () => {
    assert.equal(resolveDialogExpiryMs({ env: {}, expiryMs: 0 }), DEFAULT_EXPIRY_MS);
    assert.equal(resolveDialogExpiryMs({ env: {}, expiryMs: 0, configured: "10m" }), DEFAULT_EXPIRY_MS);
  });

  it("maps an environment zero to the default", () => {
    assert.equal(resolveDialogExpiryMs({ env: envWithTimeout("0"), expiryMs: 12_000 }), DEFAULT_EXPIRY_MS);
    assert.equal(
      resolveDialogExpiryMs({ env: envWithTimeout("0"), expiryMs: 12_000, configured: "60s" }),
      DEFAULT_EXPIRY_MS,
    );
  });

  it("does not disturb the real process environment", () => {
    const before = process.env["QODER_USER_DIALOG_TIMEOUT_MS"];
    assert.equal(resolveDialogExpiryMs({ env: envWithTimeout("1234") }), 1234);
    assert.equal(process.env["QODER_USER_DIALOG_TIMEOUT_MS"], before);
  });
});
