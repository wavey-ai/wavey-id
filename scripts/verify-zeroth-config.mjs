#!/usr/bin/env node

import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const allowPlaceholders = args.has("--allow-placeholders");
const allowNotReady = args.has("--allow-not-ready");
const live = args.has("--live") || process.env.ZEROTH_VERIFY_LIVE === "1";
const requireAdmin = args.has("--require-admin") || process.env.ZEROTH_VERIFY_REQUIRE_ADMIN === "1";
const envFileValues = readEnvFile(argValue("--env-file"));
const adminToken =
  process.env.ZEROTH_ADMIN_TOKEN ||
  process.env.ADMIN_TOKEN ||
  envFileValues.ZEROTH_ADMIN_TOKEN ||
  envFileValues.ADMIN_TOKEN ||
  "";
const resolveIp = process.env.WAVEY_ID_RESOLVE_IP || "";
const expectedOrigin = process.env.ZEROTH_EXPECTED_ORIGIN || "https://id.wavey.ai";
const expectedHost = new URL(expectedOrigin).hostname;
const expectedAccountId = "c57bb20727aa3564966d2bb693abddce";
const expectedSessionCookieDomain = ".wavey.ai";
const expectedClientIds = [
  "wavey-browser",
  "wavey-ios",
  "infidelity-macos",
  "bitneedle-web",
  "infidelity-web",
];
const expectedRedirectUris = [
  "https://wavey.ai/auth/callback",
  "https://bitneedle.com/auth/callback",
  "https://infidelity.io/auth/callback",
  "wavey://auth/callback",
  "http://localhost/oidc-callback",
];

const failures = [];
const configPath = path.join(root, "wrangler.zeroth.jsonc");
const clientsPath = path.join(root, "zeroth.clients.sql");
const config = readJson(configPath);
const clientsSql = fs.readFileSync(clientsPath, "utf8");
const publicBaseUrl = process.env.PUBLIC_BASE_URL || config.vars?.PUBLIC_BASE_URL;

checkWranglerConfig(config);
checkSeededClients(clientsSql);

let liveSummary = null;
if (live && failures.length === 0) {
  try {
    liveSummary = await checkLiveDeployment(publicBaseUrl);
  } catch (error) {
    fail("live_request", {
      description: error.message,
    });
  }
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failures,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      public_base_url: publicBaseUrl,
      account_id: config.account_id,
      route: routePattern(config),
      session_cookie_domain: config.vars?.SESSION_COOKIE_DOMAIN || null,
      d1_database: d1Database(config)?.database_name,
      default_login_client_id: config.vars?.DEFAULT_LOGIN_CLIENT_ID,
      live: liveSummary,
    },
    null,
    2,
  ),
);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail("wrangler_config_json", {
      file: path.relative(root, filePath),
      description: `could not parse JSON config: ${error.message}`,
    });
    return {};
  }
}

function argValue(name) {
  const index = rawArgs.indexOf(name);
  if (index === -1) {
    return "";
  }
  if (index + 1 >= rawArgs.length) {
    fail("argument", {
      argument: name,
      expected: "path value",
    });
    return "";
  }
  return rawArgs[index + 1];
}

function readEnvFile(filePath) {
  if (!filePath) {
    return {};
  }
  const resolved = path.resolve(root, filePath);
  try {
    if (!fs.statSync(resolved).isFile()) {
      fail("env_file", {
        file: filePath,
        expected: "readable file",
      });
      return {};
    }
  } catch {
    fail("env_file", {
      file: filePath,
      expected: "readable file",
    });
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

function checkWranglerConfig(config) {
  check(config.name === "wavey-id-worker", "worker_name", {
    actual: config.name,
    expected: "wavey-id-worker",
  });
  check(config.workers_dev === false, "workers_dev_disabled", {
    actual: config.workers_dev,
    expected: false,
  });
  check(config.account_id === expectedAccountId, "account_id", {
    actual: config.account_id,
    expected: expectedAccountId,
  });
  check(config.observability?.enabled === true, "observability_enabled", {
    actual: config.observability,
    expected: { enabled: true },
  });
  check(config.main === "../zeroth/crates/zeroth-worker/build/worker/shim.mjs", "worker_main", {
    actual: config.main,
    expected: "../zeroth/crates/zeroth-worker/build/worker/shim.mjs",
  });
  check(String(config.build?.command || "").includes("worker-build --release"), "worker_build", {
    actual: config.build?.command,
    expected: "worker-build --release",
  });

  const baseUrl = safeUrl(publicBaseUrl);
  check(Boolean(baseUrl), "public_base_url_parse", {
    actual: publicBaseUrl,
    expected: expectedOrigin,
  });
  if (baseUrl) {
    check(baseUrl.origin === expectedOrigin, "public_base_url_origin", {
      actual: baseUrl.origin,
      expected: expectedOrigin,
    });
    check(baseUrl.protocol === "https:", "public_base_url_https", {
      actual: baseUrl.protocol,
      expected: "https:",
    });
  }

  const route = routePattern(config);
  check(route === `${expectedHost}/*`, "route_pattern", {
    actual: route,
    expected: `${expectedHost}/*`,
  });
  check(config.routes?.some((entry) => entry.zone_name === "wavey.ai"), "route_zone", {
    actual: config.routes,
    expected: "zone_name wavey.ai",
  });

  const db = d1Database(config);
  check(db?.binding === "ZEROTH_DB", "d1_binding", {
    actual: db?.binding,
    expected: "ZEROTH_DB",
  });
  check(db?.database_name === "wavey-id-zeroth", "d1_database_name", {
    actual: db?.database_name,
    expected: "wavey-id-zeroth",
  });
  checkConfiguredValue("d1_database_id", db?.database_id, "replace-with-d1-database-id");

  check(config.vars?.DEFAULT_LOGIN_CLIENT_ID === "wavey-browser", "default_login_client", {
    actual: config.vars?.DEFAULT_LOGIN_CLIENT_ID,
    expected: "wavey-browser",
  });
  check(config.vars?.SESSION_COOKIE_DOMAIN === expectedSessionCookieDomain, "session_cookie_domain", {
    actual: config.vars?.SESSION_COOKIE_DOMAIN,
    expected: expectedSessionCookieDomain,
  });
  check(safeCookieDomain(config.vars?.SESSION_COOKIE_DOMAIN), "session_cookie_domain_safe", {
    actual: config.vars?.SESSION_COOKIE_DOMAIN,
    expected: "ASCII cookie domain without header delimiters",
  });
  checkConfiguredValue(
    "apple_client_id",
    config.vars?.APPLE_CLIENT_ID,
    "replace-with-sign-in-with-apple-service-id",
  );
  checkConfiguredValue(
    "google_client_id",
    config.vars?.GOOGLE_CLIENT_ID,
    "replace-with-google-oauth-client-id",
  );
  checkConfiguredValue(
    "spotify_client_id",
    config.vars?.SPOTIFY_CLIENT_ID,
    "replace-with-spotify-oauth-client-id",
  );
}

function checkSeededClients(sql) {
  for (const clientId of expectedClientIds) {
    check(sql.includes(`'${clientId}'`), "seed_client", { client_id: clientId });
  }

  for (const redirectUri of expectedRedirectUris) {
    check(sql.includes(redirectUri), "seed_redirect_uri", { redirect_uri: redirectUri });
  }

  check(sql.includes("allowed_email_domains_json"), "seed_allowed_email_domains_column", {
    expected: "allowed_email_domains_json column in zeroth.clients.sql",
  });
  check(
    countOccurrences(sql, "allowed_email_domains_json = excluded.allowed_email_domains_json")
      === expectedClientIds.length,
    "seed_allowed_email_domains_upsert",
    {
      expected: `${expectedClientIds.length} client upserts update allowed_email_domains_json`,
    },
  );
}

function countOccurrences(value, pattern) {
  return String(value || "").split(pattern).length - 1;
}

async function checkLiveDeployment(baseUrl) {
  const discoveryUrl = new URL("/.well-known/openid-configuration", baseUrl);
  const discoveryResponse = await fetchManual(discoveryUrl);
  const discovery = await parseJsonResponse(discoveryResponse, "openid_configuration");

  if (discoveryResponse.status !== 200) {
    fail("openid_configuration_status", {
      status: discoveryResponse.status,
      expected: 200,
    });
  }
  if (discovery) {
    check(discovery.issuer === expectedOrigin, "openid_configuration_issuer", {
      actual: discovery.issuer,
      expected: expectedOrigin,
    });
    check(discovery.authorization_endpoint === `${expectedOrigin}/authorize`, "authorize_endpoint", {
      actual: discovery.authorization_endpoint,
      expected: `${expectedOrigin}/authorize`,
    });
    check(discovery.token_endpoint === `${expectedOrigin}/oauth/token`, "token_endpoint", {
      actual: discovery.token_endpoint,
      expected: `${expectedOrigin}/oauth/token`,
    });
    check(discovery.jwks_uri === `${expectedOrigin}/.well-known/jwks.json`, "jwks_uri", {
      actual: discovery.jwks_uri,
      expected: `${expectedOrigin}/.well-known/jwks.json`,
    });
  }

  const readyUrl = new URL("/ready", baseUrl);
  const readyResponse = await fetchManual(readyUrl);
  const ready = await parseJsonResponse(readyResponse, "ready");
  if (readyResponse.status !== 200 || ready?.ready !== true) {
    if (!allowNotReady) {
      fail("ready_status", {
        status: readyResponse.status,
        ready: ready?.ready,
        expected: "200 with ready=true",
        readiness: readinessSummary(ready),
      });
    }
  }

  let admin = null;
  if (adminToken || requireAdmin) {
    admin = await checkLiveAdmin(baseUrl);
  }

  return {
    openid_configuration_status: discoveryResponse.status,
    ready_status: readyResponse.status,
    ready: ready?.ready ?? null,
    readiness: readinessSummary(ready),
    admin,
  };
}

async function checkLiveAdmin(baseUrl) {
  if (!adminToken) {
    fail("admin_token", {
      expected: "ZEROTH_ADMIN_TOKEN or ADMIN_TOKEN for admin live verification",
    });
    return null;
  }

  const headers = { Authorization: `Bearer ${adminToken}` };
  const dbStatusUrl = new URL("/__zeroth/db/status", baseUrl);
  const dbStatusResponse = await fetchManual(dbStatusUrl, { headers });
  const dbStatus = await parseJsonResponse(dbStatusResponse, "db_status");
  if (dbStatusResponse.status !== 200 || dbStatus?.ok !== true) {
    fail("db_status", {
      status: dbStatusResponse.status,
      ok: dbStatus?.ok,
      expected: "200 with ok=true",
      tables: dbStatus?.tables,
      migrations: dbStatus?.migrations,
      compatibilityColumns: dbStatus?.compatibilityColumns,
    });
  }
  if (dbStatus) {
    check(dbStatus.binding === "ZEROTH_DB", "db_status_binding", {
      actual: dbStatus.binding,
      expected: "ZEROTH_DB",
    });
    check(Number(dbStatus.clientCount || 0) >= expectedClientIds.length, "db_status_client_count", {
      actual: dbStatus.clientCount,
      expected: `at least ${expectedClientIds.length}`,
    });
  }

  const clientsUrl = new URL("/clients", baseUrl);
  const clientsResponse = await fetchManual(clientsUrl, { headers });
  const clients = await parseJsonResponse(clientsResponse, "clients");
  if (clientsResponse.status !== 200) {
    fail("clients_status", {
      status: clientsResponse.status,
      expected: 200,
    });
  }
  const actualClientIds = Array.isArray(clients?.clients)
    ? clients.clients.map((client) => client.id || client.clientId).filter(Boolean)
    : [];
  for (const clientId of expectedClientIds) {
    check(actualClientIds.includes(clientId), "live_seed_client", {
      client_id: clientId,
      actual: actualClientIds,
    });
  }

  return {
    db_status: dbStatusResponse.status,
    clients_status: clientsResponse.status,
    client_count: actualClientIds.length,
  };
}

async function parseJsonResponse(response, checkName) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch (error) {
    fail(`${checkName}_json`, {
      status: response.status,
      description: `could not parse JSON response: ${error.message}`,
      body_prefix: body.slice(0, 160),
    });
    return null;
  }
}

function checkConfiguredValue(checkName, value, placeholder) {
  if (allowPlaceholders && value === placeholder) {
    return;
  }
  check(typeof value === "string" && value.trim() !== "" && value !== placeholder, checkName, {
    actual: value,
    expected: `configured value, not ${placeholder}`,
  });
}

function routePattern(config) {
  return config.routes?.find((entry) => entry.zone_name === "wavey.ai")?.pattern;
}

function d1Database(config) {
  return config.d1_databases?.find((entry) => entry.binding === "ZEROTH_DB");
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function safeCookieDomain(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value
      .trim()
      .split("")
      .every((char) => /[A-Za-z0-9.-]/.test(char))
  );
}

function check(condition, checkName, details) {
  if (!condition) fail(checkName, details);
}

function fail(checkName, details) {
  failures.push({ check: checkName, ...details });
}

function readinessSummary(ready) {
  if (!ready || typeof ready !== "object") {
    return null;
  }
  return {
    issuer_check: ready.issuerCheck || null,
    signing: ready.signing || null,
    providers: Array.isArray(ready.providers) ? ready.providers : null,
    apple_app_site_association: ready.appleAppSiteAssociation || null,
    notes: Array.isArray(ready.notes) ? ready.notes : null,
  };
}

function fetchManual(url, options = {}) {
  const headers = options.headers || {};
  if (!resolveIp || url.hostname !== expectedHost) {
    return fetch(url, { redirect: "manual", headers });
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: { Host: url.hostname, ...headers },
        servername: url.hostname,
        lookup: (_hostname, options, callback) => {
          const done = typeof options === "function" ? options : callback;
          if (typeof options === "object" && options?.all) {
            done(null, [{ address: resolveIp, family: 4 }]);
          } else {
            done(null, resolveIp, 4);
          }
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(name, item);
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }
          resolve({
            status: response.statusCode,
            headers,
            text: async () => body,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}
