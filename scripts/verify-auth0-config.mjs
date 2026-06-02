#!/usr/bin/env node

import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
const publicBaseUrl = process.env.PUBLIC_BASE_URL || config.vars.PUBLIC_BASE_URL;
const resolveIp = process.env.WAVEY_ID_RESOLVE_IP || "";
const returnTo = process.env.RETURN_TO || "https://bitneedle.com/dataroom/";

const loginUrl = new URL("/login", publicBaseUrl);
loginUrl.searchParams.set("return_to", returnTo);

const loginResponse = await fetchManual(loginUrl);
const location = loginResponse.headers.get("location");

if (loginResponse.status !== 302 || !location) {
  fail("wavey_login_redirect", {
    status: loginResponse.status,
    expected: "302 with Auth0 location",
  });
}

const auth0Url = new URL(location);
if (auth0Url.hostname !== config.vars.AUTH0_DOMAIN) {
  fail("auth0_redirect_host", {
    actual: auth0Url.hostname,
    expected: config.vars.AUTH0_DOMAIN,
  });
}

const redirectUri = auth0Url.searchParams.get("redirect_uri");
const expectedRedirectUri = new URL("/oauth2/callback", publicBaseUrl).toString();
if (redirectUri !== expectedRedirectUri) {
  fail("auth0_redirect_uri", { actual: redirectUri, expected: expectedRedirectUri });
}

const auth0Response = await fetchManual(auth0Url);
const body = await auth0Response.text();
const callbackMismatch = /Callback URL mismatch/i.test(body);

if (callbackMismatch) {
  fail("auth0_callback_url_missing", {
    status: auth0Response.status,
    required_callback_url: expectedRedirectUri,
    client_id: config.vars.AUTH0_CLIENT_ID,
  });
}

if (![200, 302].includes(auth0Response.status)) {
  fail("auth0_authorize", {
    status: auth0Response.status,
    expected: "200 login page or 302 session redirect",
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      login_status: loginResponse.status,
      auth0_status: auth0Response.status,
      callback_url: expectedRedirectUri,
      client_id: config.vars.AUTH0_CLIENT_ID,
    },
    null,
    2,
  ),
);

function fail(check, details) {
  console.error(JSON.stringify({ ok: false, check, ...details }, null, 2));
  process.exit(1);
}

function fetchManual(url) {
  if (!resolveIp || url.hostname !== new URL(publicBaseUrl).hostname) {
    return fetch(url, { redirect: "manual" });
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: { Host: url.hostname },
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
