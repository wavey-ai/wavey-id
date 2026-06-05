import assert from "node:assert/strict";
import test from "node:test";

import { spotifyStatusSummary } from "./zeroth-spotify-status.mjs";

test("spotify status reports missing access token without leaking secrets", async () => {
  const summary = await spotifyStatusSummary({
    requireReady: false,
    accessToken: "",
    fetchFn: async () => {
      throw new Error("fetch should not run without token");
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.ready, false);
  assert.equal(summary.checked, false);
  assert.equal(summary.checks.access_token_present, false);
  assert.match(summary.blockers.join("\n"), /SPOTIFY_ACCESS_TOKEN/);
});

test("spotify status accepts account_id profile without exposing token or profile ids", async () => {
  const summary = await spotifyStatusSummary({
    requireReady: true,
    accessToken: "spotify-access-token-secret-value",
    fetchFn: async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer spotify-access-token-secret-value");
      return jsonResponse(200, {
        account_id: "spotify-account-id",
        id: "legacy-id",
        email: "listener@example.com",
        display_name: "Listener",
        images: [{ url: "https://i.scdn.co/image/1" }],
        product: "premium",
      });
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.ready, true);
  assert.equal(summary.profile.subject_source, "account_id");
  assert.equal(summary.profile.account_id_present, true);
  assert.equal(summary.profile.legacy_id_present, true);
  assert.deepEqual(summary.blockers, []);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("spotify-access-token-secret-value"), false);
  assert.equal(serialized.includes("spotify-account-id"), false);
  assert.equal(serialized.includes("legacy-id"), false);
  assert.equal(serialized.includes("listener@example.com"), false);
});

test("spotify status allows legacy id fallback with warning", async () => {
  const summary = await spotifyStatusSummary({
    accessToken: "spotify-access-token",
    fetchFn: async () =>
      jsonResponse(200, {
        id: "legacy-id",
        images: null,
      }),
  });

  assert.equal(summary.ready, true);
  assert.equal(summary.profile.subject_source, "id");
  assert.match(summary.warnings.join("\n"), /fall back to legacy id/);
  assert.match(summary.warnings.join("\n"), /did not include email/);
});

test("spotify status explains development mode 403", async () => {
  const summary = await spotifyStatusSummary({
    requireReady: true,
    accessToken: "spotify-access-token",
    fetchFn: async () =>
      jsonResponse(403, {
        error: {
          status: 403,
          message: "Active premium subscription required for the owner of the app.",
        },
      }),
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.ready, false);
  assert.equal(summary.status, 403);
  assert.match(summary.blockers.join("\n"), /Spotify \/v1\/me returned HTTP 403/);
  assert.match(summary.blockers.join("\n"), /owner account has Premium/);
  assert.match(summary.blockers.join("\n"), /allowlisted/);
  assert.match(summary.blockers.join("\n"), /Active premium subscription required/);
});

test("spotify status rejects profiles without a usable subject", async () => {
  const summary = await spotifyStatusSummary({
    requireReady: true,
    accessToken: "spotify-access-token",
    fetchFn: async () =>
      jsonResponse(200, {
        email: "listener@example.com",
      }),
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.ready, false);
  assert.equal(summary.checks.usable_subject, false);
  assert.match(summary.blockers.join("\n"), /account_id or id/);
});

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}
