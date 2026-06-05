#!/usr/bin/env node

import fs from "node:fs";

const spotifyProfileEndpoint = "https://api.spotify.com/v1/me";
const activationRequirements = [
  "Spotify app owner account has Premium while the app is in development mode",
  "Spotify test login user is allowlisted in the Spotify app Users Management tab",
  "Spotify current-user profile endpoint /v1/me returns HTTP 200 for an authorized user",
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
  const accessToken =
    process.env.SPOTIFY_ACCESS_TOKEN ||
    readOptionalTextFile(argValue(rawArgs, "--access-token-file")) ||
    "";

  return spotifyStatusSummary({
    requireReady,
    accessToken,
    fetchFn: fetch,
  });
}

export async function spotifyStatusSummary({
  requireReady = false,
  accessToken = "",
  fetchFn = fetch,
  endpoint = spotifyProfileEndpoint,
} = {}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    const blockers = [
      "SPOTIFY_ACCESS_TOKEN is not set; authorize a Spotify test user and re-run with a token that has user-read-email and user-read-private",
    ];
    return {
      ok: !requireReady,
      ready: false,
      require_ready: requireReady,
      checked: false,
      endpoint,
      checks: {
        access_token_present: false,
        profile_endpoint: false,
        usable_subject: false,
      },
      profile: null,
      activation_requirements: activationRequirements,
      blockers,
      warnings: [],
    };
  }

  const response = await fetchFn(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const rawBody = await bodyText(response);
  const body = parseJson(rawBody);
  const profile = spotifyProfileSummary(body);
  const checks = {
    access_token_present: true,
    profile_endpoint: response.status === 200,
    usable_subject: Boolean(profile.subject_source),
  };
  const blockers = spotifyProfileBlockers(response.status, body, rawBody, checks);
  const warnings = spotifyProfileWarnings(profile);
  const ready = blockers.length === 0 && Object.values(checks).every(Boolean);

  return {
    ok: !requireReady || ready,
    ready,
    require_ready: requireReady,
    checked: true,
    endpoint,
    status: response.status,
    checks,
    profile,
    activation_requirements: activationRequirements,
    blockers,
    warnings,
  };
}

function spotifyProfileSummary(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      account_id_present: false,
      legacy_id_present: false,
      subject_source: null,
      email_present: false,
      display_name_present: false,
      image_present: false,
      product_present: false,
    };
  }
  const accountIdPresent = nonEmptyString(body.account_id);
  const legacyIdPresent = nonEmptyString(body.id);
  const imagePresent =
    Array.isArray(body.images) &&
    body.images.some((image) => nonEmptyString(image?.url));
  return {
    account_id_present: accountIdPresent,
    legacy_id_present: legacyIdPresent,
    subject_source: accountIdPresent ? "account_id" : legacyIdPresent ? "id" : null,
    email_present: nonEmptyString(body.email),
    display_name_present: nonEmptyString(body.display_name),
    image_present: imagePresent,
    product_present: nonEmptyString(body.product),
  };
}

function spotifyProfileBlockers(status, body, rawBody, checks) {
  const blockers = [];
  if (status === 401) {
    blockers.push("Spotify /v1/me rejected the access token with HTTP 401");
  } else if (status === 403) {
    blockers.push("Spotify /v1/me returned HTTP 403");
    blockers.push(...activationRequirements);
  } else if (status !== 200) {
    blockers.push(`Spotify /v1/me returned HTTP ${status}`);
  }
  if (status !== 200) {
    const detail = spotifyErrorDetail(body, rawBody);
    if (detail) {
      blockers.push(`Spotify response: ${detail}`);
    }
  }
  if (status === 200 && !checks.usable_subject) {
    blockers.push("Spotify profile did not include account_id or id for stable account linking");
  }
  return blockers;
}

function spotifyProfileWarnings(profile) {
  const warnings = [];
  if (profile.subject_source === "id") {
    warnings.push("Spotify profile did not include account_id; Zeroth will fall back to legacy id");
  }
  if (profile.subject_source && !profile.email_present) {
    warnings.push("Spotify profile did not include email; restricted client email-domain policies may reject login");
  }
  return warnings;
}

function spotifyErrorDetail(body, rawBody) {
  const candidates = [
    body?.error_description,
    body?.errorDescription,
    body?.error?.message,
    typeof body?.error === "string" ? body.error : "",
    rawBody,
  ];
  return candidates
    .map((value) => boundedStatusText(value, 240))
    .find(Boolean) || "";
}

function boundedStatusText(value, maxChars) {
  if (typeof value !== "string") {
    return "";
  }
  const text = value
    .trim()
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9._~+/=-]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ");
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

async function bodyText(response) {
  try {
    return await response.text();
  } catch (_error) {
    return "";
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function readOptionalTextFile(filePath) {
  if (!filePath) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (_error) {
    return "";
  }
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function isCli() {
  return import.meta.url === `file://${process.argv[1]}`;
}
