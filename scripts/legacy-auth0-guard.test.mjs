import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  LEGACY_AUTH0_ALLOW_ENV,
  legacyAuth0GuardSummary,
} from "./legacy-auth0-guard.mjs";

test("legacy Auth0 guard requires exact opt-in", () => {
  assert.equal(legacyAuth0GuardSummary({ env: {} }).ok, false);
  assert.equal(
    legacyAuth0GuardSummary({ env: { [LEGACY_AUTH0_ALLOW_ENV]: "true" } }).ok,
    false,
  );
  assert.equal(
    legacyAuth0GuardSummary({ env: { [LEGACY_AUTH0_ALLOW_ENV]: "1" } }).ok,
    true,
  );
});

test("legacy Auth0 guard CLI fails closed", () => {
  const script = path.join(import.meta.dirname, "legacy-auth0-guard.mjs");
  const denied = spawnSync(process.execPath, [script, "deploy"], {
    env: {},
    encoding: "utf8",
  });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /legacy_auth0_disabled_by_default/);

  const allowed = spawnSync(process.execPath, [script, "deploy"], {
    env: { [LEGACY_AUTH0_ALLOW_ENV]: "1" },
    encoding: "utf8",
  });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /explicit_legacy_auth0_opt_in/);
});
