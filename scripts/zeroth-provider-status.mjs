#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = path.resolve(import.meta.dirname, "..");
const defaultZerothRoot = path.resolve(defaultRoot, "../zeroth");

if (isCli()) {
  runCli(process.argv.slice(2));
}

function runCli(args) {
  const rootDir = defaultRoot;
  const envFile = argValue(args, "--env-file");
  const remote = args.includes("--remote");
  const summary = providerStatusSummary({
    args,
    env: process.env,
    rootDir,
    zerothRoot: defaultZerothRoot,
    config: readJson(path.join(rootDir, "wrangler.zeroth.jsonc")),
    envFileValues: envFile ? readEnvFile(rootDir, envFile) : {},
    parentKeyInventory: inventoryParentKeys(rootDir),
    remoteSecrets: remote ? readRemoteSecrets({ rootDir, env: process.env }) : undefined,
  });

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok) {
    process.exit(1);
  }
}

export function providerStatusSummary({
  args = [],
  env = process.env,
  rootDir = defaultRoot,
  zerothRoot = defaultZerothRoot,
  config = {},
  envFileValues = {},
  parentKeyInventory = inventoryParentKeys(rootDir),
  remoteSecrets,
  validateApplePrivateKeyFn = (value) => validateApplePrivateKey(value, { zerothRoot, env }),
} = {}) {
  const requireReady = args.includes("--require-ready");
  const remote = args.includes("--remote");
  const resolvedRemoteSecrets = remote
    ? remoteSecrets || readRemoteSecrets({ rootDir, env })
    : { ok: true, checked: false, names: [] };
  const remoteSecretSet = new Set(resolvedRemoteSecrets.names || []);
  const context = {
    config,
    env,
    envFileValues,
    parentKeyInventory,
    remote,
    remoteSecretSet,
    validateApplePrivateKeyFn,
  };

  const providers = [
    appleStatus(context),
    secretBackedProviderStatus(context, {
      id: "google",
      label: "Google",
      clientIdEnv: "GOOGLE_CLIENT_ID",
      clientIdPlaceholder: "replace-with-google-oauth-client-id",
      clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    }),
    secretBackedProviderStatus(context, {
      id: "spotify",
      label: "Spotify",
      clientIdEnv: "SPOTIFY_CLIENT_ID",
      clientIdPlaceholder: "replace-with-spotify-oauth-client-id",
      clientSecretEnv: "SPOTIFY_CLIENT_SECRET",
    }),
  ];
  const ready = providers.every((provider) => provider.ready);
  const remoteProviderSecretsConfigured =
    remote && resolvedRemoteSecrets.ok
      ? providers.every((provider) => provider.remote_secret_configured)
      : null;
  const remoteReady =
    remote && resolvedRemoteSecrets.ok
      ? providers.every((provider) => provider.remote_ready)
      : null;

  return {
    ok: (!requireReady || ready) && (!remote || resolvedRemoteSecrets.ok),
    ready,
    require_ready: requireReady,
    remote_checked: remote,
    remote_secrets_read: remote ? resolvedRemoteSecrets.ok : null,
    remote_secret_error: resolvedRemoteSecrets.error || null,
    providers,
    provider_client_ids_configured: providers.every((provider) => provider.client_id_configured),
    provider_secrets_configured: providers.every((provider) => provider.secret_configured),
    remote_provider_secrets_configured: remoteProviderSecretsConfigured,
    remote_ready: remoteReady,
    missing: providers.flatMap((provider) =>
      provider.missing.map((item) => `${provider.id}: ${item}`),
    ),
    remote_missing: remote
      ? providers.flatMap((provider) =>
          provider.remote_missing.map((item) => `${provider.id}: ${item}`),
        )
      : null,
    warnings: providers.flatMap((provider) =>
      provider.warnings.map((item) => `${provider.id}: ${item}`),
    ),
    parent_folder_inventory: {
      p8_file_count: parentKeyInventory.p8FileCount,
      sign_in_with_apple_candidate_count: parentKeyInventory.signInWithAppleCandidates.length,
      app_store_connect_admin_key_count: parentKeyInventory.appStoreConnectAdminKeys.length,
    },
  };
}

function appleStatus(context) {
  const env = {
    APPLE_CLIENT_SECRET: envValue(context, "APPLE_CLIENT_SECRET"),
    APPLE_TEAM_ID: envValue(context, "APPLE_TEAM_ID"),
    APPLE_KEY_ID: envValue(context, "APPLE_KEY_ID"),
    APPLE_PRIVATE_KEY: envValue(context, "APPLE_PRIVATE_KEY"),
    APPLE_PRIVATE_KEY_PATH: envValue(context, "APPLE_PRIVATE_KEY_PATH"),
  };
  const clientId = context.config?.vars?.APPLE_CLIENT_ID || envValue(context, "APPLE_CLIENT_ID");
  const clientIdConfigured = configuredValue(
    clientId,
    "replace-with-sign-in-with-apple-service-id",
  );
  const explicitPrivateKeyPath = env.APPLE_PRIVATE_KEY_PATH || "";
  const discoveredPrivateKeyPath =
    !explicitPrivateKeyPath && context.parentKeyInventory.signInWithAppleCandidates.length === 1
      ? context.parentKeyInventory.signInWithAppleCandidates[0]
      : "";
  const selectedPrivateKeyPath = explicitPrivateKeyPath || discoveredPrivateKeyPath;
  const selectedPrivateKeyClass = selectedPrivateKeyPath
    ? classifyPrivateKeyPath(selectedPrivateKeyPath)
    : null;
  const selectedPathRefused = selectedPrivateKeyClass === "app_store_connect_admin_refused";

  let privateKeyPathReadable = false;
  let privateKeyPathValid = false;
  if (selectedPrivateKeyPath && !selectedPathRefused) {
    privateKeyPathReadable = isReadableFile(selectedPrivateKeyPath);
    if (privateKeyPathReadable) {
      privateKeyPathValid = context.validateApplePrivateKeyFn(
        fs.readFileSync(selectedPrivateKeyPath, "utf8"),
      );
    }
  }

  const inlinePrivateKeyValid = env.APPLE_PRIVATE_KEY
    ? context.validateApplePrivateKeyFn(env.APPLE_PRIVATE_KEY)
    : false;
  const runtimeSigningReady =
    Boolean(env.APPLE_TEAM_ID) &&
    Boolean(env.APPLE_KEY_ID) &&
    (inlinePrivateKeyValid || privateKeyPathValid) &&
    !selectedPathRefused;
  const staticSecretReady = configuredValue(env.APPLE_CLIENT_SECRET, "");
  const secretConfigured = staticSecretReady || runtimeSigningReady;
  const remoteStaticSecretReady = context.remoteSecretSet.has("APPLE_CLIENT_SECRET");
  const remoteRuntimeSigningReady =
    context.remoteSecretSet.has("APPLE_TEAM_ID") &&
    context.remoteSecretSet.has("APPLE_KEY_ID") &&
    (context.remoteSecretSet.has("APPLE_PRIVATE_KEY") ||
      context.remoteSecretSet.has("APPLE_PRIVATE_KEY_PEM"));
  const remoteSecretConfigured = remoteStaticSecretReady || remoteRuntimeSigningReady;
  const missing = [];
  if (!clientIdConfigured) {
    missing.push("APPLE_CLIENT_ID Sign in with Apple Service ID");
  }
  if (!secretConfigured) {
    missing.push(
      "APPLE_CLIENT_SECRET or APPLE_TEAM_ID, APPLE_KEY_ID, and a Sign in with Apple private key",
    );
  }
  if (selectedPathRefused) {
    missing.push("replace App Store Connect/admin key with a Sign in with Apple key");
  }
  const remoteMissing = [];
  if (context.remote && !remoteSecretConfigured) {
    remoteMissing.push(
      "APPLE_CLIENT_SECRET or APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY secret bindings",
    );
  }

  return {
    id: "apple",
    label: "Apple",
    ready: clientIdConfigured && secretConfigured,
    client_id_configured: clientIdConfigured,
    client_id_source: context.config?.vars?.APPLE_CLIENT_ID
      ? "wrangler.zeroth.jsonc vars"
      : envValue(context, "APPLE_CLIENT_ID")
        ? "environment"
        : null,
    secret_configured: secretConfigured,
    remote_secret_configured: context.remote ? remoteSecretConfigured : null,
    remote_ready: context.remote ? clientIdConfigured && remoteSecretConfigured : null,
    credentials: {
      apple_client_secret_configured: Boolean(env.APPLE_CLIENT_SECRET),
      apple_team_id_configured: Boolean(env.APPLE_TEAM_ID),
      apple_key_id_configured: Boolean(env.APPLE_KEY_ID),
      apple_private_key_env_configured: Boolean(env.APPLE_PRIVATE_KEY),
      apple_private_key_env_valid: env.APPLE_PRIVATE_KEY ? inlinePrivateKeyValid : null,
      apple_private_key_path_configured: Boolean(explicitPrivateKeyPath),
      apple_private_key_path_discovered: Boolean(discoveredPrivateKeyPath),
      apple_private_key_path_selected: Boolean(selectedPrivateKeyPath),
      apple_private_key_path_class: selectedPrivateKeyClass,
      apple_private_key_path_readable: selectedPrivateKeyPath ? privateKeyPathReadable : null,
      apple_private_key_path_valid: selectedPrivateKeyPath ? privateKeyPathValid : null,
      remote_apple_client_secret_configured: context.remote ? remoteStaticSecretReady : null,
      remote_apple_runtime_signing_configured: context.remote ? remoteRuntimeSigningReady : null,
    },
    missing,
    remote_missing: remoteMissing,
    warnings: appleWarnings(context, {
      explicitPrivateKeyPath,
      selectedPrivateKeyPath,
      selectedPrivateKeyClass,
    }),
  };
}

function secretBackedProviderStatus(context, {
  id,
  label,
  clientIdEnv,
  clientIdPlaceholder,
  clientSecretEnv,
}) {
  const clientId = context.config?.vars?.[clientIdEnv] || envValue(context, clientIdEnv);
  const clientSecret = envValue(context, clientSecretEnv);
  const clientIdConfigured = configuredValue(clientId, clientIdPlaceholder);
  const secretConfigured = configuredValue(clientSecret, "");
  const remoteSecretConfigured = context.remoteSecretSet.has(clientSecretEnv);
  const missing = [];
  if (!clientIdConfigured) {
    missing.push(`${clientIdEnv} OAuth client ID`);
  }
  if (!secretConfigured) {
    missing.push(`${clientSecretEnv} OAuth client secret`);
  }
  const remoteMissing = [];
  if (context.remote && !remoteSecretConfigured) {
    remoteMissing.push(`${clientSecretEnv} Worker secret binding`);
  }

  return {
    id,
    label,
    ready: clientIdConfigured && secretConfigured,
    client_id_configured: clientIdConfigured,
    client_id_source: context.config?.vars?.[clientIdEnv]
      ? "wrangler.zeroth.jsonc vars"
      : envValue(context, clientIdEnv)
        ? "environment"
        : null,
    secret_configured: secretConfigured,
    remote_secret_configured: context.remote ? remoteSecretConfigured : null,
    remote_ready: context.remote ? clientIdConfigured && remoteSecretConfigured : null,
    credentials: {
      [`${clientSecretEnv.toLowerCase()}_configured`]: Boolean(clientSecret),
      [`remote_${clientSecretEnv.toLowerCase()}_configured`]: context.remote
        ? remoteSecretConfigured
        : null,
    },
    missing,
    remote_missing: remoteMissing,
    warnings: [],
  };
}

function readRemoteSecrets({ rootDir, env }) {
  const result = spawnSync(
    "npx",
    ["wrangler", "secret", "list", "--config", "wrangler.zeroth.jsonc"],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...env,
        CI: env.CI || "1",
      },
    },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      checked: true,
      names: [],
      error: commandTail(`${result.stdout || ""}\n${result.stderr || ""}`),
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

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return "";
  }
  if (index + 1 >= args.length) {
    console.error(`${name} requires a path`);
    process.exit(1);
  }
  return args[index + 1];
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readEnvFile(rootDir, filePath) {
  const resolved = path.resolve(rootDir, filePath);
  if (!isReadableFile(resolved)) {
    console.error(`env file is not readable: ${filePath}`);
    process.exit(1);
  }

  const values = {};
  for (const line of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(assignment);
    if (!match) {
      continue;
    }
    values[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return values;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function envValue(context, key) {
  return context.env[key] || context.envFileValues[key] || "";
}

export function configuredValue(value, placeholder = "") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  if (placeholder && normalized === placeholder) {
    return false;
  }
  return !normalized.includes("replace-with") && normalized !== "changeme" && normalized !== "todo";
}

function inventoryParentKeys(rootDir) {
  const parent = path.resolve(rootDir, "..");
  const entries = fs.readdirSync(parent, { withFileTypes: true });
  const p8Files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".p8"))
    .map((entry) => path.join(parent, entry.name));
  return {
    p8FileCount: p8Files.length,
    signInWithAppleCandidates: p8Files.filter((filePath) =>
      /^AuthKey_[A-Z0-9]{10}\.p8$/.test(path.basename(filePath)),
    ),
    appStoreConnectAdminKeys: p8Files.filter((filePath) =>
      /^AppStore_AuthKey_[A-Z0-9]{10}\.p8$/.test(path.basename(filePath)),
    ),
  };
}

function classifyPrivateKeyPath(filePath) {
  const basename = path.basename(filePath);
  if (/^AppStore_AuthKey_[A-Z0-9]{10}\.p8$/.test(basename)) {
    return "app_store_connect_admin_refused";
  }
  if (/^AuthKey_[A-Z0-9]{10}\.p8$/.test(basename)) {
    return "sign_in_with_apple_candidate";
  }
  return "explicit_path_unclassified";
}

function isReadableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function validateApplePrivateKey(value, { zerothRoot, env }) {
  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "-p", "zeroth-cli", "--", "validate-secret", "apple-private-key"],
    {
      cwd: zerothRoot,
      encoding: "utf8",
      input: value,
      env: {
        ...env,
        CI: env.CI || "1",
      },
    },
  );
  return result.status === 0;
}

function appleWarnings(context, {
  explicitPrivateKeyPath,
  selectedPrivateKeyPath,
  selectedPrivateKeyClass,
}) {
  const items = [];
  if (context.parentKeyInventory.appStoreConnectAdminKeys.length > 0) {
    items.push("parent folder contains AppStore_AuthKey_*.p8 admin material; Zeroth ignores it");
  }
  if (explicitPrivateKeyPath && selectedPrivateKeyClass === "app_store_connect_admin_refused") {
    items.push("APPLE_PRIVATE_KEY_PATH points at App Store Connect/admin material and will be refused");
  }
  if (!selectedPrivateKeyPath && context.parentKeyInventory.signInWithAppleCandidates.length > 1) {
    items.push("multiple AuthKey_*.p8 files found; set APPLE_PRIVATE_KEY_PATH explicitly");
  }
  return items;
}

export function jsonArrayFromOutput(output) {
  const value = stripAnsi(String(output || ""));
  const start = value.indexOf("[");
  const end = value.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

function commandTail(output) {
  return stripAnsi(String(output || ""))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-8)
    .join("\n");
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function isCli() {
  return process.argv[1]
    && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
}
