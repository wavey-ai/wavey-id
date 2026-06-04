#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

if (isCli()) {
  runCli(process.argv.slice(2));
}

function runCli(rawArgs) {
  const args = new Set(rawArgs);
  const requireBackend = args.has("--require-backend");
  const withStartupCheck = !args.has("--skip-startup-check");

  const rolloutArgs = ["scripts/zeroth-rollout-status.mjs"];
  if (withStartupCheck) {
    rolloutArgs.push("--with-startup-check");
  }

  const rollout = runJson("rollout_status", "node", rolloutArgs);
  const liveAdmin = runJson("live_admin_bootstrap", "node", [
    "scripts/verify-zeroth-config.mjs",
    "--allow-placeholders",
    "--allow-not-ready",
    "--live",
    "--require-admin",
    "--env-file",
    ".wrangler/zeroth-bootstrap.env",
  ]);
  const providerStatus = runJson("provider_status_remote", "node", [
    "scripts/zeroth-provider-status.mjs",
    "--remote",
  ]);

  const summary = backendStatusSummary({
    requireBackend,
    withStartupCheck,
    rollout: rollout.json,
    liveAdmin: liveAdmin.json,
    providerStatus: providerStatus.json,
    commandStatus: {
      rollout_status: rollout.status,
      live_admin_bootstrap: liveAdmin.status,
      provider_status_remote: providerStatus.status,
    },
  });

  console.log(JSON.stringify(summary, null, 2));

  if (requireBackend && !summary.backend_ready) {
    process.exit(1);
  }
}

export function backendStatusSummary({
  requireBackend = false,
  withStartupCheck = true,
  rollout = {},
  liveAdmin = {},
  providerStatus = {},
  commandStatus = {},
} = {}) {
  const rolloutStatus = rollout?.status || {};
  const live = liveAdmin?.live || {};
  const readiness = live?.readiness || {};
  const liveAdminStatus = live?.admin || {};
  const backendChecks = {
    zeroth_worker_live: Boolean(rolloutStatus.zeroth_live),
    discovery_live: live?.openid_configuration_status === 200,
    issuer_configured: readiness?.issuer_check?.configured === true,
    signing_configured: readiness?.signing?.configured === true,
    admin_db_live: liveAdminStatus?.db_status === 200,
    seeded_clients_live:
      liveAdminStatus?.clients_status === 200 && Number(liveAdminStatus?.client_count || 0) >= 5,
    d1_schema_and_clients: rolloutStatus.d1_schema_and_clients === true,
    worker_api_read: rolloutStatus.worker_api_read === true,
    worker_secrets_read: rolloutStatus.worker_secrets_read === true,
  };

  if (withStartupCheck) {
    backendChecks.worker_startup_profile = rolloutStatus.worker_startup_profile === true;
    backendChecks.worker_startup_budget = rolloutStatus.worker_startup_budget === true;
  }

  const backendBlockers = Object.entries(backendChecks)
    .filter(([_name, ok]) => !ok)
    .map(([name]) => name);
  const providerBlockers = providerBlockerSummary(providerStatus);
  const providersReady =
    providerStatus?.remote_ready === true && live?.ready === true && live?.ready_status === 200;
  const backendReady = backendBlockers.length === 0;

  return {
    ok: requireBackend ? backendReady : true,
    require_backend: requireBackend,
    phase: providersReady
      ? "zeroth_ready"
      : backendReady
        ? "backend_ready_provider_config_pending"
        : "backend_not_ready",
    backend_ready: backendReady,
    providers_ready: providersReady,
    live_backend: rolloutStatus.live_backend || null,
    try_me: {
      admin: "https://id.wavey.ai/admin",
      discovery: "https://id.wavey.ai/.well-known/openid-configuration",
      ready: "https://id.wavey.ai/ready",
    },
    checks: backendChecks,
    provider_summary: {
      client_ids_configured: providerStatus?.provider_client_ids_configured === true,
      remote_secrets_configured: providerStatus?.remote_provider_secrets_configured === true,
      remote_secrets_read: providerStatus?.remote_secrets_read ?? null,
      missing: providerStatus?.missing || [],
      remote_missing: providerStatus?.remote_missing || [],
      warnings: providerStatus?.warnings || [],
    },
    backend_blockers: backendBlockers,
    provider_blockers: providerBlockers,
    next_actions: nextActions({ backendBlockers, providerBlockers, providersReady }),
    command_status: commandStatus,
  };
}

function providerBlockerSummary(providerStatus) {
  const items = [];
  if (providerStatus?.provider_client_ids_configured !== true) {
    items.push("replace placeholder provider client IDs in wrangler.zeroth.jsonc");
  }
  if (providerStatus?.remote_provider_secrets_configured !== true) {
    items.push("upload Apple/Google/Spotify Worker secret bindings");
  }
  return items;
}

function nextActions({ backendBlockers, providerBlockers, providersReady }) {
  if (backendBlockers.length > 0) {
    return [
      "fix backend blockers, then re-run npm run zeroth:backend:status",
      "run npm run zeroth:rollout:status:startup for detailed backend diagnostics",
    ];
  }
  if (!providersReady) {
    return [
      "create provider apps and replace Apple/Google/Spotify client IDs in wrangler.zeroth.jsonc",
      "upload provider secrets with npm run zeroth:secrets, then re-run npm run zeroth:backend:status",
    ];
  }
  if (providerBlockers.length > 0) {
    return providerBlockers;
  }
  return [];
}

function runJson(name, command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: process.env.CI || "1",
    },
  });
  return {
    name,
    status: result.status,
    json: parseJsonOutput(`${result.stdout || ""}\n${result.stderr || ""}`),
  };
}

function parseJsonOutput(output) {
  const value = stripAnsi(output);
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function isCli() {
  return process.argv[1]
    && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
}
