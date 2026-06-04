import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredValue,
  jsonArrayFromOutput,
  providerStatusSummary,
} from "./zeroth-provider-status.mjs";

const config = {
  vars: {
    APPLE_CLIENT_ID: "ai.wavey.signin",
    GOOGLE_CLIENT_ID: "wavey-google.apps.googleusercontent.com",
    SPOTIFY_CLIENT_ID: "wavey-spotify-client",
  },
};
const emptyInventory = {
  p8FileCount: 0,
  signInWithAppleCandidates: [],
  appStoreConnectAdminKeys: [],
};

test("provider status reports local provider readiness without leaking secrets", () => {
  const env = {
    APPLE_TEAM_ID: "TEAM123456",
    APPLE_KEY_ID: "KEY1234567",
    APPLE_PRIVATE_KEY: "apple-private-key-secret-value",
    GOOGLE_CLIENT_SECRET: "google-secret-value",
    SPOTIFY_CLIENT_SECRET: "spotify-secret-value",
  };
  const summary = providerStatusSummary({
    config,
    env,
    parentKeyInventory: emptyInventory,
    validateApplePrivateKeyFn: () => true,
  });

  assert.equal(summary.ready, true);
  assert.equal(summary.provider_client_ids_configured, true);
  assert.equal(summary.provider_secrets_configured, true);
  assert.deepEqual(summary.missing, []);

  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("apple-private-key-secret-value"), false);
  assert.equal(serialized.includes("google-secret-value"), false);
  assert.equal(serialized.includes("spotify-secret-value"), false);
});

test("remote provider status accepts uploaded Worker secret bindings", () => {
  const summary = providerStatusSummary({
    args: ["--remote"],
    config,
    env: {},
    parentKeyInventory: emptyInventory,
    remoteSecrets: {
      ok: true,
      names: [
        "APPLE_TEAM_ID",
        "APPLE_KEY_ID",
        "APPLE_PRIVATE_KEY",
        "GOOGLE_CLIENT_SECRET",
        "SPOTIFY_CLIENT_SECRET",
      ],
    },
  });

  assert.equal(summary.remote_secrets_read, true);
  assert.equal(summary.remote_provider_secrets_configured, true);
  assert.equal(summary.remote_ready, true);
  assert.deepEqual(summary.remote_missing, []);
  assert.equal(summary.provider_secrets_configured, false);
});

test("remote provider status reports missing Worker secret bindings by provider", () => {
  const summary = providerStatusSummary({
    args: ["--remote"],
    config,
    env: {},
    parentKeyInventory: emptyInventory,
    remoteSecrets: {
      ok: true,
      names: ["JWT_KEY_ID", "JWT_ES256_PRIVATE_KEY"],
    },
  });

  assert.equal(summary.remote_provider_secrets_configured, false);
  assert.deepEqual(summary.remote_missing, [
    "apple: APPLE_CLIENT_SECRET or APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY secret bindings",
    "google: GOOGLE_CLIENT_SECRET Worker secret binding",
    "spotify: SPOTIFY_CLIENT_SECRET Worker secret binding",
  ]);
});

test("provider status preserves App Store Connect key warning", () => {
  const summary = providerStatusSummary({
    config,
    env: {},
    parentKeyInventory: {
      p8FileCount: 1,
      signInWithAppleCandidates: [],
      appStoreConnectAdminKeys: ["/tmp/AppStore_AuthKey_ABCDEF1234.p8"],
    },
  });

  assert.equal(summary.parent_folder_inventory.app_store_connect_admin_key_count, 1);
  assert.deepEqual(summary.warnings, [
    "apple: parent folder contains AppStore_AuthKey_*.p8 admin material; Zeroth ignores it",
  ]);
});

test("configured value rejects scaffold placeholders", () => {
  assert.equal(configuredValue("real-client-id", "replace-with-client-id"), true);
  assert.equal(configuredValue("replace-with-client-id", "replace-with-client-id"), false);
  assert.equal(configuredValue("replace-with-other-client-id"), false);
  assert.equal(configuredValue("changeme"), false);
  assert.equal(configuredValue(""), false);
});

test("wrangler secret list JSON parser ignores surrounding output", () => {
  assert.deepEqual(
    jsonArrayFromOutput('banner\n[{"name":"GOOGLE_CLIENT_SECRET","type":"secret_text"}]\n'),
    [{ name: "GOOGLE_CLIENT_SECRET", type: "secret_text" }],
  );
  assert.equal(jsonArrayFromOutput("not json"), null);
});
