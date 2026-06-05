#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "node:url";

export const LEGACY_AUTH0_ALLOW_ENV = "ALLOW_LEGACY_AUTH0";

export function legacyAuth0GuardSummary({
  action = "legacy-auth0",
  env = process.env,
} = {}) {
  const allowed = env[LEGACY_AUTH0_ALLOW_ENV] === "1";
  return {
    ok: allowed,
    action,
    required_env: `${LEGACY_AUTH0_ALLOW_ENV}=1`,
    reason: allowed
      ? "explicit_legacy_auth0_opt_in"
      : "legacy_auth0_disabled_by_default",
    message: allowed
      ? "Archived Auth0 command allowed for this invocation."
      : "Archived Auth0 commands are disabled by default; use Zeroth commands for id.wavey.ai.",
  };
}

if (isCli()) {
  const summary = legacyAuth0GuardSummary({
    action: process.argv[2] || "legacy-auth0",
  });
  const output = JSON.stringify(summary, null, 2);
  if (summary.ok) {
    console.log(output);
  } else {
    console.error(output);
    process.exit(1);
  }
}

function isCli() {
  return process.argv[1]
    && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
}
