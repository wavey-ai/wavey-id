#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
const domain = process.env.AUTH0_DOMAIN || config.vars.AUTH0_DOMAIN;
const clientId = process.env.AUTH0_TARGET_CLIENT_ID || config.vars.AUTH0_CLIENT_ID;
const managementBase = `https://${domain}/api/v2`;

const required = {
  callbacks: [
    "https://id.wavey.ai/oauth2/callback",
    "http://localhost:*/oidc-callback",
  ],
  allowed_logout_urls: [
    "https://id.wavey.ai/",
    "https://bitneedle.com/",
    "https://www.bitneedle.com/",
    "https://infidelity.io/",
    "https://www.infidelity.io/",
  ],
  web_origins: [
    "https://id.wavey.ai",
    "https://bitneedle.com",
    "https://www.bitneedle.com",
    "https://infidelity.io",
    "https://www.infidelity.io",
  ],
  allowed_origins: [
    "https://id.wavey.ai",
    "https://bitneedle.com",
    "https://www.bitneedle.com",
    "https://infidelity.io",
    "https://www.infidelity.io",
  ],
};

const token = await managementToken();
const current = await auth0Json(`/clients/${encodeURIComponent(clientId)}`, { token });
const patch = {};

for (const [key, urls] of Object.entries(required)) {
  const merged = mergeUnique(current[key], urls);
  if (JSON.stringify(merged) !== JSON.stringify(current[key] || [])) {
    patch[key] = merged;
  }
}

if (Object.keys(patch).length === 0) {
  console.log(JSON.stringify({ ok: true, changed: false, client_id: clientId }, null, 2));
  process.exit(0);
}

await auth0Json(`/clients/${encodeURIComponent(clientId)}`, {
  token,
  method: "PATCH",
  body: patch,
});

console.log(
  JSON.stringify(
    {
      ok: true,
      changed: true,
      client_id: clientId,
      added_or_verified: required,
    },
    null,
    2,
  ),
);

async function managementToken() {
  if (process.env.AUTH0_MANAGEMENT_TOKEN) {
    return process.env.AUTH0_MANAGEMENT_TOKEN;
  }

  const m2mClientId = process.env.AUTH0_MGMT_CLIENT_ID;
  const m2mClientSecret = process.env.AUTH0_MGMT_CLIENT_SECRET;
  if (!m2mClientId || !m2mClientSecret) {
    fail("missing_management_credentials", {
      required:
        "Set AUTH0_MANAGEMENT_TOKEN, or set AUTH0_MGMT_CLIENT_ID and AUTH0_MGMT_CLIENT_SECRET.",
    });
  }

  const response = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: m2mClientId,
      client_secret: m2mClientSecret,
      audience: `${managementBase}/`,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    fail("management_token_exchange_failed", {
      status: response.status,
      error: body.error || null,
      error_description: body.error_description || null,
    });
  }
  return body.access_token;
}

async function auth0Json(pathname, { token, method = "GET", body } = {}) {
  const response = await fetch(`${managementBase}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    fail("auth0_management_api_failed", {
      method,
      pathname,
      status: response.status,
      error: parsed.error || parsed.errorCode || null,
      message: parsed.message || null,
    });
  }
  return parsed;
}

function mergeUnique(existing, additions) {
  return [...new Set([...(Array.isArray(existing) ? existing : []), ...additions])];
}

function fail(check, details) {
  console.error(JSON.stringify({ ok: false, check, ...details }, null, 2));
  process.exit(1);
}
