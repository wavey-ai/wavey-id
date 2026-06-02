import assert from "node:assert/strict";
import test from "node:test";
import {
  base64urlToBytes,
  bytesToBase64url,
  handleRequest,
  openSealed,
  parseCookies,
  safeReturnTo,
  seal,
} from "./worker.js";

const secret = "0123456789abcdefghijklmnopqrstuvwxyz";

test("base64url round trip", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(base64urlToBytes(bytesToBase64url(bytes)), bytes);
});

test("sealed payload round trip", async () => {
  const payload = { sub: "auth0|abc", email: "a@example.com", exp: 123 };
  const token = await seal(payload, secret);
  assert.match(token, /^v1\./);
  assert.deepEqual(await openSealed(token, secret), payload);
});

test("sealed payload rejects wrong secret", async () => {
  const token = await seal({ ok: true }, secret);
  await assert.rejects(() => openSealed(token, "wrong secret value with enough length"));
});

test("safeReturnTo allows relative paths", () => {
  const request = new Request("https://id.wavey.ai/login");
  assert.equal(safeReturnTo("/press", request, {}), "/press");
  assert.equal(safeReturnTo("//evil.test", request, {}), "/");
});

test("safeReturnTo allows configured origins", () => {
  const request = new Request("https://id.wavey.ai/login");
  const env = { ALLOWED_RETURN_ORIGINS: "https://bitneedle.com,https://infidelity.io" };
  assert.equal(
    safeReturnTo("https://bitneedle.com/press", request, env),
    "https://bitneedle.com/press",
  );
  assert.equal(
    safeReturnTo("https://infidelity.io/studio", request, env),
    "https://infidelity.io/studio",
  );
  assert.equal(safeReturnTo("https://evil.test/press", request, env), "/");
});

test("safeReturnTo allows configured cookie-domain subdomains", () => {
  const request = new Request("https://id.wavey.ai/login");
  const env = { COOKIE_DOMAIN: "id.wavey.ai" };
  assert.equal(
    safeReturnTo("https://id.wavey.ai/session", request, env),
    "https://id.wavey.ai/session",
  );
});

test("parseCookies handles normal cookie headers", () => {
  const cookies = parseCookies("a=1; b=two; c=three=four");
  assert.equal(cookies.get("a"), "1");
  assert.equal(cookies.get("b"), "two");
  assert.equal(cookies.get("c"), "three=four");
});

test("OIDC discovery proxies Auth0 metadata through id.wavey.ai endpoints", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://auth.example.com/.well-known/openid-configuration");
    return new Response(JSON.stringify({
      issuer: "https://auth.example.com/",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/oauth/token",
      jwks_uri: "https://auth.example.com/.well-known/jwks.json",
      userinfo_endpoint: "https://auth.example.com/userinfo",
      response_types_supported: ["code"],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const response = await handleRequest(
      new Request("https://id.wavey.ai/.well-known/openid-configuration"),
      {
        AUTH0_DOMAIN: "auth.example.com",
        PUBLIC_BASE_URL: "https://id.wavey.ai",
      },
    );
    assert.equal(response.status, 200);
    const discovery = await response.json();
    assert.equal(discovery.issuer, "https://auth.example.com/");
    assert.equal(discovery.authorization_endpoint, "https://id.wavey.ai/authorize");
    assert.equal(discovery.token_endpoint, "https://id.wavey.ai/oauth/token");
    assert.equal(discovery.jwks_uri, "https://id.wavey.ai/.well-known/jwks.json");
    assert.equal(discovery.userinfo_endpoint, "https://id.wavey.ai/userinfo");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
