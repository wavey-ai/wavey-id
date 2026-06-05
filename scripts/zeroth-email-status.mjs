#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const defaultIssuer = "https://id.wavey.ai";
const defaultConfigPath = path.join(root, "wrangler.zeroth.jsonc");
const defaultAdminEnvFile = ".wrangler/zeroth-bootstrap.env";

if (isCli()) {
  await runCli(process.argv.slice(2));
}

async function runCli(rawArgs) {
  const args = new Set(rawArgs);
  const requireReady = args.has("--require-ready");
  const remote = args.has("--remote");
  const live = args.has("--live");
  const sendTest = args.has("--send-test");
  const envFile = argValue(rawArgs, "--env-file") || defaultAdminEnvFile;
  const issuer = argValue(rawArgs, "--issuer") || defaultIssuer;
  const to = argValue(rawArgs, "--to") || process.env.ZEROTH_EMAIL_TEST_TO || "jamie@wavey.ai";
  const config = readJson(defaultConfigPath);
  const envFileValues = fs.existsSync(path.resolve(root, envFile))
    ? readEnvFile(root, envFile)
    : {};

  const summary = await emailStatusSummary({
    requireReady,
    remote,
    live,
    sendTest,
    issuer,
    testTo: to,
    config,
    env: process.env,
    envFileValues,
    runCommand: runCommandForCli,
    fetchFn: globalThis.fetch,
  });

  console.log(JSON.stringify(summary, null, 2));

  if (requireReady && !summary.ready) {
    process.exit(1);
  }
}

export async function emailStatusSummary({
  requireReady = false,
  remote = false,
  live = false,
  sendTest = false,
  issuer = defaultIssuer,
  testTo = "jamie@wavey.ai",
  config = {},
  env = process.env,
  envFileValues = {},
  runCommand = runCommandForCli,
  fetchFn = globalThis.fetch,
} = {}) {
  const binding = emailBindingFromConfig(config);
  const sender = env.MAGIC_LINK_FROM || config?.vars?.MAGIC_LINK_FROM || "";
  const senderDomain = emailDomain(sender);
  const configured = Boolean(binding?.name) && validEmail(sender);
  const senderAllowed = senderAllowedByBinding(sender, binding);
  const configBlockers = [];
  if (!binding?.name) {
    configBlockers.push("missing send_email binding");
  }
  if (!validEmail(sender)) {
    configBlockers.push("MAGIC_LINK_FROM must be a valid email address");
  }
  if (!senderAllowed) {
    configBlockers.push("MAGIC_LINK_FROM is not allowed by send_email binding");
  }

  const remoteStatus = remote
    ? {
        zones: commandStatus(
          runCommand("npx", ["wrangler@4.98.0", "email", "sending", "list"]),
        ),
        dns: senderDomain
          ? commandStatus(
              runCommand("npx", [
                "wrangler@4.98.0",
                "email",
                "sending",
                "dns",
                "get",
                senderDomain,
              ]),
            )
          : skippedCommand("missing sender domain"),
      }
    : null;

  const sendStatus =
    sendTest && validEmail(sender)
      ? commandStatus(
          runCommand("npx", [
            "wrangler@4.98.0",
            "email",
            "sending",
            "send",
            "--from",
            sender,
            "--from-name",
            config?.vars?.PRODUCT_NAME || "Wavey ID",
            "--to",
            testTo,
            "--subject",
            "Wavey ID email service test",
            "--text",
            "Testing Cloudflare Email Sending for Zeroth magic links.",
          ]),
        )
      : null;

  const liveStatus = live
    ? await liveLocalAuthStatus({ issuer, env, envFileValues, fetchFn })
    : null;
  const liveBlockers = liveLocalAuthBlockers(liveStatus);
  const remoteBlockers = remoteEmailBlockers(remoteStatus, sendStatus);
  const blockers = [...configBlockers, ...liveBlockers, ...remoteBlockers];
  const ready = configured && senderAllowed && liveBlockers.length === 0 && blockers.length === 0;

  return {
    ok: requireReady ? ready : true,
    ready,
    require_ready: requireReady,
    remote_checked: remote,
    live_checked: live,
    send_test: sendTest,
    config: {
      binding_name: binding?.name || null,
      binding_configured: Boolean(binding?.name),
      sender,
      sender_domain: senderDomain,
      sender_allowed: senderAllowed,
      allowed_sender_addresses: binding?.allowed_sender_addresses || null,
    },
    live: liveStatus,
    cloudflare_email: {
      zones: remoteStatus?.zones || null,
      dns: remoteStatus?.dns || null,
      send: sendStatus,
    },
    blockers,
    next_actions: emailNextActions(blockers, {
      remote,
      sendTest,
      zones: remoteStatus?.zones,
      dns: remoteStatus?.dns,
      send: sendStatus,
    }),
  };
}

function emailBindingFromConfig(config) {
  const bindings = Array.isArray(config?.send_email) ? config.send_email : [];
  return bindings.find((binding) => binding?.name === "EMAIL") || bindings[0] || null;
}

function senderAllowedByBinding(sender, binding) {
  if (!validEmail(sender) || !binding) {
    return false;
  }
  const allowed = binding.allowed_sender_addresses;
  if (!Array.isArray(allowed) || allowed.length === 0) {
    return true;
  }
  return allowed.includes(sender);
}

async function liveLocalAuthStatus({ issuer, env, envFileValues, fetchFn }) {
  const token = env.ADMIN_TOKEN || envFileValues.ADMIN_TOKEN || "";
  if (!token) {
    return {
      status: null,
      ok: false,
      error: "missing_admin_token",
      magic_link: null,
    };
  }
  if (typeof fetchFn !== "function") {
    return {
      status: null,
      ok: false,
      error: "fetch_unavailable",
      magic_link: null,
    };
  }

  const response = await fetchFn(`${issuer.replace(/\/+$/, "")}/local-auth/status`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  let body = {};
  try {
    body = await response.json();
  } catch (_error) {
    body = {};
  }
  const methods = Array.isArray(body?.methods) ? body.methods : [];
  const magicLink = methods.find((method) => method.id === "magic_link") || null;
  return {
    status: response.status,
    ok: response.ok,
    magic_link: magicLink
      ? {
          enabled: magicLink.enabled === true,
          delivery: magicLink.delivery || null,
          notes: Array.isArray(magicLink.notes) ? magicLink.notes : [],
          delivery_status: magicLink.deliveryStatus || magicLink.delivery_status || null,
        }
      : null,
  };
}

function liveLocalAuthBlockers(liveStatus) {
  if (!liveStatus) {
    return [];
  }
  if (!liveStatus.ok) {
    return [`live local auth status failed${liveStatus.status ? `: HTTP ${liveStatus.status}` : ""}`];
  }
  const magicLink = liveStatus.magic_link;
  if (!magicLink) {
    return ["magic link method is missing from live local auth status"];
  }
  const blockers = [];
  if (!magicLink.enabled) {
    blockers.push("magic link method is disabled");
  }
  const notes = Array.isArray(magicLink.notes) ? magicLink.notes : [];
  const deliveryStatus = magicLink.delivery_status || {};
  if (notes.includes("delivery_failed_recently")) {
    const lastError = magicLinkDeliveryErrorSummary(deliveryStatus);
    blockers.push(
      `magic link email delivery failed recently${lastError ? `: ${lastError}` : ""}`,
    );
  }
  if (notes.includes("delivery_not_proven")) {
    blockers.push("magic link email delivery is not proven");
  }
  return blockers;
}

function magicLinkDeliveryErrorSummary(deliveryStatus = {}) {
  const lastError = deliveryStatus.lastError || deliveryStatus.last_error || "";
  const detail =
    deliveryStatus.lastErrorDetail ||
    deliveryStatus.last_error_detail ||
    deliveryStatus.errorDetail ||
    deliveryStatus.error_detail ||
    "";
  const safeLastError = boundedStatusText(lastError, 120);
  const safeDetail = boundedStatusText(detail, 180);
  if (safeLastError && safeDetail) {
    return `${safeLastError} (${safeDetail})`;
  }
  return safeLastError || safeDetail;
}

function boundedStatusText(value, maxChars) {
  if (typeof value !== "string") {
    return "";
  }
  const text = value
    .trim()
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\s+/g, " ");
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function remoteEmailBlockers(remoteStatus, sendStatus) {
  const blockers = [];
  if (remoteStatus?.zones && !remoteStatus.zones.ok) {
    blockers.push(`Cloudflare Email Sending zone listing failed: ${remoteStatus.zones.error}`);
  }
  if (remoteStatus?.dns && !remoteStatus.dns.ok) {
    blockers.push(`Cloudflare Email Sending DNS check failed: ${remoteStatus.dns.error}`);
  }
  if (sendStatus && !sendStatus.ok) {
    blockers.push(`Cloudflare Email Sending test send failed: ${sendStatus.error}`);
  }
  return blockers;
}

function emailNextActions(blockers, { remote, sendTest, zones, dns, send }) {
  const actions = [];
  if (blockers.some((blocker) => blocker.includes("delivery failed recently"))) {
    actions.push("repair Cloudflare Email Sending for wavey.ai, then request a fresh magic link");
  }
  if (zones && !zones.ok) {
    actions.push("use a Cloudflare credential with Email Sending read permissions to inspect onboarding");
  }
  if (dns && !dns.ok) {
    actions.push("verify Email Sending DNS records for wavey.ai in the Cloudflare dashboard");
  }
  if (send && !send.ok) {
    actions.push("retry npm run zeroth:email:send-test after Cloudflare Email Sending is healthy");
  }
  if (!remote) {
    actions.push("run npm run zeroth:email:status to include Cloudflare Email Sending inspection");
  }
  if (!sendTest) {
    actions.push("run npm run zeroth:email:send-test to attempt a minimal Cloudflare email send");
  }
  return [...new Set(actions)];
}

function commandStatus(result) {
  if (result.skipped) {
    return result;
  }
  return {
    ok: result.status === 0,
    status: result.status,
    error: result.status === 0 ? null : commandError(result),
  };
}

function skippedCommand(reason) {
  return {
    ok: false,
    skipped: true,
    reason,
    error: reason,
  };
}

function commandError(result) {
  const combined = `${result.stderr || ""}\n${result.stdout || ""}`;
  const apiError = combined.match(/([A-Za-z0-9_.-]+(?: \[code: [0-9]+\]| \[code: [A-Za-z0-9_.-]+\]))/);
  if (apiError) {
    return apiError[1];
  }
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  return lines.at(-1) || `command exited ${result.status}`;
}

function runCommandForCli(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readEnvFile(rootDir, envFile) {
  const file = path.resolve(rootDir, envFile);
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const index = assignment.indexOf("=");
    const key = assignment.slice(0, index).trim();
    let value = assignment.slice(index + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function validEmail(value) {
  return typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

function emailDomain(value) {
  if (!validEmail(value)) {
    return "";
  }
  return value.trim().split("@").at(-1);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] || "";
}

function isCli() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
}
