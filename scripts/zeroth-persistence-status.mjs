#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const defaultOrigin = "https://id.wavey.ai";
const defaultEnvFile = ".wrangler/zeroth-bootstrap.env";
const expectedClientIds = [
  "wavey-browser",
  "wavey-ios",
  "bitneedle-web",
  "infidelity-web",
  "infidelity-macos",
];
const requiredTables = [
  "zeroth_schema_migrations",
  "zeroth_users",
  "zeroth_identities",
  "zeroth_clients",
  "zeroth_auth_transactions",
  "zeroth_auth_codes",
  "zeroth_refresh_tokens",
  "zeroth_sessions",
  "zeroth_passkey_credentials",
  "zeroth_passkey_challenges",
  "zeroth_admin_memberships",
  "zeroth_local_credentials",
  "zeroth_magic_links",
  "zeroth_signing_keys",
  "zeroth_audit_events",
];
const requiredLocalAuthStorage = {
  password: "zeroth_local_credentials",
  passkey: "zeroth_passkey_credentials",
  magic_link: "zeroth_magic_links",
};

if (isCli()) {
  const summary = await runCli(process.argv.slice(2));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.require_ready && !summary.ready) {
    process.exit(1);
  }
}

async function runCli(rawArgs) {
  const requireReady = rawArgs.includes("--require-ready");
  const origin = argValue(rawArgs, "--origin") || defaultOrigin;
  const envFile = argValue(rawArgs, "--env-file") || defaultEnvFile;
  const envFileValues = readEnvFile(envFile);
  const adminToken =
    process.env.ZEROTH_ADMIN_TOKEN ||
    process.env.ADMIN_TOKEN ||
    envFileValues.ZEROTH_ADMIN_TOKEN ||
    envFileValues.ADMIN_TOKEN ||
    "";

  return persistenceStatusSummary({
    origin,
    adminToken,
    requireReady,
    fetchFn: fetch,
  });
}

export async function persistenceStatusSummary({
  origin = defaultOrigin,
  adminToken = "",
  requireReady = false,
  fetchFn = fetch,
} = {}) {
  const normalizedOrigin = origin.replace(/\/+$/, "");
  if (!adminToken) {
    return {
      ok: false,
      ready: false,
      require_ready: requireReady,
      origin: normalizedOrigin,
      checks: {
        admin_token_present: false,
      },
      counts: {},
      blockers: ["ADMIN_TOKEN or ZEROTH_ADMIN_TOKEN is required for persistence check"],
    };
  }

  const [db, clients, users, events, localAuth, providers] = await Promise.all([
    adminJsonCheck({ origin: normalizedOrigin, path: "/__zeroth/db/status", adminToken, fetchFn }),
    adminJsonCheck({ origin: normalizedOrigin, path: "/clients", adminToken, fetchFn }),
    adminJsonCheck({ origin: normalizedOrigin, path: "/users", adminToken, fetchFn }),
    adminJsonCheck({ origin: normalizedOrigin, path: "/events", adminToken, fetchFn }),
    adminJsonCheck({ origin: normalizedOrigin, path: "/local-auth/status", adminToken, fetchFn }),
    adminJsonCheck({ origin: normalizedOrigin, path: "/providers/status", adminToken, fetchFn }),
  ]);

  const clientIds = arrayFrom(clients.body?.clients).map((client) => client.id || client.clientId).filter(Boolean);
  const userRows = arrayFrom(users.body?.users);
  const eventRows = arrayFrom(events.body?.events);
  const localAuthMethods = arrayFrom(localAuth.body?.methods);
  const providerRows = arrayFrom(providers.body?.providers);
  const missingClients = expectedClientIds.filter((clientId) => !clientIds.includes(clientId));
  const missingTables = requiredTables.filter((tableName) =>
    !arrayFrom(db.body?.tables).some((table) => table.name === tableName && table.present === true),
  );
  const pendingMigrations = arrayFrom(db.body?.migrations)
    .filter((migration) => migration.applied !== true)
    .map((migration) => `${migration.version || "?"}:${migration.name || "unknown"}`);
  const missingCompatibilityColumns = arrayFrom(db.body?.compatibilityColumns)
    .filter((column) => column.present !== true)
    .map((column) => `${column.table || "?"}.${column.name || "?"}`);
  const localAuthStorageMismatches = Object.entries(requiredLocalAuthStorage).flatMap(([id, storage]) => {
    const method = localAuthMethods.find((item) => item.id === id);
    if (!method) {
      return [`${id} missing`];
    }
    const actual = method.credentialStorage || method.credential_storage || "";
    if (actual !== storage) {
      return [`${id} uses ${actual || "missing storage"}, expected ${storage}`];
    }
    if (method.enabled !== true) {
      return [`${id} is disabled`];
    }
    return [];
  });
  const adminUserCount = userRows.filter((user) => user.admin === true).length;
  const userIdentityCount = userRows.reduce((sum, user) => sum + Number(user.identityCount || user.identity_count || 0), 0);
  const eventTypes = [...new Set(eventRows.map((event) => event.eventType || event.event_type).filter(Boolean))].sort();

  const checks = {
    admin_token_present: true,
    db_status: db.ok && db.body?.ok === true,
    required_tables: missingTables.length === 0,
    migrations_applied: pendingMigrations.length === 0,
    compatibility_columns: missingCompatibilityColumns.length === 0,
    clients_api: clients.ok && Array.isArray(clients.body?.clients),
    seeded_clients: missingClients.length === 0,
    users_api: users.ok && Array.isArray(users.body?.users),
    persisted_users: userRows.length > 0,
    admin_user: adminUserCount > 0,
    events_api: events.ok && Array.isArray(events.body?.events),
    audit_events: eventRows.length > 0,
    local_auth_api: localAuth.ok && Array.isArray(localAuth.body?.methods),
    local_auth_storage: localAuthStorageMismatches.length === 0,
    provider_status_api: providers.ok && Array.isArray(providers.body?.providers),
  };

  const blockers = [];
  if (!checks.db_status) blockers.push(adminRouteBlocker(db, "/__zeroth/db/status", "ok=true"));
  if (missingTables.length > 0) blockers.push(`missing D1 tables: ${missingTables.join(", ")}`);
  if (pendingMigrations.length > 0) blockers.push(`pending D1 migrations: ${pendingMigrations.join(", ")}`);
  if (missingCompatibilityColumns.length > 0) {
    blockers.push(`missing D1 compatibility columns: ${missingCompatibilityColumns.join(", ")}`);
  }
  if (!checks.clients_api) blockers.push(adminRouteBlocker(clients, "/clients", "clients array"));
  if (missingClients.length > 0) blockers.push(`seeded clients missing: ${missingClients.join(", ")}`);
  if (!checks.users_api) blockers.push(adminRouteBlocker(users, "/users", "users array"));
  if (!checks.persisted_users) blockers.push("no persisted users returned from /users");
  if (!checks.admin_user) blockers.push("no admin user returned from /users");
  if (!checks.events_api) blockers.push(adminRouteBlocker(events, "/events", "events array"));
  if (!checks.audit_events) blockers.push("no persisted audit events returned from /events");
  if (!checks.local_auth_api) blockers.push(adminRouteBlocker(localAuth, "/local-auth/status", "methods array"));
  if (localAuthStorageMismatches.length > 0) {
    blockers.push(`local auth storage mismatch: ${localAuthStorageMismatches.join(", ")}`);
  }
  if (!checks.provider_status_api) blockers.push(adminRouteBlocker(providers, "/providers/status", "providers array"));

  return {
    ok: blockers.length === 0,
    ready: blockers.length === 0,
    require_ready: requireReady,
    origin: normalizedOrigin,
    checks,
    counts: {
      required_table_count: requiredTables.length,
      client_count: clientIds.length,
      user_count: userRows.length,
      admin_user_count: adminUserCount,
      user_identity_count: userIdentityCount,
      event_count: eventRows.length,
      local_auth_method_count: localAuthMethods.length,
      provider_count: providerRows.length,
    },
    client_ids: clientIds,
    local_auth_method_ids: localAuthMethods.map((method) => method.id).filter(Boolean),
    provider_ids: providerRows.map((provider) => provider.id).filter(Boolean),
    event_types: eventTypes,
    blockers,
  };
}

async function adminJsonCheck({ origin, path, adminToken, fetchFn }) {
  try {
    const response = await fetchFn(`${origin}${path}`, {
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const body = await jsonBody(response);
    return {
      ok: response.status === 200,
      status: response.status,
      body,
      error: body?.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function adminRouteBlocker(result, route, expected) {
  const detail = result.status === null
    ? result.error || "request failed"
    : `HTTP ${result.status}`;
  return `${route} did not return ${expected}: ${detail}`;
}

async function jsonBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}

function readEnvFile(filePath) {
  const resolved = path.resolve(root, filePath);
  if (!isReadableFile(resolved)) {
    return {};
  }

  const values = {};
  for (const line of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(assignment);
    if (!match) {
      continue;
    }
    values[match[1]] = expandEnvValue(unquoteEnvValue(match[2].trim()), values);
  }
  return values;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    return "";
  }
  return args[index + 1];
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function expandEnvValue(value, values) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) =>
    values[name] || process.env[name] || "",
  );
}

function isReadableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isCli() {
  return process.argv[1]
    && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
}
