#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const replacementProviderIds = ["apple", "google", "spotify"];
const expectedClientIds = [
  "wavey-browser",
  "wavey-ios",
  "bitneedle-web",
  "infidelity-web",
  "infidelity-macos",
];

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
  const loginStatus = runJson("login_status", "node", [
    "scripts/zeroth-login-status.mjs",
  ]);
  const persistenceStatus = runJson("persistence_status", "node", [
    "scripts/zeroth-persistence-status.mjs",
  ]);
  const swiftStatus = runJson("swift_status", "node", [
    "scripts/zeroth-swift-status.mjs",
  ]);

  const summary = backendStatusSummary({
    requireBackend,
    withStartupCheck,
    rollout: rollout.json,
    liveAdmin: liveAdmin.json,
    providerStatus: providerStatus.json,
    loginStatus: commandJsonOrFailure(loginStatus, "hosted provider login status command failed"),
    persistenceStatus: commandJsonOrFailure(persistenceStatus, "D1 persistence status command failed"),
    swiftStatus: commandJsonOrFailure(swiftStatus, "Swift/iOS status command failed"),
    commandStatus: {
      rollout_status: rollout.status,
      live_admin_bootstrap: liveAdmin.status,
      provider_status_remote: providerStatus.status,
      login_status: loginStatus.status,
      persistence_status: persistenceStatus.status,
      swift_status: swiftStatus.status,
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
  loginStatus,
  persistenceStatus,
  swiftStatus,
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
    local_auth_status_live: liveAdminStatus?.local_auth_status === 200,
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
  const localAuth = localAuthSummary(liveAdminStatus?.local_auth_methods);
  const localAuthBlockers = localAuthBlockerSummary(localAuth);
  const loginBlockers = loginBlockerSummary(loginStatus);
  const persistenceBlockers = persistenceBlockerSummary(persistenceStatus);
  const swiftBlockers = swiftBlockerSummary(swiftStatus);
  const providersReady =
    providerStatus?.remote_ready === true && live?.ready === true && live?.ready_status === 200;
  const backendReady = backendBlockers.length === 0;
  const auth0Replacement = auth0ReplacementSummary({
    backendReady,
    providersReady,
    rolloutStatus,
    liveAdminStatus,
    providerStatus,
    localAuthBlockers,
    loginBlockers,
    loginStatus,
    persistenceBlockers,
    persistenceStatus,
    swiftBlockers,
    swiftStatus,
  });

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
    local_auth_summary: localAuth,
    login_summary: loginSummary(loginStatus),
    persistence_summary: persistenceSummary(persistenceStatus),
    swift_summary: swiftSummary(swiftStatus),
    auth0_replacement: auth0Replacement,
    backend_blockers: backendBlockers,
    provider_blockers: providerBlockers,
    local_auth_blockers: localAuthBlockers,
    login_blockers: loginBlockers,
    persistence_blockers: persistenceBlockers,
    swift_blockers: swiftBlockers,
    next_actions: nextActions({
      backendBlockers,
      providerBlockers,
      localAuthBlockers,
      loginBlockers,
      persistenceBlockers,
      swiftBlockers,
      providersReady,
      auth0Replacement,
    }),
    command_status: commandStatus,
  };
}

function auth0ReplacementSummary({
  backendReady,
  providersReady,
  rolloutStatus = {},
  liveAdminStatus = {},
  providerStatus = {},
  localAuthBlockers = [],
  loginBlockers = [],
  loginStatus,
  persistenceBlockers = [],
  persistenceStatus,
  swiftBlockers = [],
  swiftStatus,
}) {
  const providers = Array.isArray(providerStatus.providers) ? providerStatus.providers : [];
  const targetProviders = replacementProviderIds.map((id) => {
    const provider = providers.find((item) => item.id === id) || { id };
    const ready = provider.disabled === true ? false : provider.remote_ready === true;
    return {
      id,
      label: provider.label || id,
      disabled: provider.disabled === true,
      ready,
      required_for_replacement: true,
      notes: Array.isArray(provider.notes) ? provider.notes : [],
      activation_requirements: Array.isArray(provider.activation_requirements)
        ? provider.activation_requirements
        : [],
    };
  });
  const clientIds = Array.isArray(liveAdminStatus.client_ids) ? liveAdminStatus.client_ids : [];
  const missingClients = clientIds.length > 0
    ? expectedClientIds.filter((clientId) => !clientIds.includes(clientId))
    : liveAdminStatus.clients_status === 200 && Number(liveAdminStatus.client_count || 0) >= expectedClientIds.length
      ? []
      : expectedClientIds;
  const legacyRouteRetired =
    rolloutStatus.zeroth_live === true &&
    (rolloutStatus.live_backend === "zeroth_ready" || rolloutStatus.live_backend === "zeroth_not_ready");
  const blockers = [];

  if (!backendReady) {
    blockers.push("Zeroth backend is not ready");
  }
  if (!providersReady) {
    blockers.push("active Zeroth providers are not ready");
  }
  for (const provider of targetProviders) {
    if (provider.disabled) {
      blockers.push(providerDisabledBlocker(provider));
    } else if (!provider.ready) {
      blockers.push(`${provider.label} provider is not ready`);
    }
  }
  if (missingClients.length > 0) {
    blockers.push(`seed missing relying clients: ${missingClients.join(", ")}`);
  }
  if (!legacyRouteRetired) {
    blockers.push("id.wavey.ai is not confirmed as a Zeroth-owned route");
  }
  for (const blocker of localAuthBlockers) {
    blockers.push(`local auth: ${blocker}`);
  }
  for (const blocker of loginBlockers) {
    blockers.push(`hosted login: ${blocker}`);
  }
  for (const blocker of persistenceBlockers) {
    blockers.push(`D1 persistence: ${blocker}`);
  }
  for (const blocker of swiftBlockers) {
    blockers.push(`Swift/iOS: ${blocker}`);
  }

  return {
    ready: blockers.length === 0,
    apple_google_ready: backendReady && providersReady,
    hosted_login_ready: loginStatus?.ready ?? null,
    persistence_ready: persistenceStatus?.ready ?? null,
    swift_ready: swiftStatus?.ready ?? null,
    target_provider_ids: replacementProviderIds,
    target_providers: targetProviders,
    expected_client_ids: expectedClientIds,
    seeded_client_ids: clientIds,
    missing_client_ids: missingClients,
    legacy_route_retired: legacyRouteRetired,
    blockers,
    cutover_tasks: [
      "point each relying app at issuer https://id.wavey.ai",
      "switch app token validation to https://id.wavey.ai/.well-known/jwks.json",
      "replace Auth0 client IDs with Zeroth registered-client IDs",
      "remove Auth0 environment variables after app cutover is verified",
    ],
  };
}

function providerDisabledBlocker(provider) {
  const requirements = Array.isArray(provider.activation_requirements)
    ? provider.activation_requirements.filter(Boolean)
    : [];
  const detail = requirements.length > 0
    ? `: ${requirements.join("; ")}`
    : "";
  return `${provider.label} provider is disabled by deployment${detail}`;
}

function providerBlockerSummary(providerStatus) {
  const items = [];
  if (providerStatus?.provider_client_ids_configured !== true) {
    items.push("replace placeholder provider client IDs in wrangler.zeroth.jsonc");
  }
  if (providerStatus?.remote_provider_secrets_configured !== true) {
    const labels = requiredProviderLabels(providerStatus);
    items.push(`upload ${labels} Worker secret bindings`);
  }
  return items;
}

function localAuthSummary(methods = []) {
  const list = Array.isArray(methods) ? methods : [];
  const magicLink = list.find((method) => method.id === "magic_link") || null;
  return {
    methods: list.map((method) => ({
      id: method.id || null,
      enabled: method.enabled === true,
      delivery: method.delivery || null,
      notes: Array.isArray(method.notes) ? method.notes : [],
    })),
    magic_link: magicLink
      ? {
          enabled: magicLink.enabled === true,
          delivery: magicLink.delivery || null,
          notes: Array.isArray(magicLink.notes) ? magicLink.notes : [],
          delivery_status: magicLink.deliveryStatus || magicLink.delivery_status || null,
        }
      : null,
  };
}

function localAuthBlockerSummary(summary) {
  const items = [];
  const magicLink = summary?.magic_link;
  if (!magicLink) {
    items.push("local auth status did not include magic link state");
    return items;
  }
  if (!magicLink.enabled) {
    items.push("magic link login is disabled");
  }
  if (magicLink.notes.includes("delivery_failed_recently")) {
    const lastError = magicLinkDeliveryErrorSummary(magicLink.delivery_status);
    items.push(`magic link email delivery failed recently${lastError ? `: ${lastError}` : ""}`);
  } else if (magicLink.notes.includes("delivery_not_proven")) {
    items.push("magic link email delivery is not proven");
  }
  return items;
}

function magicLinkDeliveryErrorSummary(deliveryStatus = {}) {
  const lastError = deliveryStatus?.lastError || deliveryStatus?.last_error || "";
  const detail =
    deliveryStatus?.lastErrorDetail ||
    deliveryStatus?.last_error_detail ||
    deliveryStatus?.errorDetail ||
    deliveryStatus?.error_detail ||
    "";
  const safeLastError = boundedStatusText(lastError, 120);
  const safeDetail = boundedStatusText(detail, 180);
  if (safeLastError && safeDetail) {
    return `${safeLastError} (${safeDetail})`;
  }
  return safeLastError || safeDetail;
}

function boundedStatusText(value, maxChars) {
  if (typeof value !== "string") {
    return "";
  }
  const text = value
    .trim()
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\s+/g, " ");
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function loginSummary(loginStatus) {
  if (!loginStatus || typeof loginStatus !== "object") {
    return {
      checked: false,
      ready: null,
      checks: {},
      providers: [],
      blockers: [],
    };
  }
  return {
    checked: true,
    ready: loginStatus.ready ?? null,
    checks: loginStatus.checks || {},
    providers: Array.isArray(loginStatus.providers)
      ? loginStatus.providers.map((provider) => ({
          id: provider.id || null,
          label: provider.label || provider.id || null,
          disabled: provider.disabled === true,
          ok: provider.ok === true,
          status: provider.status ?? null,
          location_host: provider.location_host || null,
          redirected_to_provider: provider.redirected_to_provider === true,
        }))
      : [],
    blockers: Array.isArray(loginStatus.blockers) ? loginStatus.blockers : [],
  };
}

function loginBlockerSummary(loginStatus) {
  if (!loginStatus || typeof loginStatus !== "object") {
    return [];
  }
  if (loginStatus.ready === true) {
    return [];
  }
  const blockers = Array.isArray(loginStatus.blockers) ? loginStatus.blockers : [];
  if (blockers.length > 0) {
    return blockers;
  }
  return ["hosted provider login redirects are not ready"];
}

function persistenceSummary(persistenceStatus) {
  if (!persistenceStatus || typeof persistenceStatus !== "object") {
    return {
      checked: false,
      ready: null,
      checks: {},
      counts: {},
      blockers: [],
    };
  }
  return {
    checked: true,
    ready: persistenceStatus.ready ?? null,
    checks: persistenceStatus.checks || {},
    counts: persistenceStatus.counts || {},
    client_ids: Array.isArray(persistenceStatus.client_ids) ? persistenceStatus.client_ids : [],
    local_auth_method_ids: Array.isArray(persistenceStatus.local_auth_method_ids)
      ? persistenceStatus.local_auth_method_ids
      : [],
    provider_ids: Array.isArray(persistenceStatus.provider_ids) ? persistenceStatus.provider_ids : [],
    event_types: Array.isArray(persistenceStatus.event_types) ? persistenceStatus.event_types : [],
    blockers: Array.isArray(persistenceStatus.blockers) ? persistenceStatus.blockers : [],
  };
}

function persistenceBlockerSummary(persistenceStatus) {
  if (!persistenceStatus || typeof persistenceStatus !== "object") {
    return [];
  }
  if (persistenceStatus.ready === true) {
    return [];
  }
  const blockers = Array.isArray(persistenceStatus.blockers) ? persistenceStatus.blockers : [];
  if (blockers.length > 0) {
    return blockers;
  }
  return ["D1-backed user/event persistence is not ready"];
}

function swiftSummary(swiftStatus) {
  if (!swiftStatus || typeof swiftStatus !== "object") {
    return {
      checked: false,
      ready: null,
      client_id: null,
      checks: {},
      blockers: [],
    };
  }
  return {
    checked: true,
    ready: swiftStatus.ready ?? null,
    client_id: swiftStatus.client_id || null,
    origin: swiftStatus.origin || null,
    checks: swiftStatus.checks || {},
    blockers: Array.isArray(swiftStatus.blockers) ? swiftStatus.blockers : [],
  };
}

function swiftBlockerSummary(swiftStatus) {
  if (!swiftStatus || typeof swiftStatus !== "object") {
    return [];
  }
  if (swiftStatus.ready === true) {
    return [];
  }
  const blockers = Array.isArray(swiftStatus.blockers) ? swiftStatus.blockers : [];
  if (blockers.length > 0) {
    return blockers;
  }
  return ["Swift/iOS native login is not ready"];
}

function nextActions({
  backendBlockers,
  providerBlockers,
  localAuthBlockers,
  loginBlockers,
  persistenceBlockers,
  swiftBlockers,
  providersReady,
  auth0Replacement,
}) {
  const spotifyActions = spotifyNextActions(auth0Replacement);
  if (backendBlockers.length > 0) {
    return [
      "fix backend blockers, then re-run npm run zeroth:backend:status",
      "run npm run zeroth:rollout:status:startup for detailed backend diagnostics",
    ];
  }
  if (!providersReady) {
    return [
      "create provider apps and replace active provider client IDs in wrangler.zeroth.jsonc",
      "upload provider secrets with npm run zeroth:secrets, then re-run npm run zeroth:backend:status",
    ];
  }
  if (providerBlockers.length > 0) {
    return providerBlockers;
  }
  if (loginBlockers.length > 0) {
    return [
      "run npm run zeroth:login:status to inspect hosted provider login redirects",
      "fix hosted login blockers, then re-run npm run zeroth:backend:status",
    ];
  }
  if (persistenceBlockers.length > 0) {
    return [
      "run npm run zeroth:persistence:status to inspect D1-backed user, event, and local-auth APIs",
      "repair D1 schema/admin access or complete a real login, then re-run npm run zeroth:backend:status",
    ];
  }
  if (localAuthBlockers.length > 0) {
    return [
      ...spotifyActions,
      "run npm run zeroth:email:status to inspect Cloudflare Email Sending and live magic-link evidence",
      "enable or repair Cloudflare Email Sending for wavey.ai, then request a fresh magic link",
      "run npm run zeroth:email:send-test to attempt a minimal Cloudflare email send",
      "re-run npm run zeroth:backend:status and check local_auth_summary.magic_link.delivery_status",
    ];
  }
  if (swiftBlockers.length > 0) {
    return [
      "run npm run zeroth:swift:status to inspect native Swift/iOS login readiness",
      "fix Swift/iOS blockers, then re-run npm run zeroth:backend:status",
    ];
  }
  if (spotifyActions.length > 0) {
    return spotifyActions;
  }
  return [];
}

function spotifyNextActions(auth0Replacement = {}) {
  const spotify = Array.isArray(auth0Replacement.target_providers)
    ? auth0Replacement.target_providers.find((provider) => provider.id === "spotify")
    : null;
  if (!spotify?.disabled) {
    return [];
  }
  return [
    "after fixing Spotify owner Premium and user allowlist state, run SPOTIFY_ACCESS_TOKEN=... npm run zeroth:spotify:status",
    "when Spotify /v1/me is ready, remove spotify from DISABLED_PROVIDERS and redeploy Zeroth",
  ];
}

function requiredProviderLabels(providerStatus = {}) {
  const requiredIds = Array.isArray(providerStatus.required_provider_ids)
    ? providerStatus.required_provider_ids
    : [];
  const providers = Array.isArray(providerStatus.providers) ? providerStatus.providers : [];
  const labels = requiredIds.length > 0
    ? requiredIds.map((id) => providerLabel(providers, id))
    : ["active provider"];
  return labels.join("/");
}

function providerLabel(providers, id) {
  return providers.find((provider) => provider.id === id)?.label || id;
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

function commandJsonOrFailure(result, fallbackBlocker) {
  if (result?.status === 0 && result?.json) {
    return result.json;
  }
  return {
    ok: false,
    ready: false,
    blockers: [fallbackBlocker],
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
