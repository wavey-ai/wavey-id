#!/usr/bin/env node

import https from "node:https";

const args = new Set(process.argv.slice(2));
const requireZeroth = args.has("--require-zeroth");
const expectedOrigin = process.env.ZEROTH_EXPECTED_ORIGIN || "https://id.wavey.ai";
const resolveIp = process.env.WAVEY_ID_RESOLVE_IP || "";

const discovery = await jsonEndpoint("/.well-known/openid-configuration");
const ready = await jsonEndpoint("/ready");
const root = await textEndpoint("/");
const backend = classifyBackend({ discovery, ready, root });
const zerothLive = backend === "zeroth_ready" || backend === "zeroth_not_ready";

const summary = {
  ok: !requireZeroth || zerothLive,
  origin: expectedOrigin,
  backend,
  zeroth_live: zerothLive,
  discovery: {
    status: discovery.status,
    issuer: discovery.body?.issuer || null,
    authorization_endpoint: discovery.body?.authorization_endpoint || null,
    token_endpoint: discovery.body?.token_endpoint || null,
    jwks_uri: discovery.body?.jwks_uri || null,
    error: discovery.error || null,
  },
  ready: {
    status: ready.status,
    ready: ready.body?.ready ?? null,
    service: ready.body?.service || null,
    issuer: ready.body?.issuer || null,
    issuer_check: ready.body?.issuerCheck || null,
    signing: ready.body?.signing || null,
    providers: Array.isArray(ready.body?.providers) ? ready.body.providers : null,
    apple_app_site_association: ready.body?.appleAppSiteAssociation || null,
    notes: Array.isArray(ready.body?.notes) ? ready.body.notes : null,
    error: ready.error || ready.body?.error || null,
  },
  root: {
    status: root.status,
    title: root.body?.match(/<title>([^<]+)<\/title>/i)?.[1] || null,
    error: root.error || null,
  },
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.ok) {
  process.exit(1);
}

function classifyBackend({ discovery, ready, root }) {
  if (discovery.body?.issuer === expectedOrigin) {
    return ready.body?.ready === true ? "zeroth_ready" : "zeroth_not_ready";
  }
  if (typeof discovery.body?.issuer === "string" && discovery.body.issuer.length > 0) {
    return "external_issuer";
  }
  if (ready.status === 200 && ready.body?.ready === true) {
    return "zeroth_ready";
  }
  return "unknown";
}

async function jsonEndpoint(pathname) {
  const response = await request(pathname);
  if (response.error) {
    return response;
  }
  try {
    return {
      ...response,
      body: JSON.parse(response.body),
    };
  } catch (error) {
    return {
      ...response,
      body: null,
      error: `could not parse JSON: ${error.message}`,
    };
  }
}

async function textEndpoint(pathname) {
  return request(pathname);
}

function request(pathname) {
  const url = new URL(pathname, expectedOrigin);
  const headers = {};
  const options = {};
  if (resolveIp) {
    options.lookup = (hostname, options, callback) => {
      callback(null, resolveIp, resolveIp.includes(":") ? 6 : 4);
    };
    headers.Host = url.hostname;
  }

  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        ...options,
        method: "GET",
        headers,
        timeout: 10_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 128_000) {
            req.destroy(new Error("response body too large"));
          }
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", (error) => {
      resolve({
        status: 0,
        body: null,
        error: error.message,
      });
    });
    req.end();
  });
}
