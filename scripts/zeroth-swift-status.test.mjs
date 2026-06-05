import assert from "node:assert/strict";
import test from "node:test";

import {
  swiftAuthorizeUrl,
  swiftStatusSummary,
} from "./zeroth-swift-status.mjs";

test("Swift status verifies discovery, client registration, and bounded native redirects", async () => {
  const summary = await swiftStatusSummary({
    origin: "https://id.example.com",
    adminToken: "admin-token",
    fetchFn: fakeSwiftFetch,
  });

  assert.equal(summary.ready, true);
  assert.equal(summary.checks.discovery, true);
  assert.equal(summary.checks.client_registration, true);
  assert.equal(summary.checks.native_apple_token_exchange, true);
  assert.equal(summary.checks.prompt_none_redirects, true);
  assert.equal(summary.native_apple_token_exchange.validation_reached, true);
  assert.deepEqual(summary.blockers, []);
});

test("Swift authorize URL is public PKCE authorization code flow", () => {
  const url = swiftAuthorizeUrl({
    origin: "https://id.example.com",
    redirectUri: "wavey://auth/callback",
    state: "state-1",
  });

  assert.equal(url.origin, "https://id.example.com");
  assert.equal(url.pathname, "/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "wavey-ios");
  assert.equal(url.searchParams.get("redirect_uri"), "wavey://auth/callback");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("prompt"), "none");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

async function fakeSwiftFetch(input, options = {}) {
  const url = new URL(input);
  if (url.pathname === "/.well-known/openid-configuration") {
    return Response.json({
      issuer: "https://id.example.com",
      authorization_endpoint: "https://id.example.com/authorize",
      token_endpoint: "https://id.example.com/oauth/token",
      response_modes_supported: ["query"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:token-exchange",
      ],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "profile", "email", "offline_access"],
    });
  }

  if (url.pathname === "/clients") {
    assert.equal(options.headers.Authorization, "Bearer admin-token");
    return Response.json({
      id: "wavey-ios",
      confidential: false,
      redirectUris: [
        "wavey://auth/callback",
        "com.waveyai.iosWavey://id.wavey.ai/ios/com.waveyai.iosWavey/callback",
        "com.waveyai.auPlay.auPlayExtension://id.wavey.ai/ios/com.waveyai.auPlay.auPlayExtension/callback",
        "com.waveyai.auSend.auSendExtension://id.wavey.ai/ios/com.waveyai.auSend.auSendExtension/callback",
      ],
    });
  }

  if (url.pathname === "/oauth/token") {
    assert.equal(options.method, "POST");
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
    assert.equal(body.get("client_id"), "wavey-ios");
    assert.equal(body.get("provider"), "apple");
    assert.equal(body.get("provider_client_id"), "ai.wavey.id");
    return Response.json(
      {
        error: "invalid_response",
        errorDescription: "invalid JWT base64url segment: Invalid padding",
      },
      { status: 401 },
    );
  }

  if (url.pathname === "/authorize") {
    const redirectUri = new URL(url.searchParams.get("redirect_uri"));
    redirectUri.searchParams.set("error", "login_required");
    redirectUri.searchParams.set("state", url.searchParams.get("state"));
    redirectUri.searchParams.set("iss", "https://id.example.com");
    return new Response(null, {
      status: 302,
      headers: {
        location: redirectUri.toString(),
      },
    });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}
