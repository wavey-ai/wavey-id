import assert from "node:assert/strict";
import test from "node:test";

import { persistenceStatusSummary } from "./zeroth-persistence-status.mjs";

test("persistence status verifies D1-backed management surfaces", async () => {
  const summary = await persistenceStatusSummary({
    origin: "https://id.example.com/",
    adminToken: "admin-token",
    fetchFn: fakePersistenceFetch,
  });

  assert.equal(summary.ready, true);
  assert.equal(summary.origin, "https://id.example.com");
  assert.equal(summary.checks.db_status, true);
  assert.equal(summary.checks.required_tables, true);
  assert.equal(summary.checks.seeded_clients, true);
  assert.equal(summary.checks.persisted_users, true);
  assert.equal(summary.checks.admin_user, true);
  assert.equal(summary.checks.audit_events, true);
  assert.equal(summary.checks.local_auth_storage, true);
  assert.equal(summary.counts.user_count, 2);
  assert.equal(summary.counts.admin_user_count, 1);
  assert.deepEqual(summary.blockers, []);
});

test("persistence status requires admin token without probing live APIs", async () => {
  let called = false;
  const summary = await persistenceStatusSummary({
    origin: "https://id.example.com",
    adminToken: "",
    fetchFn: async () => {
      called = true;
      return Response.json({});
    },
  });

  assert.equal(called, false);
  assert.equal(summary.ready, false);
  assert.equal(summary.checks.admin_token_present, false);
  assert.match(summary.blockers.join("\n"), /ADMIN_TOKEN or ZEROTH_ADMIN_TOKEN/);
});

test("persistence status reports missing persisted users and events", async () => {
  const summary = await persistenceStatusSummary({
    origin: "https://id.example.com",
    adminToken: "admin-token",
    fetchFn: async (input, options) => {
      const url = new URL(String(input));
      if (url.pathname === "/users") {
        assert.equal(options.headers.Authorization, "Bearer admin-token");
        return Response.json({ users: [] });
      }
      if (url.pathname === "/events") {
        assert.equal(options.headers.Authorization, "Bearer admin-token");
        return Response.json({ events: [] });
      }
      return fakePersistenceFetch(input, options);
    },
  });

  assert.equal(summary.ready, false);
  assert.equal(summary.checks.persisted_users, false);
  assert.equal(summary.checks.audit_events, false);
  assert.match(summary.blockers.join("\n"), /no persisted users/);
  assert.match(summary.blockers.join("\n"), /no admin user/);
  assert.match(summary.blockers.join("\n"), /no persisted audit events/);
});

test("persistence status reports D1 and local auth storage blockers", async () => {
  const summary = await persistenceStatusSummary({
    origin: "https://id.example.com",
    adminToken: "admin-token",
    fetchFn: async (input, options) => {
      const url = new URL(String(input));
      if (url.pathname === "/__zeroth/db/status") {
        assert.equal(options.headers.Authorization, "Bearer admin-token");
        return Response.json({
          ok: false,
          tables: [{ name: "zeroth_users", present: true }],
          migrations: [{ version: 4, name: "local_auth", applied: false }],
          compatibilityColumns: [{ table: "zeroth_clients", name: "allowed_email_domains_json", present: false }],
        });
      }
      if (url.pathname === "/local-auth/status") {
        assert.equal(options.headers.Authorization, "Bearer admin-token");
        return Response.json({
          methods: [
            {
              id: "password",
              enabled: true,
              credentialStorage: "wrong_table",
            },
          ],
        });
      }
      return fakePersistenceFetch(input, options);
    },
  });

  assert.equal(summary.ready, false);
  assert.equal(summary.checks.db_status, false);
  assert.equal(summary.checks.required_tables, false);
  assert.equal(summary.checks.local_auth_storage, false);
  assert.match(summary.blockers.join("\n"), /missing D1 tables/);
  assert.match(summary.blockers.join("\n"), /pending D1 migrations: 4:local_auth/);
  assert.match(summary.blockers.join("\n"), /local auth storage mismatch/);
});

async function fakePersistenceFetch(input, options = {}) {
  const url = new URL(String(input));
  assert.equal(options.headers.Authorization, "Bearer admin-token");

  if (url.pathname === "/__zeroth/db/status") {
    return Response.json({
      ok: true,
      tables: requiredTables().map((name) => ({ name, present: true })),
      migrations: [
        { version: 1, name: "init", applied: true },
        { version: 2, name: "passkeys", applied: true },
        { version: 3, name: "admin_memberships", applied: true },
        { version: 4, name: "local_auth", applied: true },
      ],
      compatibilityColumns: [
        { table: "zeroth_clients", name: "allowed_email_domains_json", present: true },
        { table: "zeroth_auth_transactions", name: "provider_nonce", present: true },
      ],
      clientCount: 5,
    });
  }

  if (url.pathname === "/clients") {
    return Response.json({
      clients: [
        "wavey-browser",
        "wavey-ios",
        "bitneedle-web",
        "infidelity-web",
        "infidelity-macos",
      ].map((id) => ({ id })),
    });
  }

  if (url.pathname === "/users") {
    return Response.json({
      users: [
        { id: "usr_1", admin: true, identityCount: 1, activeSessionCount: 1 },
        { id: "usr_2", admin: false, identityCount: 1, activeSessionCount: 0 },
      ],
    });
  }

  if (url.pathname === "/events") {
    return Response.json({
      events: [
        { id: "evt_1", eventType: "session.login" },
        { id: "evt_2", eventType: "token.issue" },
      ],
    });
  }

  if (url.pathname === "/local-auth/status") {
    return Response.json({
      methods: [
        { id: "password", enabled: true, credentialStorage: "zeroth_local_credentials" },
        { id: "passkey", enabled: true, credentialStorage: "zeroth_passkey_credentials" },
        { id: "magic_link", enabled: true, credentialStorage: "zeroth_magic_links" },
      ],
    });
  }

  if (url.pathname === "/providers/status") {
    return Response.json({
      providers: [
        { id: "apple" },
        { id: "google" },
        { id: "spotify" },
      ],
    });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

function requiredTables() {
  return [
    "zeroth_schema_migrations",
    "zeroth_users",
    "zeroth_identities",
    "zeroth_clients",
    "zeroth_auth_transactions",
    "zeroth_auth_codes",
    "zeroth_refresh_tokens",
    "zeroth_sessions",
    "zeroth_passkey_credentials",
    "zeroth_passkey_challenges",
    "zeroth_admin_memberships",
    "zeroth_local_credentials",
    "zeroth_magic_links",
    "zeroth_signing_keys",
    "zeroth_audit_events",
  ];
}
