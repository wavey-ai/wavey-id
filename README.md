# Wavey ID

Shared Cloudflare Worker for `id.wavey.ai`.

This service is the single Wavey-owned identity front door for Bitneedle and
Infidelity. It proxies Auth0 for OAuth/OIDC, and it can also create a
Wavey-owned encrypted `HttpOnly` browser session cookie after an Auth0 login.

Login can remain disabled in relying apps while this service is deployed and
configured.

## Runtime Shape

Production host:

```text
https://id.wavey.ai
```

Primary endpoints:

```text
GET  /.well-known/openid-configuration
GET  /.well-known/jwks.json
GET  /.well-known/apple-app-site-association
GET  /authorize
POST /oauth/token
GET  /userinfo
GET  /login?return_to=...
GET  /oauth2/callback
GET  /session
GET  /profile
GET  /validate
GET  /logout?return_to=...
POST /logout
GET  /v2/logout
```

The OIDC discovery document keeps Auth0 as the token issuer, but rewrites the
authorization, token, JWKS, userinfo, and logout endpoints through
`id.wavey.ai`. Native clients can point at `https://id.wavey.ai` while still
validating Auth0-issued ID tokens.

## Cloudflare

Worker route:

```text
id.wavey.ai/*
```

Zone:

```text
wavey.ai
```

DNS:

```text
CNAME id.wavey.ai -> wavey.ai, proxied
```

Deploy:

```sh
npm install
npm run check
npm run deploy:dry-run
npm run deploy
```

Auth0 callback smoke test:

```sh
npm run verify:auth0
```

Secrets:

```sh
wrangler secret put AUTH0_CLIENT_SECRET --config wrangler.jsonc
wrangler secret put COOKIE_SECRET --config wrangler.jsonc
```

`COOKIE_SECRET` should be a long random value:

```sh
openssl rand -base64 32
```

If Apple web credentials are enabled, set an Apple association JSON payload:

```sh
wrangler secret put APPLE_APP_SITE_ASSOCIATION_JSON --config wrangler.jsonc
```

Example value shape:

```json
{
  "webcredentials": {
    "apps": [
      "<APPLE_TEAM_ID>.ai.wavey.infidelity"
    ]
  }
}
```

## Auth0 Configuration

Auth0 tenant:

```text
wavey.eu.auth0.com
```

### Wavey ID Web Application

This Auth0 application is used by the Worker-hosted browser login flow that
sets the `wavey_id_session` cookie.

Worker config:

```text
AUTH0_DOMAIN=wavey.eu.auth0.com
AUTH0_CLIENT_ID=QdLiUA5RC81Q9o9itEAnh4CummEBksZ3
AUTH0_CLIENT_SECRET=<set as Cloudflare secret>
AUTH0_SCOPE=openid profile email
```

The Worker must use a client secret that belongs to this exact client ID. The
current deployment uses the client pair already present in `io/.env`.

Allowed Callback URLs:

```text
https://id.wavey.ai/oauth2/callback
```

The browser login flow will fail with Auth0 `Callback URL mismatch` until this
callback is present on the Auth0 application.

The repeatable check for this is:

```sh
npm run verify:auth0
```

Allowed Logout URLs:

```text
https://id.wavey.ai/
https://bitneedle.com/
https://www.bitneedle.com/
https://infidelity.io/
https://www.infidelity.io/
```

Allowed Web Origins:

```text
https://id.wavey.ai
https://bitneedle.com
https://www.bitneedle.com
https://infidelity.io
https://www.infidelity.io
```

Allowed Origins / CORS:

```text
https://bitneedle.com
https://www.bitneedle.com
https://infidelity.io
https://www.infidelity.io
https://id.wavey.ai
```

### Infidelity macOS Native Application

This Auth0 application is used by the Swift OIDC client. Login is currently
disabled in the Infidelity UI, but the code points at this shared issuer.

Native client id:

```text
QdLiUA5RC81Q9o9itEAnh4CummEBksZ3
```

Issuer URL:

```text
https://id.wavey.ai
```

Allowed Callback URLs:

```text
http://localhost:*/oidc-callback
```

If Auth0 does not accept a wildcard port for this tenant, switch the macOS app
to a fixed loopback port or a custom URL scheme before enabling real login.

Allowed Logout URLs:

```text
https://id.wavey.ai/
https://infidelity.io/
https://www.infidelity.io/
```

### Bitneedle

Bitneedle no longer has its own `id.bitneedle.com` Worker. Use the Wavey ID web
application above for browser login.

Bitneedle return/logout URLs to allow in Auth0:

```text
https://bitneedle.com/
https://www.bitneedle.com/
https://bitneedle.com/dataroom/
```

### Infidelity Web

Infidelity web return/logout URLs to allow in Auth0:

```text
https://infidelity.io/
https://www.infidelity.io/
```

## Apple Configuration

Infidelity macOS Associated Domains entitlement:

```text
webcredentials:id.wavey.ai
```

Apple App Site Association URL served by this Worker:

```text
https://id.wavey.ai/.well-known/apple-app-site-association
```

Apple App Site Association payload shape:

```json
{
  "webcredentials": {
    "apps": [
      "<APPLE_TEAM_ID>.ai.wavey.infidelity"
    ]
  }
}
```

## Relying Party URLs

### Bitneedle

Login URL:

```text
https://id.wavey.ai/login?return_to=https%3A%2F%2Fbitneedle.com%2Fdataroom%2F
```

Session/profile check from browser JS:

```js
const res = await fetch("https://id.wavey.ai/session", {
  credentials: "include",
});
```

Server-side Worker validation compatibility endpoint:

```text
https://id.wavey.ai/validate
```

Note: browser cookies from `id.wavey.ai` are not sent to `bitneedle.com`.
Bitneedle's dataroom login remains disabled for now with
`BITNEEDLE_AUTH_BYPASS = "always"`. Before restoring a server-side Bitneedle
gate, add a site callback/token handoff flow or use client-side session checks
against `id.wavey.ai`.

### Infidelity

Website session/profile check:

```js
const res = await fetch("https://id.wavey.ai/session", {
  credentials: "include",
});
```

macOS OIDC issuer:

```text
https://id.wavey.ai
```

macOS login is still disabled in the current app UI; the test-user button can
remain the active path until Auth0 and Apple settings above are configured.

## Notes

- The Worker stores browser session state in encrypted cookies.
- No KV or Durable Object is required for the current stateless session model.
- Auth0 remains the upstream issuer of ID tokens.
- `id.wavey.ai` is the only Worker that should own shared login. Do not deploy a
  separate `id.bitneedle.com` auth Worker.
