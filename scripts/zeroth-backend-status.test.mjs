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
  assert.equal(summary.auth0_replacement.ready, false);
  assert.match(
    summary.auth0_replacement.blockers.join("\n"),
    /active Zeroth providers are not ready/,
  );
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
  assert.equal(summary.auth0_replacement.ready, false);
  assert.match(summary.auth0_replacement.blockers.join("\n"), /Zeroth backend is not ready/);
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
        client_ids: seededClientIds(),
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
              lastErrorDetail: "email.sending.error.internal_server [code: 10002]",
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
      providers: [
        { id: "apple", label: "Apple", disabled: false, remote_ready: true },
        { id: "google", label: "Google", disabled: false, remote_ready: true },
        {
          id: "spotify",
          label: "Spotify",
          disabled: true,
          remote_ready: true,
          notes: ["disabled_by_deployment"],
          activation_requirements: [
            "Spotify app owner account has Premium while the app is in development mode",
            "Spotify test login user is allowlisted in the Spotify app Users Management tab",
            "Spotify current-user profile endpoint /v1/me returns HTTP 200 for an authorized user",
          ],
        },
      ],
      warnings: [],
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.backend_ready, true);
  assert.equal(summary.providers_ready, true);
  assert.deepEqual(summary.local_auth_blockers, [
    "magic link email delivery failed recently: email_internal_server_error (email.sending.error.internal_server [code: 10002])",
  ]);
  assert.equal(summary.local_auth_summary.magic_link.delivery_status.lastError, "email_internal_server_error");
  assert.equal(
    summary.local_auth_summary.magic_link.delivery_status.lastErrorDetail,
    "email.sending.error.internal_server [code: 10002]",
  );
  assert.equal(summary.auth0_replacement.apple_google_ready, true);
  assert.equal(summary.auth0_replacement.ready, false);
  assert.deepEqual(summary.auth0_replacement.missing_client_ids, []);
  assert.match(
    summary.auth0_replacement.blockers.join("\n"),
    /Spotify provider is disabled by deployment: Spotify app owner account has Premium while the app is in development mode; Spotify test login user is allowlisted in the Spotify app Users Management tab; Spotify current-user profile endpoint \/v1\/me returns HTTP 200 for an authorized user/,
  );
  assert.match(
    summary.auth0_replacement.blockers.join("\n"),
    /local auth: magic link email delivery failed recently: email_internal_server_error \(email\.sending\.error\.internal_server \[code: 10002\]\)/,
  );
  assert.match(summary.next_actions.join("\n"), /zeroth:email:status/);
  assert.match(summary.next_actions.join("\n"), /zeroth:email:send-test/);
  assert.match(summary.next_actions.join("\n"), /zeroth:spotify:status/);
  assert.match(summary.next_actions.join("\n"), /DISABLED_PROVIDERS/);
});

test("backend status reports Swift readiness blockers in replacement gate", () => {
  const summary = backendStatusSummary({
    requireBackend: true,
    rollout: rolloutStatus({
      live_backend: "zeroth_ready",
      zeroth_live: true,
    }),
    liveAdmin: liveAdmin({
      ready_status: 200,
      ready: true,
    }),
    providerStatus: readyProviderStatus(),
    swiftStatus: {
      ready: false,
      client_id: "wavey-ios",
      origin: "https://id.wavey.ai",
      checks: {
        discovery: true,
        client_registration: false,
        native_apple_token_exchange: true,
        prompt_none_redirects: true,
      },
      blockers: ["wavey-ios client registration is missing Swift redirect URIs"],
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.backend_ready, true);
  assert.equal(summary.providers_ready, true);
  assert.equal(summary.swift_summary.ready, false);
  assert.deepEqual(summary.swift_blockers, [
    "wavey-ios client registration is missing Swift redirect URIs",
  ]);
  assert.equal(summary.auth0_replacement.ready, false);
  assert.equal(summary.auth0_replacement.swift_ready, false);
  assert.match(
    summary.auth0_replacement.blockers.join("\n"),
    /Swift\/iOS: wavey-ios client registration is missing Swift redirect URIs/,
  );
  assert.match(summary.next_actions.join("\n"), /zeroth:swift:status/);
});

test("backend status reports hosted login blockers in replacement gate", () => {
  const summary = backendStatusSummary({
    requireBackend: true,
    rollout: rolloutStatus({
      live_backend: "zeroth_ready",
      zeroth_live: true,
    }),
    liveAdmin: liveAdmin({
      ready_status: 200,
      ready: true,
    }),
    providerStatus: readyProviderStatus(),
    loginStatus: {
      ready: false,
      checks: {
        active_provider_redirects: false,
        disabled_provider_rejections: true,
        hosted_picker: true,
      },
      providers: [
        {
          id: "apple",
          label: "Apple",
          disabled: false,
          ok: false,
          status: 200,
          location_host: null,
          redirected_to_provider: false,
        },
      ],
      blockers: ["Apple: returned HTTP 200, expected upstream redirect"],
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.backend_ready, true);
  assert.equal(summary.providers_ready, true);
  assert.equal(summary.login_summary.ready, false);
  assert.deepEqual(summary.login_blockers, [
    "Apple: returned HTTP 200, expected upstream redirect",
  ]);
  assert.equal(summary.auth0_replacement.ready, false);
  assert.equal(summary.auth0_replacement.hosted_login_ready, false);
  assert.match(
    summary.auth0_replacement.blockers.join("\n"),
    /hosted login: Apple: returned HTTP 200, expected upstream redirect/,
  );
  assert.match(summary.next_actions.join("\n"), /zeroth:login:status/);
});

test("backend status reports D1 persistence blockers in replacement gate", () => {
  const summary = backendStatusSummary({
    requireBackend: true,
    rollout: rolloutStatus({
      live_backend: "zeroth_ready",
      zeroth_live: true,
    }),
    liveAdmin: liveAdmin({
      ready_status: 200,
      ready: true,
    }),
    providerStatus: readyProviderStatus(),
    loginStatus: {
      ready: true,
      checks: {
        active_provider_redirects: true,
        disabled_provider_rejections: true,
        hosted_picker: true,
      },
      blockers: [],
    },
    persistenceStatus: {
      ready: false,
      checks: {
        users_api: true,
        persisted_users: false,
        events_api: true,
        audit_events: false,
      },
      counts: {
        user_count: 0,
        event_count: 0,
      },
      blockers: [
        "no persisted users returned from /users",
        "no persisted audit events returned from /events",
      ],
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.backend_ready, true);
  assert.equal(summary.providers_ready, true);
  assert.equal(summary.persistence_summary.ready, false);
  assert.deepEqual(summary.persistence_blockers, [
    "no persisted users returned from /users",
    "no persisted audit events returned from /events",
  ]);
  assert.equal(summary.auth0_replacement.ready, false);
  assert.equal(summary.auth0_replacement.persistence_ready, false);
  assert.match(
    summary.auth0_replacement.blockers.join("\n"),
    /D1 persistence: no persisted users returned from \/users/,
  );
  assert.match(summary.next_actions.join("\n"), /zeroth:persistence:status/);
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

function readyProviderStatus() {
  return {
    provider_client_ids_configured: true,
    remote_provider_secrets_configured: true,
    remote_secrets_read: true,
    remote_ready: true,
    providers: [
      { id: "apple", label: "Apple", disabled: false, remote_ready: true },
      { id: "google", label: "Google", disabled: false, remote_ready: true },
      { id: "spotify", label: "Spotify", disabled: false, remote_ready: true },
    ],
    warnings: [],
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
        client_ids: seededClientIds(),
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

function seededClientIds() {
  return [
    "wavey-browser",
    "wavey-ios",
    "bitneedle-web",
    "infidelity-web",
    "infidelity-macos",
  ];
}
