import assert from "node:assert/strict";
import test from "node:test";

import { routeStatusSummary } from "./zeroth-route-status.mjs";

test("route status verifies common Zeroth and compatibility routes", async () => {
  const summary = await routeStatusSummary({
    origin: "https://id.example.com",
    fetchFn: fakeRouteFetch,
  });

  assert.equal(summary.ready, true);
  assert.equal(summary.checks.manifest, true);
  assert.equal(summary.checks.live_routes, true);
  assert.equal(summary.checks.no_not_found, true);
  assert.deepEqual(summary.blockers, []);
  assert.equal(
    summary.probes.find((probe) => probe.path === "/callback/apple").error,
    "invalid_request",
  );
});

test("route status reports manifest and live not_found regressions", async () => {
  const summary = await routeStatusSummary({
    origin: "https://id.example.com",
    fetchFn: async (input, options) => {
      const url = new URL(input);
      if (url.pathname === "/routes") {
        return Response.json({
          routes: routeManifest().filter((route) => route.path !== "/dashboard"),
        });
      }
      if (url.pathname === "/dashboard") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return fakeRouteFetch(input, options);
    },
  });

  assert.equal(summary.ready, false);
  assert.equal(summary.checks.manifest, false);
  assert.equal(summary.checks.no_not_found, false);
  assert.match(summary.blockers.join("\n"), /\/routes is missing GET \/dashboard/);
  assert.match(summary.blockers.join("\n"), /GET \/dashboard: returned router not_found/);
});

async function fakeRouteFetch(input, options = {}) {
  const url = new URL(input);
  const method = String(options.method || "GET").toUpperCase();
  if (url.pathname === "/routes") {
    return Response.json({ routes: routeManifest() });
  }
  if (url.pathname === "/.well-known/openid-configuration") {
    return Response.json({ issuer: "https://id.example.com" });
  }
  if (["/ready", "/status", "/api/status", "/login"].includes(url.pathname)) {
    return Response.json({ ready: true });
  }
  if (["/admin", "/ui", "/dashboard", "/console", "/auth/magic-link/send", "/api/auth/magic-link/send"].includes(url.pathname) && method === "GET") {
    return redirectResponse("https://id.example.com/login");
  }
  if (
    ["/callback", "/callback/apple", "/callback/google"].includes(url.pathname) ||
    (["/auth/magic-link/send", "/api/auth/magic-link/send"].includes(url.pathname) && method === "POST")
  ) {
    return Response.json(
      {
        error: "invalid_request",
        errorDescription: "expected validation failure",
      },
      { status: 400 },
    );
  }
  if (url.pathname === "/oauth/token" && method === "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

function routeManifest() {
  return [
    ["/.well-known/openid-configuration", "GET"],
    ["/ready", "GET"],
    ["/status", "GET"],
    ["/api/status", "GET"],
    ["/login", "GET"],
    ["/admin", "GET"],
    ["/ui", "GET"],
    ["/dashboard", "GET"],
    ["/console", "GET"],
    ["/routes", "GET"],
    ["/callback", "GET"],
    ["/callback", "POST"],
    ["/callback/{provider}", "GET"],
    ["/callback/{provider}", "POST"],
    ["/auth/magic-link/send", "GET"],
    ["/auth/magic-link/send", "POST"],
    ["/auth/magic-link/send", "OPTIONS"],
    ["/api/auth/magic-link/send", "GET"],
    ["/api/auth/magic-link/send", "POST"],
    ["/api/auth/magic-link/send", "OPTIONS"],
  ].map(([path, method]) => ({ method, path }));
}

function redirectResponse(location) {
  return new Response("", {
    status: 302,
    headers: { location },
  });
}
