const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_AUTH0_SCOPE = "openid profile email";
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_COOKIE_NAME = "wavey_id_session";
const DEFAULT_TX_COOKIE_NAME = "wavey_id_tx";
const TX_TTL_SECONDS = 5 * 60;

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), request, env);
  }

  const url = new URL(request.url);

  try {
    switch (url.pathname) {
      case "/":
        return withCors(homeResponse(request, env), request, env);
      case "/.well-known/openid-configuration":
        return await oidcDiscovery(request, env);
      case "/.well-known/jwks.json":
        return await proxyAuth0Json(request, env, "/.well-known/jwks.json");
      case "/.well-known/apple-app-site-association":
        return appleAppSiteAssociation(env);
      case "/authorize":
        return proxyAuthorize(request, env);
      case "/oauth/token":
        return await proxyToken(request, env);
      case "/userinfo":
        return withCors(await proxyAuth0(request, env, "/userinfo"), request, env);
      case "/v2/logout":
        return proxyAuth0Logout(request, env);
      case "/login":
        return await login(request, env);
      case "/oauth2/callback":
        return await callback(request, env);
      case "/session":
      case "/profile":
        return await profile(request, env);
      case "/validate":
        return await validate(request, env);
      case "/logout":
        return await logout(request, env);
      default:
        return withCors(json({ error: "not_found" }, 404), request, env);
    }
  } catch (error) {
    console.error(error);
    return withCors(
      json({ error: "server_error", error_description: publicError(error) }, 500),
      request,
      env,
    );
  }
}

function appleAppSiteAssociation(env) {
  const configured = String(env.APPLE_APP_SITE_ASSOCIATION_JSON || "").trim();
  const body = configured || JSON.stringify({ webcredentials: { apps: [] } });
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function login(request, env) {
  requireConfig(env, ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "COOKIE_SECRET"]);

  const url = new URL(request.url);
  const state = randomToken(32);
  const nonce = randomToken(32);
  const codeVerifier = randomToken(64);
  const codeChallenge = await pkceChallenge(codeVerifier);
  const returnTo = safeReturnTo(url.searchParams.get("return_to"), request, env);
  const redirectUri = callbackUrl(request, env);
  const now = epochSeconds();

  const txCookie = await seal(
    {
      state,
      nonce,
      code_verifier: codeVerifier,
      return_to: returnTo,
      redirect_uri: redirectUri,
      iat: now,
      exp: now + TX_TTL_SECONDS,
    },
    env.COOKIE_SECRET,
  );

  const authUrl = new URL("/authorize", auth0BaseUrl(env));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.AUTH0_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", env.AUTH0_SCOPE || DEFAULT_AUTH0_SCOPE);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (env.AUTH0_AUDIENCE) authUrl.searchParams.set("audience", env.AUTH0_AUDIENCE);

  return redirect(authUrl.toString(), {
    headers: {
      "Set-Cookie": cookieHeader(txCookieName(env), txCookie, env, {
        maxAge: TX_TTL_SECONDS,
        path: "/",
        httpOnly: true,
      }),
    },
  });
}

async function callback(request, env) {
  requireConfig(env, ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "COOKIE_SECRET"]);

  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return html(`Auth failed: ${escapeHtml(error)}`, 401, [
      clearCookieHeader(txCookieName(env), env),
    ]);
  }

  const txToken = requestCookies(request).get(txCookieName(env));
  if (!txToken) return html("Missing login transaction. Start again from /login.", 400);

  const tx = await openSealed(txToken, env.COOKIE_SECRET);
  if (!tx || tx.exp <= epochSeconds()) {
    return html("Login transaction expired. Start again from /login.", 400, [
      clearCookieHeader(txCookieName(env), env),
    ]);
  }

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || state !== tx.state) return html("Invalid login state.", 400);
  if (!code) return html("Missing authorization code.", 400);

  const tokenResponse = await exchangeCode(env, {
    code,
    codeVerifier: tx.code_verifier,
    redirectUri: tx.redirect_uri || callbackUrl(request, env),
  });

  const claims = await verifyAuth0IdToken(tokenResponse.id_token, env, tx.nonce);
  const session = await sessionFromClaims(claims, tokenResponse, env);
  const sealedSession = await seal(session, env.COOKIE_SECRET);
  const maxAge = Math.max(1, session.exp - epochSeconds());

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    cookieHeader(sessionCookieName(env), sealedSession, env, {
      maxAge,
      path: "/",
      httpOnly: true,
    }),
  );
  headers.append("Set-Cookie", clearCookieHeader(txCookieName(env), env));
  headers.set("Location", absoluteReturnTo(tx.return_to, request));

  return new Response(null, { status: 302, headers });
}

async function profile(request, env) {
  requireConfig(env, ["COOKIE_SECRET"]);
  const session = await readSession(request, env);
  if (!session) {
    return withCors(json({ error: "unauthorized" }, 401), request, env);
  }
  return withCors(json({ authenticated: true, user: publicUser(session) }), request, env);
}

async function validate(request, env) {
  requireConfig(env, ["COOKIE_SECRET"]);
  const session = await readSession(request, env);
  const response = session
    ? { valid: true, user_id: session.user_id, user: publicUser(session) }
    : { valid: false, user_id: null, user: null };
  return withCors(json(response), request, env);
}

async function logout(request, env) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("return_to"), request, env);
  const headers = new Headers();
  headers.append("Set-Cookie", clearCookieHeader(sessionCookieName(env), env));
  headers.append("Set-Cookie", clearCookieHeader(txCookieName(env), env));
  headers.set("Location", logoutRedirectUrl(returnTo, request, env));
  return withCors(new Response(null, { status: 302, headers }), request, env);
}

function homeResponse(request, env) {
  const origin = new URL(request.url).origin;
  return html(
    `<!doctype html>
<meta charset="utf-8">
<title>Wavey ID</title>
<style>
  body { font: 16px/1.4 system-ui, sans-serif; margin: 2rem; max-width: 42rem; }
  code { background: #f4f4f4; padding: .1rem .25rem; }
</style>
<h1>Wavey ID</h1>
<p>Shared Auth0-backed identity broker is running.</p>
<p><a href="${origin}/login">Sign in</a></p>
<ul>
  <li><code>GET /.well-known/openid-configuration</code></li>
  <li><code>GET /authorize</code></li>
  <li><code>POST /oauth/token</code></li>
  <li><code>GET /login?return_to=...</code></li>
  <li><code>GET /session</code></li>
  <li><code>GET /profile</code></li>
  <li><code>GET /validate</code></li>
  <li><code>POST /logout</code></li>
</ul>
<p>Cookie domain: <code>${escapeHtml(env.COOKIE_DOMAIN || "(host-only)")}</code></p>`,
    200,
  );
}

async function oidcDiscovery(request, env) {
  requireConfig(env, ["AUTH0_DOMAIN"]);
  const upstreamResponse = await fetch(new URL("/.well-known/openid-configuration", auth0BaseUrl(env)), {
    headers: { Accept: "application/json" },
  });
  if (!upstreamResponse.ok) {
    return withCors(json({ error: "upstream_discovery_failed" }, upstreamResponse.status), request, env);
  }

  const upstream = await upstreamResponse.json();
  const baseUrl = publicBaseUrl(request, env);
  const discovery = {
    ...upstream,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    userinfo_endpoint: `${baseUrl}/userinfo`,
    end_session_endpoint: `${baseUrl}/v2/logout`,
  };

  return withCors(json(discovery), request, env);
}

function proxyAuthorize(request, env) {
  requireConfig(env, ["AUTH0_DOMAIN"]);
  const requestUrl = new URL(request.url);
  const authorizeUrl = new URL("/authorize", auth0BaseUrl(env));
  authorizeUrl.search = requestUrl.search;
  return redirect(authorizeUrl.toString());
}

async function proxyToken(request, env) {
  requireConfig(env, ["AUTH0_DOMAIN"]);
  if (request.method !== "POST") {
    return withCors(json({ error: "method_not_allowed" }, 405), request, env);
  }

  const headers = new Headers();
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  const accept = request.headers.get("Accept");
  if (accept) headers.set("Accept", accept);

  const response = await fetch(new URL("/oauth/token", auth0BaseUrl(env)), {
    method: "POST",
    headers,
    body: request.body,
  });

  return withCors(proxyResponse(response), request, env);
}

async function proxyAuth0Json(request, env, pathname) {
  return withCors(await proxyAuth0(request, env, pathname), request, env);
}

async function proxyAuth0(request, env, pathname) {
  requireConfig(env, ["AUTH0_DOMAIN"]);
  const target = new URL(pathname, auth0BaseUrl(env));
  target.search = new URL(request.url).search;

  const headers = new Headers();
  const accept = request.headers.get("Accept");
  if (accept) headers.set("Accept", accept);
  const authorization = request.headers.get("Authorization");
  if (authorization) headers.set("Authorization", authorization);

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
  });
  return proxyResponse(response);
}

function proxyAuth0Logout(request, env) {
  requireConfig(env, ["AUTH0_DOMAIN"]);
  const requestUrl = new URL(request.url);
  const target = new URL("/v2/logout", auth0BaseUrl(env));
  target.search = requestUrl.search;
  return redirect(target.toString());
}

async function exchangeCode(env, { code, codeVerifier, redirectUri }) {
  const response = await fetch(new URL("/oauth/token", auth0BaseUrl(env)), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: env.AUTH0_CLIENT_ID,
      client_secret: env.AUTH0_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Auth0 token exchange failed: ${response.status} ${await response.text()}`);
  }

  const tokens = await response.json();
  if (!tokens.id_token) throw new Error("Auth0 token response did not include id_token");
  return tokens;
}

async function verifyAuth0IdToken(token, env, expectedNonce) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const header = decodeJwtPart(parts[0]);
  const claims = decodeJwtPart(parts[1]);
  if (!header.kid || !header.alg) throw new Error("JWT header missing kid or alg");

  const jwksResponse = await fetch(new URL("/.well-known/jwks.json", auth0BaseUrl(env)));
  if (!jwksResponse.ok) throw new Error(`Could not fetch JWKS: ${jwksResponse.status}`);
  const jwks = await jwksResponse.json();
  const jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("No matching JWKS key for JWT");

  const verified = await verifyJwtSignature(header.alg, jwk, `${parts[0]}.${parts[1]}`, parts[2]);
  if (!verified) throw new Error("Invalid JWT signature");

  const now = epochSeconds();
  const expectedIssuer = `${auth0BaseUrl(env).replace(/\/$/, "")}/`;
  if (claims.iss !== expectedIssuer) throw new Error("Invalid JWT issuer");
  if (!audienceIncludes(claims.aud, env.AUTH0_CLIENT_ID, claims.azp)) {
    throw new Error("Invalid JWT audience");
  }
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("JWT expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new Error("JWT not yet valid");
  if (typeof claims.iat === "number" && claims.iat > now + 60) throw new Error("JWT issued in the future");
  if (expectedNonce && claims.nonce !== expectedNonce) throw new Error("Invalid JWT nonce");

  return claims;
}

async function verifyJwtSignature(alg, jwk, signingInput, signaturePart) {
  const signature = base64urlToBytes(signaturePart);
  const data = encoder.encode(signingInput);

  if (alg === "RS256") {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  }

  if (alg === "ES256") {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, data);
  }

  throw new Error(`Unsupported JWT alg: ${alg}`);
}

async function sessionFromClaims(claims, tokenResponse, env) {
  const now = epochSeconds();
  const configuredTtl = numberEnv(env.SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS);
  const upstreamExp = typeof claims.exp === "number" ? claims.exp : now + configuredTtl;
  const exp = Math.min(upstreamExp, now + configuredTtl);
  const stableSource = claims.email || claims.sub;

  return {
    iss: claims.iss,
    sub: claims.sub,
    email: claims.email || null,
    email_verified: Boolean(claims.email_verified),
    name: claims.name || null,
    picture: claims.picture || null,
    user_id: await stableUserId(stableSource),
    iat: now,
    exp,
    token_type: tokenResponse.token_type || "Bearer",
  };
}

async function readSession(request, env) {
  const token = requestCookies(request).get(sessionCookieName(env));
  if (!token) return null;

  try {
    const session = await openSealed(token, env.COOKIE_SECRET);
    if (!session || typeof session.exp !== "number" || session.exp <= epochSeconds()) return null;
    return session;
  } catch {
    return null;
  }
}

function publicUser(session) {
  return {
    id: session.user_id,
    sub: session.sub,
    email: session.email,
    email_verified: session.email_verified,
    name: session.name,
    picture: session.picture,
  };
}

export async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const plaintext = encoder.encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return `v1.${bytesToBase64url(iv)}.${bytesToBase64url(new Uint8Array(encrypted))}`;
}

export async function openSealed(token, secret) {
  const [version, ivPart, encryptedPart] = String(token || "").split(".");
  if (version !== "v1" || !ivPart || !encryptedPart) return null;
  const key = await aesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlToBytes(ivPart) },
    key,
    base64urlToBytes(encryptedPart),
  );
  return JSON.parse(decoder.decode(decrypted));
}

async function aesKey(secret) {
  if (!secret || String(secret).length < 24) {
    throw new Error("COOKIE_SECRET must be at least 24 characters");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return bytesToBase64url(new Uint8Array(digest));
}

async function stableUserId(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value || ""))));
  let id = 0n;
  for (let i = 0; i < 8; i += 1) id = (id << 8n) + BigInt(digest[i]);
  return id.toString();
}

function auth0BaseUrl(env) {
  const raw = String(env.AUTH0_DOMAIN || "").trim();
  if (!raw) throw new Error("AUTH0_DOMAIN is required");
  return raw.startsWith("http://") || raw.startsWith("https://")
    ? raw.replace(/\/+$/, "")
    : `https://${raw.replace(/\/+$/, "")}`;
}

function callbackUrl(request, env) {
  if (env.REDIRECT_URI) return env.REDIRECT_URI;
  return `${publicBaseUrl(request, env)}/oauth2/callback`;
}

export function safeReturnTo(value, request, env = {}) {
  if (!value) return "/";
  const raw = String(value).trim();
  if (!raw) return "/";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "/";

    const allowedOrigins = new Set([
      new URL(request.url).origin,
      ...parseCsv(env.ALLOWED_RETURN_ORIGINS),
      ...parseCsv(env.ALLOWED_ORIGINS),
    ]);
    if (allowedOrigins.has(url.origin)) return url.toString();

    const cookieDomain = String(env.COOKIE_DOMAIN || "").trim().replace(/^\./, "");
    if (cookieDomain) {
      const host = url.hostname.toLowerCase();
      if (host === cookieDomain || host.endsWith(`.${cookieDomain}`)) return url.toString();
    }
  } catch {
    return "/";
  }

  return "/";
}

function absoluteReturnTo(value, request) {
  return new URL(value || "/", request.url).toString();
}

function logoutRedirectUrl(returnTo, request, env) {
  const fallbackReturnTo = absoluteReturnTo(returnTo, request);
  if (!env.AUTH0_DOMAIN || !env.AUTH0_CLIENT_ID) return fallbackReturnTo;

  const logoutUrl = new URL("/v2/logout", auth0BaseUrl(env));
  logoutUrl.searchParams.set("client_id", env.AUTH0_CLIENT_ID);
  logoutUrl.searchParams.set("returnTo", fallbackReturnTo);
  return logoutUrl.toString();
}

function publicBaseUrl(request, env) {
  const configured = String(env.PUBLIC_BASE_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

function requestCookies(request) {
  return parseCookies(request.headers.get("Cookie") || "");
}

export function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    cookies.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  return cookies;
}

function cookieHeader(name, value, env, options = {}) {
  const parts = [`${name}=${value}`, `Path=${options.path || "/"}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (secureCookies(env)) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (env.COOKIE_DOMAIN) parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  return parts.join("; ");
}

function clearCookieHeader(name, env) {
  return cookieHeader(name, "", env, { maxAge: 0, path: "/", httpOnly: true });
}

function secureCookies(env) {
  return String(env.COOKIE_SECURE || "true").toLowerCase() !== "false";
}

function sessionCookieName(env) {
  return env.COOKIE_NAME || DEFAULT_COOKIE_NAME;
}

function txCookieName(env) {
  return env.TX_COOKIE_NAME || DEFAULT_TX_COOKIE_NAME;
}

function redirect(location, init = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...(init.headers || {}),
    },
  });
}

function html(body, status = 200, setCookies = []) {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return new Response(body, { status, headers });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function proxyResponse(response) {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("set-cookie2");
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withCors(response, request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return response;

  const allowedOrigins = parseCsv(env.ALLOWED_ORIGINS);
  if (!allowedOrigins.includes(origin)) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
  headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requireConfig(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/secret|token|client_secret|cookie/i.test(message)) return "configuration_error";
  return message;
}

function decodeJwtPart(part) {
  return JSON.parse(decoder.decode(base64urlToBytes(part)));
}

function audienceIncludes(audience, expected, azp) {
  if (Array.isArray(audience)) return audience.includes(expected) || azp === expected;
  return audience === expected;
}

function randomToken(byteLength) {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function bytesToBase64url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64urlToBytes(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function numberEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
