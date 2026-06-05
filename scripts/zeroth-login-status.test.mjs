import assert from "node:assert/strict";
import test from "node:test";

import { loginStatusSummary } from "./zeroth-login-status.mjs";

const config = {
  vars: {
    APPLE_CLIENT_ID: "ai.wavey.zeroth",
    GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
    SPOTIFY_CLIENT_ID: "spotify-client",
    DISABLED_PROVIDERS: "spotify",
  },
};

test("login status verifies active provider redirects and disabled providers", async () => {
  const summary = await loginStatusSummary({
    origin: "https://id.example.com",
    config,
    disabledProviderIds: new Set(["spotify"]),
    fetchFn: fakeLoginFetch,
  });

  assert.equal(summary.ready, true);
  assert.equal(summary.checks.active_provider_redirects, true);
  assert.equal(summary.checks.disabled_provider_rejections, true);
  assert.equal(summary.checks.hosted_picker, true);
  assert.deepEqual(summary.blockers, []);

  const apple = summary.providers.find((provider) => provider.id === "apple");
  assert.equal(apple.ok, true);
  assert.equal(apple.location_host, "appleid.apple.com");
  assert.equal(apple.transaction_cookie_set, true);

  const spotify = summary.providers.find((provider) => provider.id === "spotify");
  assert.equal(spotify.ok, true);
  assert.equal(spotify.disabled, true);
  assert.equal(spotify.status, 400);
  assert.equal(spotify.redirected_to_provider, false);
});

test("login status reports broken active provider redirects", async () => {
  const summary = await loginStatusSummary({
    origin: "https://id.example.com",
    config,
    disabledProviderIds: new Set(["spotify"]),
    fetchFn: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/login" && url.searchParams.get("provider") === "google") {
        return Response.redirect("https://evil.example/auth", 302);
      }
      return fakeLoginFetch(input);
    },
  });

  assert.equal(summary.ready, false);
  assert.match(summary.blockers.join("\n"), /Google: redirected to evil.example/);
  assert.match(summary.blockers.join("\n"), /Google: redirect path is \/auth/);
});

test("login status reports disabled provider links in picker", async () => {
  const summary = await loginStatusSummary({
    origin: "https://id.example.com",
    config,
    disabledProviderIds: new Set(["spotify"]),
    fetchFn: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/login" && !url.searchParams.has("provider")) {
        return htmlResponse(
          '<a href="/login?provider=apple">Apple</a><a href="/login?provider=google">Google</a><a href="/login?provider=spotify">Spotify</a>',
        );
      }
      return fakeLoginFetch(input);
    },
  });

  assert.equal(summary.ready, false);
  assert.match(summary.blockers.join("\n"), /hosted picker: Spotify login link is visible while disabled/);
});

async function fakeLoginFetch(input) {
  const url = new URL(String(input));
  if (url.pathname !== "/login") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const provider = url.searchParams.get("provider");
  if (!provider) {
    return htmlResponse(
      '<a href="/login?provider=apple">Apple</a><a href="/login?provider=google">Google</a>',
    );
  }
  if (provider === "apple") {
    return redirectResponse(
      "https://appleid.apple.com/auth/authorize?response_type=code&client_id=ai.wavey.zeroth&redirect_uri=https%3A%2F%2Fid.example.com%2Foauth2%2Fcallback&state=apple-state&scope=email+name&nonce=apple-nonce&response_mode=form_post",
    );
  }
  if (provider === "google") {
    return redirectResponse(
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=google-client.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fid.example.com%2Foauth2%2Fcallback&state=google-state&scope=openid+email+profile&nonce=google-nonce",
    );
  }
  if (provider === "spotify") {
    return Response.json(
      {
        error: "invalid_request",
        errorDescription: "provider is not fully configured: spotify",
      },
      { status: 400 },
    );
  }
  return Response.json({ error: "invalid_request" }, { status: 400 });
}

function redirectResponse(location) {
  return new Response("", {
    status: 302,
    headers: {
      location,
      "set-cookie": "wavey_id_tx=state; Path=/; HttpOnly; Secure; SameSite=None",
    },
  });
}

function htmlResponse(html) {
  return new Response(`<!doctype html><html><body>${html}</body></html>`, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}
