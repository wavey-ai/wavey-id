#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const requireReady = args.has("--require-ready");
const withBuild = args.has("--with-build");
const withStartupCheck = args.has("--with-startup-check");

const template = runJson("config_template", "node", [
  "scripts/verify-zeroth-config.mjs",
  "--allow-placeholders",
]);
const deployConfig = runJson("config_deploy", "node", ["scripts/verify-zeroth-config.mjs"]);
const bootstrapSecrets = runJson("bootstrap_secrets", "bash", [
  "scripts/set-zeroth-secrets.sh",
  "--check",
  "--bootstrap-only",
  "--env-file",
  ".wrangler/zeroth-bootstrap.env",
]);
const providerStatus = runJson("provider_status", "node", [
  "scripts/zeroth-provider-status.mjs",
  "--remote",
]);
const preflightArgs = [
  "scripts/zeroth-deploy-preflight.mjs",
  "--allow-placeholders",
];
if (!withBuild) {
  preflightArgs.push("--skip-build");
}
if (withStartupCheck) {
  preflightArgs.push("--with-startup-check");
}
const preflight = runJson("deploy_preflight", "node", preflightArgs);
const live = runJson("live_status", "node", ["scripts/zeroth-live-status.mjs"]);

const preflightChecks = Object.fromEntries(
  (preflight.json?.checks || []).map((check) => [check.name, check]),
);
const deployFailures = deployConfig.json?.failures || [];
const providerPlaceholderFailures = deployFailures.filter((failure) =>
  ["apple_client_id", "google_client_id", "spotify_client_id"].includes(failure.check),
);

const blockers = [];
const nextActions = [];
const diagnostics = {};

if (!template.ok) {
  blockers.push("zeroth template config or client seed SQL is invalid");
  nextActions.push("fix wrangler.zeroth.jsonc and zeroth.clients.sql until zeroth:verify:local passes");
}

if (providerPlaceholderFailures.length > 0) {
  blockers.push(
    `provider client IDs still use placeholders: ${providerPlaceholderFailures
      .map((failure) => failure.check)
      .join(", ")}`,
  );
  nextActions.push("create active provider OAuth apps and replace provider client IDs in wrangler.zeroth.jsonc");
}

if (!bootstrapSecrets.ok) {
  blockers.push("local Zeroth bootstrap signing/admin secrets are not validated");
  nextActions.push("generate .wrangler/zeroth-bootstrap.env and run npm run zeroth:secrets:bootstrap:check");
}

if (providerStatus.json?.parent_folder_inventory?.app_store_connect_admin_key_count > 0) {
  diagnostics.apple_parent_key = {
    class: "app_store_connect_admin_key_ignored",
    description:
      "A parent-folder AppStore_AuthKey_*.p8 credential is present and intentionally ignored for Sign in with Apple login.",
  };
}

const appleProvider = providerStatus.json?.providers?.find((provider) => provider.id === "apple");
if (appleProvider?.credentials?.apple_private_key_path_class === "app_store_connect_admin_refused") {
  blockers.push("APPLE_PRIVATE_KEY_PATH points at an App Store Connect/admin key");
  nextActions.push("create a fresh Sign in with Apple key and point APPLE_PRIVATE_KEY_PATH at AuthKey_<KEYID>.p8");
}

if (providerStatus.json?.remote_secrets_read === false) {
  blockers.push("Cloudflare provider secret bindings could not be read");
  nextActions.push("inspect npm run zeroth:providers:status:remote output for the failing Wrangler secret list command");
} else if (providerStatus.json && !providerStatus.json.remote_provider_secrets_configured) {
  const missingSecretProviders = (providerStatus.json.providers || [])
    .filter((provider) => !provider.disabled && !provider.remote_secret_configured)
    .map((provider) => provider.id);
  blockers.push(`remote provider secret bindings are missing: ${missingSecretProviders.join(", ")}`);
  nextActions.push("export active provider secrets, run npm run zeroth:providers:status, then npm run zeroth:secrets");
}

if (!preflightChecks.d1_schema_and_clients?.ok) {
  blockers.push("remote D1 schema/client seed preflight is not passing");
  nextActions.push("run npm run zeroth:d1:init and re-run npm run zeroth:deploy:preflight:local");
}

const workerAuthDiagnostics = [
  preflightChecks.worker_api_read?.diagnostic,
  preflightChecks.worker_secrets_read?.diagnostic,
].filter((diagnostic) => diagnostic?.class === "cloudflare_workers_auth");
if (workerAuthDiagnostics.length > 0) {
  diagnostics.cloudflare_workers_auth = workerAuthDiagnostics[0];
  blockers.push(
    `Cloudflare token is missing Workers Scripts read/edit for account ${workerAuthDiagnostics[0].account_id}`,
  );
  nextActions.push(
    "grant Workers Scripts:Read and Workers Scripts:Edit for account c57bb20727aa3564966d2bb693abddce, then re-run npm run zeroth:deploy:preflight:local",
  );
} else if (!preflightChecks.worker_api_read?.ok || !preflightChecks.worker_secrets_read?.ok) {
  blockers.push("Cloudflare token cannot read Workers deployment/secret APIs");
  nextActions.push("inspect npm run zeroth:deploy:preflight:local output for the failing Wrangler command");
}

if (withBuild && !preflightChecks.worker_build_package?.ok) {
  blockers.push("Zeroth Worker dry-run packaging failed");
  nextActions.push("fix worker-build or wrangler dry-run errors before deploy");
}

if (withStartupCheck && !preflightChecks.worker_startup_profile?.ok) {
  blockers.push("Zeroth Worker startup analysis failed");
  nextActions.push("run npm run zeroth:startup:check and inspect worker-startup.cpuprofile");
}

if (withStartupCheck && !preflightChecks.worker_startup_budget?.ok) {
  blockers.push("Zeroth Worker startup exceeded the local 10 ms CPU-profile guardrail");
  nextActions.push("run npm run zeroth:startup:check and npm run zeroth:startup:profile");
}

if (live.json?.backend !== "zeroth_ready") {
  blockers.push(`live id.wavey.ai backend is ${live.json?.backend || "unknown"}`);
  if (live.json?.backend === "auth0_legacy") {
    nextActions.push("deploy the Zeroth Worker route once Cloudflare Workers permissions and bootstrap secrets are available");
  } else {
    nextActions.push("run npm run zeroth:live:status and inspect /ready provider readiness");
  }
}

const uniqueNextActions = [...new Set(nextActions)];
const summary = {
  ok: blockers.length === 0,
  require_ready: requireReady,
  with_build: withBuild,
  with_startup_check: withStartupCheck,
  status: {
    template_config: Boolean(template.ok),
    deploy_config: Boolean(deployConfig.ok),
    provider_client_ids_configured: providerPlaceholderFailures.length === 0,
    provider_secrets_configured: Boolean(providerStatus.json?.provider_secrets_configured),
    remote_provider_secrets_configured: Boolean(
      providerStatus.json?.remote_provider_secrets_configured,
    ),
    providers_ready: Boolean(providerStatus.json?.remote_ready),
    apple_provider_material_ready: Boolean(appleProvider?.ready),
    bootstrap_secrets: Boolean(bootstrapSecrets.ok),
    d1_schema_and_clients: Boolean(preflightChecks.d1_schema_and_clients?.ok),
    worker_api_read: Boolean(preflightChecks.worker_api_read?.ok),
    worker_secrets_read: Boolean(preflightChecks.worker_secrets_read?.ok),
    worker_build_package: withBuild ? Boolean(preflightChecks.worker_build_package?.ok) : null,
    worker_startup_profile: withStartupCheck
      ? Boolean(preflightChecks.worker_startup_profile?.ok)
      : null,
    worker_startup_budget: withStartupCheck
      ? Boolean(preflightChecks.worker_startup_budget?.ok)
      : null,
    live_backend: live.json?.backend || null,
    zeroth_live: Boolean(live.json?.zeroth_live),
  },
  blockers,
  next_actions: uniqueNextActions,
  diagnostics,
  command_status: {
    config_template: template.status,
    config_deploy: deployConfig.status,
    provider_status: providerStatus.status,
    bootstrap_secrets: bootstrapSecrets.status,
    deploy_preflight: preflight.status,
    live_status: live.status,
  },
};

console.log(JSON.stringify(summary, null, 2));

if (requireReady && !summary.ok) {
  process.exit(1);
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
    ok: result.status === 0,
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
