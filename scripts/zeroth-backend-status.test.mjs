import assert from "node:assert/strict";
import test from "node:test";

import { backendStatusSummary } from "./zeroth-backend-status.mjs";

test("backend status passes when deployed backend is ready but providers are pending", () => {
  const summary = backendStatusSummary({
    requireBackend: true,
    rollout: rolloutStatus({
      live_backend: "zeroth_not_ready",
      zeroth_live: true,
    }),
    liveAdmin: liveAdmin({
      ready_status: 503,
      ready: false,
    }),
    providerStatus: {
      provider_client_ids_configured: false,
      remote_provider_secrets_configured: false,
      remote_secrets_read: true,
      remote_ready: false,
      required_provider_ids: ["apple", "google"],
      providers: [
        { id: "apple", label: "Apple" },
        { id: "google", label: "Google" },
        { id: "spotify", label: "Spotify", disabled: true },
      ],
      missing: ["apple: APPLE_CLIENT_ID Sign in with Apple Service ID"],
      remote_missing: ["google: GOOGLE_CLIENT_SECRET Worker secret binding"],
      warnings: [],
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.backend_ready, true);
  assert.equal(summary.providers_ready, false);
  assert.equal(summary.phase, "backend_ready_provider_config_pending");
  assert.deepEqual(summary.local_auth_blockers, []);
  assert.deepEqual(summary.provider_blockers, [
    "replace placeholder provider client IDs in wrangler.zeroth.jsonc",
    "upload Apple/Google Worker secret bindings",
  ]);
});

test("backend status fails backend require when a core check is red", () => {
  const summary = backendStatusSummary({
    requireBackend: true,
    rollout: rolloutStatus({
      d1_schema_and_clients: false,
      live_backend: "zeroth_not_ready",
      zeroth_live: true,
    }),
    liveAdmin: liveAdmin(),
    providerStatus: {
      provider_client_ids_configured: false,
      remote_provider_secrets_configured: false,
    },
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.backend_ready, false);
  assert.equal(summary.phase, "backend_not_ready");
  assert.deepEqual(summary.backend_blockers, ["d1_schema_and_clients"]);
});

test("backend status reports magic link delivery blockers without failing backend readiness", () => {
  const summary = backendStatusSummary({
    requireBackend: true,
    rollout: rolloutStatus({
      live_backend: "zeroth_ready",
      zeroth_live: true,
    }),
    liveAdmin: liveAdmin({
      ready_status: 200,
      ready: true,
      admin: {
        db_status: 200,
        clients_status: 200,
        client_count: 5,
        local_auth_status: 200,
        local_auth_methods: [
          {
            id: "magic_link",
            enabled: true,
            delivery: "cloudflare_email",
            notes: ["delivery_failed_recently"],
            deliveryStatus: {
              lastIssueAt: 1780630448,
              lastFailedAt: 1780630448,
              lastError: "email_internal_server_error",
            },
          },
        ],
      },
    }),
    providerStatus: {
      provider_client_ids_configured: true,
      remote_provider_secrets_configured: true,
      remote_secrets_read: true,
      remote_ready: true,
      warnings: [],
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.backend_ready, true);
  assert.equal(summary.providers_ready, true);
  assert.deepEqual(summary.local_auth_blockers, [
    "magic link email delivery failed recently: email_internal_server_error",
  ]);
  assert.equal(summary.local_auth_summary.magic_link.delivery_status.lastError, "email_internal_server_error");
});

function rolloutStatus(overrides = {}) {
  return {
    status: {
      zeroth_live: true,
      live_backend: "zeroth_not_ready",
      d1_schema_and_clients: true,
      worker_api_read: true,
      worker_secrets_read: true,
      worker_startup_profile: true,
      worker_startup_budget: true,
      ...overrides,
    },
  };
}

function liveAdmin(overrides = {}) {
  return {
    live: {
      openid_configuration_status: 200,
      ready_status: 503,
      ready: false,
      readiness: {
        issuer_check: { configured: true },
        signing: { configured: true },
      },
      admin: {
        db_status: 200,
        clients_status: 200,
        client_count: 5,
        local_auth_status: 200,
        local_auth_methods: [
          {
            id: "magic_link",
            enabled: true,
            delivery: "cloudflare_email",
            notes: [],
          },
        ],
      },
      ...overrides,
    },
  };
}
