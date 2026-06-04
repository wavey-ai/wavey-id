#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const issuerId =
  argValue("--issuer-id") ||
  process.env.ASC_ISSUER_ID ||
  process.env.APP_STORE_CONNECT_ISSUER_ID ||
  process.env.APPLE_ASC_ISSUER_ID ||
  "";
const keyPath =
  argValue("--api-key-path") ||
  process.env.ASC_KEY_PATH ||
  process.env.APP_STORE_CONNECT_KEY_PATH ||
  discoverApiKeyPath();
const keyId = argValue("--api-key-id") || process.env.ASC_KEY_ID || keyIdFromPath(keyPath);
const bundleIdentifier =
  argValue("--bundle-identifier") ||
  process.env.ZEROTH_APPLE_BUNDLE_ID ||
  "ai.wavey.id";
const bundleName =
  argValue("--name") ||
  process.env.ZEROTH_APPLE_BUNDLE_NAME ||
  "Wavey ID Zeroth";
const platform = argValue("--platform") || process.env.ZEROTH_APPLE_PLATFORM || "IOS";

if (!issuerId) {
  fail("missing App Store Connect issuer id; set ASC_ISSUER_ID or pass --issuer-id");
}
if (!keyPath) {
  fail("missing App Store Connect API key path; set ASC_KEY_PATH or pass --api-key-path");
}
if (!keyId) {
  fail("missing App Store Connect API key id; set ASC_KEY_ID or use an AuthKey_<KEYID>.p8 filename");
}
if (!["IOS", "MAC_OS", "UNIVERSAL"].includes(platform)) {
  fail("invalid platform; expected IOS, MAC_OS, or UNIVERSAL");
}

const apiKey = readPrivateKey(keyPath);
const steps = [];
const warnings = [];

class ApiError extends Error {
  constructor({ status, code, title, detail }) {
    super(detail || title || code || `HTTP ${status}`);
    this.status = status;
    this.code = code || null;
    this.title = title || null;
    this.detail = detail || null;
  }
}

try {
  const bundle = await ensureBundleId();
  if (bundle.id) {
    await ensureAppleIdAuthCapability(bundle);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        applied: apply,
        bundle_identifier: bundleIdentifier,
        bundle_name: bundleName,
        platform,
        app_store_connect_api: {
          auth: "verified",
          key_path_configured: true,
          issuer_id_configured: true,
        },
        steps,
        warnings,
        manual_provider_steps: [
          "Create a fresh Sign in with Apple key in the Apple Developer portal for this primary App ID and download AuthKey_<KEYID>.p8.",
          "Create a fresh Sign in with Apple Services ID for id.wavey.ai.",
          "Configure the Services ID web domain as id.wavey.ai and return URL as https://id.wavey.ai/oauth2/callback.",
          "Set APPLE_CLIENT_ID in wrangler.zeroth.jsonc to the Services ID identifier.",
          "Upload APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY_PATH with npm run zeroth:secrets:apple.",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (error instanceof ApiError) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          status: error.status,
          code: error.code,
          title: error.title,
          detail: error.detail,
          steps,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  throw error;
}

async function ensureBundleId() {
  const existing = await findBundleId(bundleIdentifier);
  if (existing) {
    steps.push({
      action: "bundle_id",
      status: "exists",
      id: existing.id,
      identifier: existing.attributes?.identifier || bundleIdentifier,
    });
    return existing;
  }

  if (!apply) {
    steps.push({
      action: "bundle_id",
      status: "would_create",
      identifier: bundleIdentifier,
      name: bundleName,
      platform,
    });
    return { id: null, attributes: { identifier: bundleIdentifier } };
  }

  const created = await ascPost("/v1/bundleIds", {
    data: {
      type: "bundleIds",
      attributes: {
        name: bundleName,
        platform,
        identifier: bundleIdentifier,
      },
    },
  });
  steps.push({
    action: "bundle_id",
    status: "created",
    id: created.data.id,
    identifier: created.data.attributes?.identifier || bundleIdentifier,
  });
  return created.data;
}

async function ensureAppleIdAuthCapability(bundle) {
  const capabilities = await ascGet(
    `/v1/bundleIds/${encodeURIComponent(bundle.id)}/bundleIdCapabilities`,
  );
  const existing = (capabilities.data || []).find(
    (capability) => capability.attributes?.capabilityType === "APPLE_ID_AUTH",
  );
  if (existing) {
    steps.push({
      action: "apple_id_auth_capability",
      status: "exists",
      id: existing.id,
      bundle_id: bundle.id,
    });
    return;
  }

  if (!apply) {
    steps.push({
      action: "apple_id_auth_capability",
      status: "would_enable",
      bundle_id: bundle.id,
    });
    return;
  }

  const created = await ascPost("/v1/bundleIdCapabilities", {
    data: {
      type: "bundleIdCapabilities",
      attributes: {
        capabilityType: "APPLE_ID_AUTH",
        settings: [
          {
            key: "APPLE_ID_AUTH_APP_CONSENT",
            options: [
              {
                key: "PRIMARY_APP_CONSENT",
                enabled: true,
              },
            ],
          },
        ],
      },
      relationships: {
        bundleId: {
          data: {
            type: "bundleIds",
            id: bundle.id,
          },
        },
      },
    },
  });
  steps.push({
    action: "apple_id_auth_capability",
    status: "enabled",
    id: created.data.id,
    bundle_id: bundle.id,
  });
}

async function findBundleId(identifier) {
  const response = await ascGet(
    `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=1`,
  );
  return (response.data || []).find(
    (item) => item.attributes?.identifier === identifier,
  ) || null;
}

async function ascGet(endpoint) {
  return ascRequest("GET", endpoint);
}

async function ascPost(endpoint, body) {
  return ascRequest("POST", endpoint, body);
}

async function ascRequest(method, endpoint, body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt()}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = data.errors?.[0] || {};
    throw new ApiError({
      status: response.status,
      code: error.code,
      title: error.title,
      detail: error.detail,
    });
  }
  return data;
}

function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "ES256", kid: keyId, typ: "JWT" });
  const payload = base64UrlJson({
    iss: issuerId,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  });
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: apiKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function readPrivateKey(filePath) {
  const resolved = path.resolve(root, filePath);
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    fail(`App Store Connect API key is not readable: ${filePath}`);
  }
}

function discoverApiKeyPath() {
  const parent = path.resolve(root, "..");
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return "";
  }
  const matches = entries
    .filter((entry) => entry.isFile() && /^AppStore_AuthKey_[A-Z0-9]{10}\.p8$/.test(entry.name))
    .map((entry) => path.join(parent, entry.name))
    .sort();
  return matches.length === 1 ? matches[0] : "";
}

function keyIdFromPath(filePath) {
  const match = /(?:AppStore_)?AuthKey_([A-Z0-9]{10})\.p8$/u.exec(path.basename(filePath || ""));
  return match?.[1] || "";
}

function argValue(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return "";
  }
  if (index + 1 >= args.length) {
    fail(`${name} requires a value`);
  }
  return args[index + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
