#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const defaultOrigin = "https://id.wavey.ai";
const clientId = "wavey-ios";
const swiftRedirectUris = [
  "wavey://auth/callback",
  "com.waveyai.iosWavey://id.wavey.ai/ios/com.waveyai.iosWavey/callback",
  "com.waveyai.auPlay.auPlayExtension://id.wavey.ai/ios/com.waveyai.auPlay.auPlayExtension/callback",
  "com.waveyai.auSend.auSendExtension://id.wavey.ai/ios/com.waveyai.auSend.auSendExtension/callback",
];

if (isCli()) {
  runCli(process.argv.slice(2));
}

async function runCli(rawArgs) {
  const args = new Set(rawArgs);
  const requireReady = args.has("--require-ready");
  const origin = argValue(rawArgs, "--origin") || defaultOrigin;
  const envFile = argValue(rawArgs, "--env-file") || ".wrangler/zeroth-bootstrap.env";
  const envFileValues = readEnvFile(envFile);
  const adminToken =
    process.env.ZEROTH_ADMIN_TOKEN ||
    process.env.ADMIN_TOKEN ||
    envFileValues.ZEROTH_ADMIN_TOKEN ||
    envFileValues.ADMIN_TOKEN ||
    "";

  const summary = await swiftStatusSummary({
    origin,
    adminToken,
    fetchFn: fetch,
  });

  console.log(JSON.stringify(summary, null, 2));

  if (requireReady && !summary.ready) {
    process.exit(1);
  }
}

export async function swiftStatusSummary({
  origin = defaultOrigin,
  adminToken = "",
  fetchFn = fetch,
} = {}) {
  const discovery = await discoveryCheck({ origin, fetchFn });
  const client = await clientCheck({ origin, adminToken, fetchFn });
  const promptNoneRedirects = [];
  for (const redirectUri of swiftRedirectUris) {
    promptNoneRedirects.push(
      await promptNoneRedirectCheck({
        origin,
        redirectUri,
        fetchFn,
      }),
    );
  }

  const checks = {
    discovery: discovery.ok,
    client_registration: client.ok,
    prompt_none_redirects: promptNoneRedirects.every((check) => check.ok),
  };
  const blockers = [];
  if (!checks.discovery) {
    blockers.push("OIDC discovery is missing native-client features");
  }
  if (!checks.client_registration) {
    blockers.push("wavey-ios client registration is missing Swift redirect URIs");
  }
  if (!checks.prompt_none_redirects) {
    blockers.push("prompt=none does not return bounded Swift redirect errors");
  }

  return {
    ok: blockers.length === 0,
    ready: blockers.length === 0,
    origin,
    client_id: clientId,
    checks,
    discovery,
    client,
    prompt_none_redirects: promptNoneRedirects,
    blockers,
  };
}

async function discoveryCheck({ origin, fetchFn }) {
  const url = new URL("/.well-known/openid-configuration", origin);
  const response = await fetchFn(url, { redirect: "manual" });
  const body = await jsonBody(response);
  const expected = {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/oauth/token`,
  };
  const features = {
    query_response_mode: arrayIncludes(body?.response_modes_supported, "query"),
    authorization_code_grant: arrayIncludes(body?.grant_types_supported, "authorization_code"),
    refresh_token_grant: arrayIncludes(body?.grant_types_supported, "refresh_token"),
    s256_pkce: arrayIncludes(body?.code_challenge_methods_supported, "S256"),
    openid_scope: arrayIncludes(body?.scopes_supported, "openid"),
    email_scope: arrayIncludes(body?.scopes_supported, "email"),
    profile_scope: arrayIncludes(body?.scopes_supported, "profile"),
    offline_access_scope: arrayIncludes(body?.scopes_supported, "offline_access"),
  };
  const ok =
    response.status === 200 &&
    body?.issuer === expected.issuer &&
    body?.authorization_endpoint === expected.authorization_endpoint &&
    body?.token_endpoint === expected.token_endpoint &&
    Object.values(features).every(Boolean);

  return {
    ok,
    status: response.status,
    expected,
    features,
  };
}

async function clientCheck({ origin, adminToken, fetchFn }) {
  if (!adminToken) {
    return {
      ok: false,
      status: null,
      client_present: false,
      public_client: false,
      redirect_uris_present: false,
      missing_redirect_uris: swiftRedirectUris,
      error: "ADMIN_TOKEN or ZEROTH_ADMIN_TOKEN is required for client registration check",
    };
  }

  const url = new URL("/clients", origin);
  url.searchParams.set("client_id", clientId);
  const response = await fetchFn(url, {
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });
  const body = await jsonBody(response);
  const redirectUris = Array.isArray(body?.redirectUris)
    ? body.redirectUris
    : Array.isArray(body?.redirect_uris)
      ? body.redirect_uris
      : [];
  const missingRedirectUris = swiftRedirectUris.filter((uri) => !redirectUris.includes(uri));
  const publicClient = body?.confidential === false;
  const clientPresent = body?.id === clientId || body?.clientId === clientId;

  return {
    ok:
      response.status === 200 &&
      clientPresent &&
      publicClient &&
      missingRedirectUris.length === 0,
    status: response.status,
    client_present: clientPresent,
    public_client: publicClient,
    redirect_uris_present: missingRedirectUris.length === 0,
    missing_redirect_uris: missingRedirectUris,
  };
}

async function promptNoneRedirectCheck({ origin, redirectUri, fetchFn }) {
  const state = "swift-state-check";
  const authUrl = swiftAuthorizeUrl({ origin, redirectUri, state });
  const response = await fetchFn(authUrl, { redirect: "manual" });
  const location = response.headers.get("location") || "";
  const parsedLocation = safeUrl(location);
  const parsedRedirect = safeUrl(redirectUri);
  const parameters = parsedLocation
    ? Object.fromEntries(parsedLocation.searchParams.entries())
    : {};
  const expectedTarget =
    parsedLocation &&
    parsedRedirect &&
    parsedLocation.protocol === parsedRedirect.protocol &&
    parsedLocation.host === parsedRedirect.host &&
    parsedLocation.pathname === parsedRedirect.pathname;
  const ok =
    response.status === 302 &&
    expectedTarget === true &&
    parameters.error === "login_required" &&
    parameters.state === state &&
    parameters.iss === origin;

  return {
    ok,
    redirect_uri: redirectUri,
    status: response.status,
    location_target_matches: expectedTarget === true,
    error: parameters.error || null,
    state_preserved: parameters.state === state,
    issuer_preserved: parameters.iss === origin,
  };
}

export function swiftAuthorizeUrl({
  origin = defaultOrigin,
  redirectUri = swiftRedirectUris[0],
  state = "swift-state-check",
} = {}) {
  const url = new URL("/authorize", origin);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", "swift-nonce-check");
  url.searchParams.set("prompt", "none");
  url.searchParams.set("code_challenge", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH");
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

async function jsonBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

function arrayIncludes(values, item) {
  return Array.isArray(values) && values.includes(item);
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
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
