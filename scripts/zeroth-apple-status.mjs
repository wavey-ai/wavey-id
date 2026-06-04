#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const zerothRoot = path.resolve(root, "../zeroth");
const args = process.argv.slice(2);
const requireReady = args.includes("--require-ready");
const envFile = argValue("--env-file");
const configPath = path.join(root, "wrangler.zeroth.jsonc");
const config = readJson(configPath);
const envFileValues = envFile ? readEnvFile(envFile) : {};

const envKeys = [
  "APPLE_CLIENT_SECRET",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "APPLE_PRIVATE_KEY_PATH",
];
const env = Object.fromEntries(envKeys.map((key) => [key, envValue(key)]));
const parentKeyInventory = inventoryParentKeys();
const appleClientId = config?.vars?.APPLE_CLIENT_ID || process.env.APPLE_CLIENT_ID || "";
const appleClientIdConfigured = configuredValue(
  appleClientId,
  "replace-with-sign-in-with-apple-service-id",
);
const explicitPrivateKeyPath = env.APPLE_PRIVATE_KEY_PATH || "";
const discoveredPrivateKeyPath =
  !explicitPrivateKeyPath && parentKeyInventory.signInWithAppleCandidates.length === 1
    ? parentKeyInventory.signInWithAppleCandidates[0]
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
    privateKeyPathValid = validateApplePrivateKey(
      fs.readFileSync(selectedPrivateKeyPath, "utf8"),
    );
  }
}

let inlinePrivateKeyValid = false;
if (env.APPLE_PRIVATE_KEY) {
  inlinePrivateKeyValid = validateApplePrivateKey(env.APPLE_PRIVATE_KEY);
}

const runtimeSigningReady =
  Boolean(env.APPLE_TEAM_ID) &&
  Boolean(env.APPLE_KEY_ID) &&
  (inlinePrivateKeyValid || privateKeyPathValid) &&
  !selectedPathRefused;
const staticSecretReady = Boolean(env.APPLE_CLIENT_SECRET);
const ready = appleClientIdConfigured && (staticSecretReady || runtimeSigningReady);
const missing = missingItems({
  appleClientIdConfigured,
  staticSecretReady,
  runtimeSigningReady,
  selectedPathRefused,
});
const warnings = warningsFor({
  parentKeyInventory,
  explicitPrivateKeyPath,
  selectedPrivateKeyPath,
  selectedPrivateKeyClass,
});

const summary = {
  ok: !requireReady || ready,
  ready,
  require_ready: requireReady,
  apple_client_id_configured: appleClientIdConfigured,
  apple_client_id_source: config?.vars?.APPLE_CLIENT_ID
    ? "wrangler.zeroth.jsonc vars"
    : process.env.APPLE_CLIENT_ID
      ? "environment"
      : null,
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
  },
  parent_folder_inventory: {
    p8_file_count: parentKeyInventory.p8FileCount,
    sign_in_with_apple_candidate_count: parentKeyInventory.signInWithAppleCandidates.length,
    app_store_connect_admin_key_count: parentKeyInventory.appStoreConnectAdminKeys.length,
  },
  missing,
  warnings,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.ok) {
  process.exit(1);
}

function argValue(name) {
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

function readEnvFile(filePath) {
  const resolved = path.resolve(root, filePath);
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

function envValue(key) {
  return process.env[key] || envFileValues[key] || "";
}

function configuredValue(value, placeholder) {
  return Boolean(value) && value !== placeholder && !String(value).includes("replace-with");
}

function inventoryParentKeys() {
  const parent = path.resolve(root, "..");
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

function validateApplePrivateKey(value) {
  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "-p", "zeroth-cli", "--", "validate-secret", "apple-private-key"],
    {
      cwd: zerothRoot,
      encoding: "utf8",
      input: value,
      env: {
        ...process.env,
        CI: process.env.CI || "1",
      },
    },
  );
  return result.status === 0;
}

function missingItems({
  appleClientIdConfigured,
  staticSecretReady,
  runtimeSigningReady,
  selectedPathRefused,
}) {
  const items = [];
  if (!appleClientIdConfigured) {
    items.push("APPLE_CLIENT_ID Sign in with Apple Service ID");
  }
  if (!staticSecretReady && !runtimeSigningReady) {
    items.push(
      "APPLE_CLIENT_SECRET or APPLE_TEAM_ID, APPLE_KEY_ID, and a Sign in with Apple private key",
    );
  }
  if (selectedPathRefused) {
    items.push("replace App Store Connect/admin key with a Sign in with Apple key");
  }
  return items;
}

function warningsFor({
  parentKeyInventory,
  explicitPrivateKeyPath,
  selectedPrivateKeyPath,
  selectedPrivateKeyClass,
}) {
  const items = [];
  if (parentKeyInventory.appStoreConnectAdminKeys.length > 0) {
    items.push("parent folder contains AppStore_AuthKey_*.p8 admin material; Zeroth ignores it");
  }
  if (explicitPrivateKeyPath && selectedPrivateKeyClass === "app_store_connect_admin_refused") {
    items.push("APPLE_PRIVATE_KEY_PATH points at App Store Connect/admin material and will be refused");
  }
  if (!selectedPrivateKeyPath && parentKeyInventory.signInWithAppleCandidates.length > 1) {
    items.push("multiple AuthKey_*.p8 files found; set APPLE_PRIVATE_KEY_PATH explicitly");
  }
  return items;
}
