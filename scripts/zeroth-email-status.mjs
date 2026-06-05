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
  const configuredTransport = magicLinkTransportFromConfig({ config, env, envFileValues });
  const sender = env.MAGIC_LINK_FROM || config?.vars?.MAGIC_LINK_FROM || "";
  const senderDomain = emailDomain(sender);
  const senderConfigured = validEmail(sender);
  const senderAllowed = senderAllowedByBinding(sender, binding);
  const liveStatus = live
    ? await liveLocalAuthStatus({ issuer, env, envFileValues, fetchFn })
    : null;
  const effectiveTransport =
    liveStatus?.magic_link?.delivery || configuredTransport.transport;
  const remoteSecrets =
    remote && directEmailProviderTransport(effectiveTransport)
      ? remoteMagicLinkSecretStatus({ runCommand })
      : null;
  const transport = magicLinkTransportStatus({
    transport: effectiveTransport,
    configuredTransport,
    remoteSecrets,
    binding,
    sender,
    senderConfigured,
    senderAllowed,
    config,
  });

  const accountPlan =
    remote && transport.kind === "cloudflare_email"
      ? await cloudflareWorkersPlanStatus({ config, env, fetchFn })
      : null;
  const remoteStatus =
    remote && transport.kind === "cloudflare_email"
      ? {
          account_plan: accountPlan,
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
    sendTest && transport.kind === "cloudflare_email" && validEmail(sender)
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

  const liveBlockers = liveLocalAuthBlockers(liveStatus);
  const remoteBlockers = remoteEmailBlockers(remoteStatus, sendStatus, transport);
  const configBlockers = transport.blockers;
  const blockers = [...configBlockers, ...liveBlockers, ...remoteBlockers];
  const ready = transport.configured && liveBlockers.length === 0 && blockers.length === 0;

  return {
    ok: requireReady ? ready : true,
    ready,
    require_ready: requireReady,
    remote_checked: remote,
    live_checked: live,
    send_test: sendTest,
    config: {
      delivery: configuredTransport.transport,
      effective_delivery: effectiveTransport,
      binding_name: binding?.name || null,
      binding_configured: Boolean(binding?.name),
      sender,
      sender_domain: senderDomain,
      sender_allowed: senderAllowed,
      allowed_sender_addresses: binding?.allowed_sender_addresses || null,
      webhook_url_configured: configuredTransport.webhook_url_configured,
      resend_api_key_configured: configuredTransport.resend_api_key_configured,
      mailchannels_api_key_configured: configuredTransport.mailchannels_api_key_configured,
    },
    live: liveStatus,
    transport,
    cloudflare_email: {
      account_plan: remoteStatus?.account_plan || null,
      zones: remoteStatus?.zones || null,
      dns: remoteStatus?.dns || null,
      send: sendStatus,
      skipped:
        remote && transport.kind !== "cloudflare_email"
          ? `magic link delivery is ${transport.kind}`
          : null,
    },
    provider_secrets: remoteSecrets,
    blockers,
    next_actions: emailNextActions(blockers, {
      remote,
      sendTest,
      transport,
      zones: remoteStatus?.zones,
      dns: remoteStatus?.dns,
      send: sendStatus,
    }),
  };
}

function magicLinkTransportFromConfig({ config = {}, env = {}, envFileValues = {} } = {}) {
  const configured = env.MAGIC_LINK_DELIVERY || config?.vars?.MAGIC_LINK_DELIVERY || "";
  const transport = normalizeMagicLinkDelivery(configured);
  const webhookUrl = env.MAGIC_LINK_WEBHOOK_URL || config?.vars?.MAGIC_LINK_WEBHOOK_URL || "";
  return {
    transport,
    raw: configured || null,
    webhook_url_configured: validHttpsUrl(webhookUrl),
    resend_api_key_configured: localSecretConfigured(
      ["MAGIC_LINK_RESEND_API_KEY", "RESEND_API_KEY"],
      env,
      envFileValues,
    ),
    mailchannels_api_key_configured: localSecretConfigured(
      ["MAGIC_LINK_MAILCHANNELS_API_KEY", "MAILCHANNELS_API_KEY"],
      env,
      envFileValues,
    ),
  };
}

function normalizeMagicLinkDelivery(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "cloudflare" || normalized === "cloudflare_email") {
    return "cloudflare_email";
  }
  if (normalized === "webhook") {
    return "webhook";
  }
  if (normalized === "resend") {
    return "resend";
  }
  if (normalized === "mailchannels" || normalized === "mail_channels") {
    return "mailchannels";
  }
  return "unsupported";
}

function magicLinkTransportStatus({
  transport,
  configuredTransport,
  remoteSecrets,
  binding,
  sender,
  senderConfigured,
  senderAllowed,
} = {}) {
  const kind = normalizeMagicLinkDelivery(transport);
  const blockers = [];
  if (!senderConfigured) {
    blockers.push("MAGIC_LINK_FROM must be a valid email address");
  }
  if (kind === "cloudflare_email") {
    if (!binding?.name) {
      blockers.push("missing send_email binding");
    }
    if (!senderAllowed) {
      blockers.push("MAGIC_LINK_FROM is not allowed by send_email binding");
    }
    return {
      kind,
      configured: senderConfigured && Boolean(binding?.name) && senderAllowed,
      blockers,
    };
  }
  if (kind === "webhook") {
    if (!configuredTransport.webhook_url_configured) {
      blockers.push("MAGIC_LINK_WEBHOOK_URL must be a valid HTTPS URL");
    }
    return {
      kind,
      configured: senderConfigured && configuredTransport.webhook_url_configured,
      blockers,
    };
  }
  if (kind === "resend") {
    const secretConfigured = magicLinkProviderSecretConfigured({
      localConfigured: configuredTransport.resend_api_key_configured,
      remoteSecrets,
      names: ["MAGIC_LINK_RESEND_API_KEY", "RESEND_API_KEY"],
    });
    if (!secretConfigured) {
      blockers.push("RESEND_API_KEY or MAGIC_LINK_RESEND_API_KEY Worker secret binding is missing");
    }
    if (remoteSecrets && !remoteSecrets.ok) {
      blockers.push(`magic link provider secret listing failed: ${remoteSecrets.error}`);
    }
    return {
      kind,
      configured: senderConfigured && secretConfigured,
      blockers,
    };
  }
  if (kind === "mailchannels") {
    const secretConfigured = magicLinkProviderSecretConfigured({
      localConfigured: configuredTransport.mailchannels_api_key_configured,
      remoteSecrets,
      names: ["MAGIC_LINK_MAILCHANNELS_API_KEY", "MAILCHANNELS_API_KEY"],
    });
    if (!secretConfigured) {
      blockers.push(
        "MAILCHANNELS_API_KEY or MAGIC_LINK_MAILCHANNELS_API_KEY Worker secret binding is missing",
      );
    }
    if (remoteSecrets && !remoteSecrets.ok) {
      blockers.push(`magic link provider secret listing failed: ${remoteSecrets.error}`);
    }
    return {
      kind,
      configured: senderConfigured && secretConfigured,
      blockers,
    };
  }
  blockers.push("MAGIC_LINK_DELIVERY must be cloudflare_email, webhook, resend, or mailchannels");
  return {
    kind,
    configured: false,
    blockers,
  };
}

function directEmailProviderTransport(transport) {
  const kind = normalizeMagicLinkDelivery(transport);
  return kind === "resend" || kind === "mailchannels";
}

function magicLinkProviderSecretConfigured({ localConfigured, remoteSecrets, names }) {
  if (localConfigured) {
    return true;
  }
  if (!remoteSecrets?.ok) {
    return false;
  }
  const remoteSecretSet = new Set(remoteSecrets.names || []);
  return names.some((name) => remoteSecretSet.has(name));
}

function localSecretConfigured(names, env = {}, envFileValues = {}) {
  return names.some((name) => configuredSecretValue(env[name] || envFileValues[name]));
}

function configuredSecretValue(value) {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();
  return (
    Boolean(text) &&
    lower !== "changeme" &&
    !lower.startsWith("replace-with-") &&
    !(text.startsWith("<") && text.endsWith(">"))
  );
}

function remoteMagicLinkSecretStatus({ runCommand }) {
  const result = runCommand("npx", [
    "wrangler",
    "secret",
    "list",
    "--config",
    "wrangler.zeroth.jsonc",
  ]);
  if (result.status !== 0) {
    return {
      ok: false,
      checked: true,
      names: [],
      error: commandError(result),
    };
  }
  const parsed = jsonArrayFromOutput(result.stdout);
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      checked: true,
      names: [],
      error: "could not parse wrangler secret list JSON",
    };
  }
  return {
    ok: true,
    checked: true,
    names: parsed.map((secret) => secret?.name).filter(Boolean),
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

async function cloudflareWorkersPlanStatus({ config = {}, env = {}, fetchFn = globalThis.fetch }) {
  const accountId = config?.account_id || env.CLOUDFLARE_ACCOUNT_ID || "";
  if (!accountId) {
    return skippedCommand("missing Cloudflare account_id");
  }
  if (typeof fetchFn !== "function") {
    return skippedCommand("fetch unavailable");
  }

  const headers = cloudflareAuthHeaders(env);
  if (!headers) {
    return skippedCommand("missing Cloudflare API credential");
  }

  const response = await fetchFn(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`,
    {
      headers: {
        ...headers,
        Accept: "application/json",
      },
    },
  );
  let body = {};
  try {
    body = await response.json();
  } catch (_error) {
    body = {};
  }
  if (!response.ok || body?.success !== true) {
    return {
      ok: false,
      status: response.status,
      error: cloudflareApiError(body) || `HTTP ${response.status}`,
    };
  }

  const subscriptions = Array.isArray(body.result)
    ? body.result.map(safeSubscriptionSummary)
    : [];
  return {
    ok: true,
    status: response.status,
    workers_paid: subscriptions.some(workersPaidSubscription),
    subscriptions,
  };
}

function cloudflareAuthHeaders(env = {}) {
  if (env.CLOUDFLARE_API_TOKEN) {
    return { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  }
  if (env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_EMAIL) {
    return {
      "X-Auth-Email": env.CLOUDFLARE_EMAIL,
      "X-Auth-Key": env.CLOUDFLARE_API_KEY,
    };
  }
  return null;
}

function safeSubscriptionSummary(subscription = {}) {
  return {
    state: subscription.state || null,
    rate_plan: {
      id: subscription.rate_plan?.id || null,
      public_name: subscription.rate_plan?.public_name || null,
      scope: subscription.rate_plan?.scope || null,
    },
  };
}

function workersPaidSubscription(subscription = {}) {
  const state = String(subscription.state || "").toLowerCase();
  if (!["paid", "provisioned", "trial"].includes(state)) {
    return false;
  }
  const planId = String(subscription.rate_plan?.id || "").toLowerCase();
  const planName = String(subscription.rate_plan?.public_name || "").toLowerCase();
  const looksLikeWorkers = planId.includes("workers") || planName.includes("workers");
  const looksFree = planId.includes("free") || planName.includes("free");
  return looksLikeWorkers && !looksFree;
}

function cloudflareApiError(body = {}) {
  const errors = Array.isArray(body.errors) ? body.errors : [];
  return errors
    .map((error) => {
      const message = boundedStatusText(error?.message || "", 180);
      return message
        ? `${message}${error?.code ? ` [code: ${error.code}]` : ""}`
        : "";
    })
    .find(Boolean) || "";
}

function remoteEmailBlockers(remoteStatus, sendStatus, transport = {}) {
  if (transport.kind && transport.kind !== "cloudflare_email") {
    return [];
  }
  const blockers = [];
  const accountPlan = remoteStatus?.account_plan;
  if (accountPlan && !accountPlan.skipped && !accountPlan.ok) {
    blockers.push(`Cloudflare account subscription check failed: ${accountPlan.error}`);
  }
  if (accountPlan?.ok && accountPlan.workers_paid === false) {
    blockers.push(
      "Cloudflare Email Service requires Workers Paid plan; account has no active Workers Paid subscription",
    );
  }
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

function emailNextActions(blockers, { remote, sendTest, transport = {}, zones, dns, send }) {
  const actions = [];
  const delivery = transport.kind || "cloudflare_email";
  const missingWorkersPaid = blockers.some((blocker) =>
    blocker.includes("requires Workers Paid plan"),
  );
  if (blockers.some((blocker) => blocker.includes("MAGIC_LINK_WEBHOOK_URL"))) {
    actions.push("configure MAGIC_LINK_WEBHOOK_URL with the HTTPS email sender endpoint");
  }
  if (blockers.some((blocker) => blocker.includes("MAGIC_LINK_DELIVERY"))) {
    actions.push("set MAGIC_LINK_DELIVERY to cloudflare_email, webhook, resend, or mailchannels");
  }
  if (blockers.some((blocker) => blocker.includes("RESEND_API_KEY"))) {
    actions.push("upload RESEND_API_KEY or MAGIC_LINK_RESEND_API_KEY with wrangler secret put");
  }
  if (blockers.some((blocker) => blocker.includes("MAILCHANNELS_API_KEY"))) {
    actions.push(
      "upload MAILCHANNELS_API_KEY or MAGIC_LINK_MAILCHANNELS_API_KEY with wrangler secret put",
    );
    actions.push("configure MailChannels Domain Lockdown and SPF for the sender domain");
  }
  if (missingWorkersPaid) {
    actions.push("enable Workers Paid for the Cloudflare account before using Email Service");
  }
  if (blockers.some((blocker) => blocker.includes("delivery failed recently"))) {
    actions.push(
      magicLinkRepairAction(delivery),
    );
  }
  if (zones && !zones.ok && !missingWorkersPaid) {
    actions.push("use a Cloudflare credential with Email Sending read permissions to inspect onboarding");
  }
  if (dns && !dns.ok && !missingWorkersPaid) {
    actions.push("verify Email Sending DNS records for wavey.ai in the Cloudflare dashboard");
  }
  if (send && !send.ok) {
    actions.push("retry npm run zeroth:email:send-test after Cloudflare Email Sending is healthy");
  }
  if (!remote && delivery === "cloudflare_email") {
    actions.push("run npm run zeroth:email:status to include Cloudflare Email Sending inspection");
  }
  if (!sendTest && delivery === "cloudflare_email") {
    actions.push("run npm run zeroth:email:send-test to attempt a minimal Cloudflare email send");
  }
  return [...new Set(actions)];
}

function magicLinkRepairAction(delivery) {
  if (delivery === "webhook") {
    return "repair the magic-link webhook sender, then request a fresh magic link";
  }
  if (delivery === "resend") {
    return "repair Resend sender/domain/API key setup, then request a fresh magic link";
  }
  if (delivery === "mailchannels") {
    return "repair MailChannels sender/domain/API key setup, then request a fresh magic link";
  }
  return "repair Cloudflare Email Sending for wavey.ai, then request a fresh magic link";
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

function jsonArrayFromOutput(output) {
  const text = String(output || "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_error) {
    return null;
  }
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

function validHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch (_error) {
    return false;
  }
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
