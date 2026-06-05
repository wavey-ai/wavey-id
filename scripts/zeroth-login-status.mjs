#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const defaultOrigin = "https://id.wavey.ai";
const providerChecks = [
  {
    id: "apple",
    label: "Apple",
    expectedHost: "appleid.apple.com",
    expectedPath: "/auth/authorize",
    expectedScopes: ["email", "name"],
    expectedResponseMode: "form_post",
    clientIdEnv: "APPLE_CLIENT_ID",
  },
  {
    id: "google",
    label: "Google",
    expectedHost: "accounts.google.com",
    expectedPath: "/o/oauth2/v2/auth",
    expectedScopes: ["openid", "email", "profile"],
    clientIdEnv: "GOOGLE_CLIENT_ID",
  },
  {
    id: "spotify",
    label: "Spotify",
    expectedHost: "accounts.spotify.com",
    expectedPath: "/authorize",
    expectedScopes: ["user-read-email", "user-read-private"],
    clientIdEnv: "SPOTIFY_CLIENT_ID",
  },
];

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
  const config = readJson(path.join(root, "wrangler.zeroth.jsonc"));
  const disabledProviderIds = disabledProviderSet(config?.vars?.DISABLED_PROVIDERS || "");

  return loginStatusSummary({
    origin,
    config,
    disabledProviderIds,
    requireReady,
    fetchFn: fetch,
  });
}

export async function loginStatusSummary({
  origin = defaultOrigin,
  config = {},
  disabledProviderIds = disabledProviderSet(config?.vars?.DISABLED_PROVIDERS || ""),
  requireReady = false,
  fetchFn = fetch,
} = {}) {
  const providerResults = [];
  for (const provider of providerChecks) {
    providerResults.push(
      await providerLoginCheck({
        origin,
        provider,
        disabled: disabledProviderIds.has(provider.id),
        expectedClientId: config?.vars?.[provider.clientIdEnv] || "",
        fetchFn,
      }),
    );
  }
  const hostedPicker = await hostedPickerCheck({ origin, providerResults, fetchFn });
  const checks = {
    active_provider_redirects: providerResults
      .filter((provider) => !provider.disabled)
      .every((provider) => provider.ok),
    disabled_provider_rejections: providerResults
      .filter((provider) => provider.disabled)
      .every((provider) => provider.ok),
    hosted_picker: hostedPicker.ok,
  };
  const blockers = [
    ...providerResults.flatMap((provider) =>
      provider.blockers.map((blocker) => `${provider.label}: ${blocker}`),
    ),
    ...hostedPicker.blockers.map((blocker) => `hosted picker: ${blocker}`),
  ];

  return {
    ok: blockers.length === 0,
    ready: blockers.length === 0,
    require_ready: requireReady,
    origin,
    checks,
    providers: providerResults,
    hosted_picker: hostedPicker,
    blockers,
  };
}

async function providerLoginCheck({
  origin,
  provider,
  disabled,
  expectedClientId = "",
  fetchFn,
}) {
  const url = new URL("/login", origin);
  url.searchParams.set("provider", provider.id);
  url.searchParams.set("return_to", `${origin}/admin`);
  const response = await fetchFn(url, { redirect: "manual" });
  const location = response.headers.get("location") || "";
  const parsedLocation = safeUrl(location);
  const body = await bodyText(response);
  const payload = parseJson(body);
  const blockers = [];

  if (disabled) {
    if (response.status !== 400) {
      blockers.push(`disabled provider returned HTTP ${response.status}, expected 400`);
    }
    if (parsedLocation) {
      blockers.push("disabled provider redirected upstream");
    }
    if (!String(payload?.errorDescription || body).includes("provider is not fully configured")) {
      blockers.push("disabled provider did not return a bounded configuration error");
    }
    return providerResult({
      provider,
      disabled,
      response,
      parsedLocation,
      body,
      ok: blockers.length === 0,
      blockers,
    });
  }

  const searchParams = parsedLocation?.searchParams || new URLSearchParams();
  const scopes = scopeSet(searchParams.get("scope") || "");

  if (response.status !== 302) {
    blockers.push(`returned HTTP ${response.status}, expected upstream redirect`);
  }
  if (!parsedLocation) {
    blockers.push("missing upstream redirect location");
  } else {
    if (parsedLocation.hostname !== provider.expectedHost) {
      blockers.push(`redirected to ${parsedLocation.hostname}, expected ${provider.expectedHost}`);
    }
    if (parsedLocation.pathname !== provider.expectedPath) {
      blockers.push(`redirect path is ${parsedLocation.pathname}, expected ${provider.expectedPath}`);
    }
  }
  if (expectedClientId && searchParams.get("client_id") !== expectedClientId) {
    blockers.push("upstream client_id did not match deployment config");
  }
  if (isPlaceholder(searchParams.get("client_id"))) {
    blockers.push("upstream client_id is missing or placeholder");
  }
  if (searchParams.get("redirect_uri") !== `${origin}/oauth2/callback`) {
    blockers.push("upstream redirect_uri is not the Zeroth callback");
  }
  if (!searchParams.get("state")) {
    blockers.push("upstream redirect is missing state");
  }
  if (!response.headers.get("set-cookie")) {
    blockers.push("provider transaction cookie was not set");
  }
  for (const scope of provider.expectedScopes) {
    if (!scopes.has(scope)) {
      blockers.push(`missing upstream scope ${scope}`);
    }
  }
  if (
    provider.expectedResponseMode &&
    searchParams.get("response_mode") !== provider.expectedResponseMode
  ) {
    blockers.push(`response_mode is not ${provider.expectedResponseMode}`);
  }

  return providerResult({
    provider,
    disabled,
    response,
    parsedLocation,
    body,
    ok: blockers.length === 0,
    blockers,
  });
}

async function hostedPickerCheck({ origin, providerResults, fetchFn }) {
  const url = new URL("/login", origin);
  url.searchParams.set("return_to", `${origin}/admin`);
  const response = await fetchFn(url, { redirect: "manual" });
  const body = await bodyText(response);
  const blockers = [];
  if (response.status !== 200) {
    blockers.push(`returned HTTP ${response.status}, expected hosted login page`);
  }
  for (const provider of providerResults.filter((item) => !item.disabled)) {
    if (!body.includes(`provider=${provider.id}`)) {
      blockers.push(`${provider.label} login link is missing`);
    }
  }
  for (const provider of providerResults.filter((item) => item.disabled)) {
    if (body.includes(`provider=${provider.id}`)) {
      blockers.push(`${provider.label} login link is visible while disabled`);
    }
  }
  return {
    ok: blockers.length === 0,
    status: response.status,
    active_provider_links_present: blockers.filter((item) => item.includes("missing")).length === 0,
    disabled_provider_links_hidden:
      blockers.filter((item) => item.includes("visible while disabled")).length === 0,
    blockers,
  };
}

function providerResult({ provider, disabled, response, parsedLocation, body, ok, blockers }) {
  return {
    id: provider.id,
    label: provider.label,
    disabled,
    ok,
    status: response.status,
    location_host: parsedLocation?.hostname || null,
    location_path: parsedLocation?.pathname || null,
    redirected_to_provider: parsedLocation?.hostname === provider.expectedHost,
    transaction_cookie_set: Boolean(response.headers.get("set-cookie")),
    error: parseJson(body)?.error || null,
    blockers,
  };
}

function scopeSet(value) {
  return new Set(String(value || "").split(/\s+/).filter(Boolean));
}

function disabledProviderSet(value) {
  return new Set(
    String(value || "")
      .split(/[,\s]+/)
      .map((provider) => provider.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isPlaceholder(value) {
  const text = String(value || "").trim().toLowerCase();
  return !text || text.startsWith("replace-with-") || text.includes("changeme");
}

async function bodyText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    return "";
  }
  return args[index + 1];
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isCli() {
  return process.argv[1]
    && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
}
