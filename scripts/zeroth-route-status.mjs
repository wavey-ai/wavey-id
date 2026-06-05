#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const defaultOrigin = "https://id.wavey.ai";

const manifestRoutes = [
  ["GET", "/.well-known/openid-configuration"],
  ["GET", "/ready"],
  ["GET", "/status"],
  ["GET", "/api/status"],
  ["GET", "/login"],
  ["GET", "/admin"],
  ["GET", "/ui"],
  ["GET", "/dashboard"],
  ["GET", "/console"],
  ["GET", "/routes"],
  ["GET", "/callback"],
  ["POST", "/callback"],
  ["GET", "/callback/{provider}"],
  ["POST", "/callback/{provider}"],
  ["GET", "/auth/magic-link/send"],
  ["POST", "/auth/magic-link/send"],
  ["OPTIONS", "/auth/magic-link/send"],
  ["GET", "/api/auth/magic-link/send"],
  ["POST", "/api/auth/magic-link/send"],
  ["OPTIONS", "/api/auth/magic-link/send"],
];

const routeProbes = [
  { method: "GET", path: "/.well-known/openid-configuration", statuses: [200] },
  { method: "GET", path: "/ready", statuses: [200] },
  { method: "GET", path: "/status", statuses: [200] },
  { method: "GET", path: "/api/status", statuses: [200] },
  { method: "GET", path: "/login", statuses: [200] },
  { method: "GET", path: "/admin", statuses: [200, 302] },
  { method: "GET", path: "/ui", statuses: [200, 302] },
  { method: "GET", path: "/dashboard", statuses: [200, 302] },
  { method: "GET", path: "/console", statuses: [200, 302] },
  { method: "GET", path: "/callback", statuses: [400], expectedError: "invalid_request" },
  { method: "GET", path: "/callback/apple", statuses: [400], expectedError: "invalid_request" },
  { method: "GET", path: "/callback/google", statuses: [400], expectedError: "invalid_request" },
  { method: "GET", path: "/auth/magic-link/send", statuses: [302] },
  {
    method: "POST",
    path: "/auth/magic-link/send",
    statuses: [400],
    expectedError: "invalid_request",
  },
  { method: "GET", path: "/api/auth/magic-link/send", statuses: [302] },
  {
    method: "POST",
    path: "/api/auth/magic-link/send",
    statuses: [400],
    expectedError: "invalid_request",
  },
  { method: "GET", path: "/oauth/token", statuses: [405], expectedError: "method_not_allowed" },
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
  return routeStatusSummary({ origin, requireReady, fetchFn: fetch });
}

export async function routeStatusSummary({
  origin = defaultOrigin,
  requireReady = false,
  fetchFn = fetch,
} = {}) {
  const manifest = await routeManifestCheck({ origin, fetchFn });
  const probes = [];
  for (const probe of routeProbes) {
    probes.push(await routeProbe({ origin, fetchFn, ...probe }));
  }

  const blockers = [
    ...manifest.blockers,
    ...probes.flatMap((probe) =>
      probe.blockers.map((blocker) => `${probe.method} ${probe.path}: ${blocker}`),
    ),
  ];
  const checks = {
    manifest: manifest.ok,
    live_routes: probes.every((probe) => probe.ok),
    no_not_found: probes.every((probe) => !probe.not_found),
  };

  return {
    ok: blockers.length === 0,
    ready: blockers.length === 0,
    require_ready: requireReady,
    origin,
    checks,
    manifest,
    probes,
    blockers,
  };
}

async function routeManifestCheck({ origin, fetchFn }) {
  const response = await fetchFn(new URL("/routes", origin), { redirect: "manual" });
  const body = await jsonBody(response);
  const routes = Array.isArray(body?.routes) ? body.routes : [];
  const routeKeys = new Set(
    routes.map((route) => `${String(route.method || "").toUpperCase()} ${route.path || ""}`),
  );
  const missing = manifestRoutes
    .map(([method, routePath]) => `${method} ${routePath}`)
    .filter((key) => !routeKeys.has(key));
  const blockers = [];
  if (response.status !== 200) {
    blockers.push(`/routes returned HTTP ${response.status}`);
  }
  if (!Array.isArray(body?.routes)) {
    blockers.push("/routes did not return a routes array");
  }
  for (const route of missing) {
    blockers.push(`/routes is missing ${route}`);
  }

  return {
    ok: blockers.length === 0,
    status: response.status,
    route_count: routes.length,
    required_count: manifestRoutes.length,
    missing,
    blockers,
  };
}

async function routeProbe({
  origin,
  fetchFn,
  method,
  path: routePath,
  statuses,
  expectedError = "",
}) {
  const response = await fetchFn(new URL(routePath, origin), {
    method,
    redirect: "manual",
  });
  const body = await bodyText(response);
  const payload = parseJson(body);
  const error = payload?.error || null;
  const notFound = response.status === 404 || error === "not_found";
  const blockers = [];
  if (!statuses.includes(response.status)) {
    blockers.push(`returned HTTP ${response.status}, expected ${statuses.join(" or ")}`);
  }
  if (notFound) {
    blockers.push("returned router not_found");
  }
  if (expectedError && error !== expectedError) {
    blockers.push(`returned error ${error || "none"}, expected ${expectedError}`);
  }

  return {
    ok: blockers.length === 0,
    method,
    path: routePath,
    status: response.status,
    expected_statuses: statuses,
    error,
    not_found: notFound,
    blockers,
  };
}

async function bodyText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function jsonBody(response) {
  return parseJson(await bodyText(response));
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    return "";
  }
  return args[index + 1];
}

function isCli() {
  return process.argv[1]
    && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
}
