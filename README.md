# Wavey ID

Shared Cloudflare Worker for `id.wavey.ai`.

This service is the single Wavey-owned identity front door for Bitneedle,
Infidelity, and Wavey apps. The active implementation is the generic Rust
Zeroth Worker in `../zeroth`; this repo owns deployment configuration,
registered clients, provider credentials, and Wavey-specific Apple association
data.

Login can remain disabled in relying apps while this service is deployed and
configured.

## Zeroth Deployment

The default `npm run dev`, `npm run deploy:dry-run`, and `npm run deploy`
commands use `wrangler.zeroth.jsonc` and deploy the generic Zeroth Worker as
`id.wavey.ai` without copying auth implementation code into this repo.

The `zeroth:*` Cloudflare scripts run through `scripts/zeroth-cloudflare.mjs`.
By default it reads the Wavey/Bitneedle global API key from `../.cloudflare-token`,
sets `CLOUDFLARE_EMAIL=jamie@wavey.ai`, and unsets any stale
`CLOUDFLARE_API_TOKEN` before invoking Wrangler. Set `CLOUDFLARE_API_KEY_PATH`
or `CLOUDFLARE_EMAIL` to override those defaults, or set
`ZEROTH_CLOUDFLARE_AUTH=oauth` to intentionally use the saved Wrangler login.
This keeps deployment on the credential path that can read and edit Workers
Scripts for account `c57bb20727aa3564966d2bb693abddce`.

```sh
npm install
npm run deploy:dry-run
npm run zeroth:deploy:preflight:local
npm run zeroth:verify:local
```

Before the first deploy, create a D1 database and replace
`database_id` in `wrangler.zeroth.jsonc`:

```sh
npx wrangler d1 create wavey-id-zeroth
```

Apply the generic schema and Wavey-owned registered clients:

```sh
npm run zeroth:d1:init
```

The direct D1 helper asks `zeroth-cli` for the generic schema exported by
`zeroth-storage`, repairs compatibility columns for older test databases,
records the generic `init` migration in `zeroth_schema_migrations`, and then
seeds Wavey-owned clients. Inspect the generic SQL with:

```sh
npm run zeroth:schema
```

Bootstrap Zeroth signing and admin secrets before provider credentials are
available. The generated file is ignored by Git and should stay local:

```sh
mkdir -p .wrangler
npm run --silent zeroth:signing-key -- --kid wavey-id-2026-06-04 > .wrangler/zeroth-bootstrap.env
printf "\nexport ADMIN_TOKEN='%s'\n" "$(openssl rand -base64 32 | tr -d '\n')" >> .wrangler/zeroth-bootstrap.env
printf 'export ZEROTH_ADMIN_TOKEN=${ADMIN_TOKEN}\n' >> .wrangler/zeroth-bootstrap.env
chmod 600 .wrangler/zeroth-bootstrap.env
npm run zeroth:secrets:bootstrap:check
npm run zeroth:secrets:bootstrap
```

`npm run zeroth:secrets:bootstrap` uploads only `JWT_KEY_ID`,
`JWT_ES256_PRIVATE_KEY`, `ADMIN_TOKEN` or `ADMIN_TOKEN_SHA256`, and optional
admin allowlist or JWKS-rotation secrets from `.wrangler/zeroth-bootstrap.env`.
It does not require Apple, Google, or Spotify provider secrets. It still needs a
Cloudflare token with Workers Scripts secret-write permission.

Set provider and signing secrets:

```sh
export GOOGLE_CLIENT_SECRET=...
export APPLE_TEAM_ID=...
# APPLE_KEY_ID can be inferred from AuthKey_<KEYID>.p8 filenames.
export APPLE_PRIVATE_KEY_PATH=.wrangler/zeroth/AuthKey_YOURKEYID.p8
export SPOTIFY_CLIENT_SECRET=...
source <(npm run --silent zeroth:signing-key -- --kid wavey-id-2026-06-04)
# Optional during signing-key rotation:
# export JWT_PREVIOUS_PUBLIC_JWKS_JSON='{"keys":[...]}'
export ADMIN_TOKEN=...
# Optional after the first Zeroth admin user has logged in:
# export ADMIN_USER_IDS=usr_...
# export ADMIN_EMAILS=you@wavey.ai
# Optional if MAGIC_LINK_DELIVERY=resend:
# export RESEND_API_KEY=...
# Optional if MAGIC_LINK_DELIVERY=mailchannels:
# export MAILCHANNELS_API_KEY=...
export APPLE_APP_SITE_ASSOCIATION_JSON='{"webcredentials":{"apps":["<APPLE_TEAM_ID>.ai.wavey.infidelity"]}}'
npm run zeroth:secrets:check
npm run zeroth:secrets
```

To bring up Apple admin login before every active provider is ready, upload only
the Apple provider material and optional admin session allowlist:

```sh
export APPLE_TEAM_ID=2D332SZF9P
# APPLE_KEY_ID can be inferred from AuthKey_<KEYID>.p8 filenames.
export APPLE_PRIVATE_KEY_PATH=.wrangler/zeroth/AuthKey_9A6Y2BQGRB.p8
# Optional after the first Zeroth admin user has logged in:
# export ADMIN_USER_IDS=usr_...
# export ADMIN_EMAILS=you@wavey.ai
npm run zeroth:secrets:apple:check
npm run zeroth:secrets:apple
```

`ADMIN_TOKEN` enables Zeroth's management APIs and the HTTP schema bootstrap
endpoint. Use `ADMIN_TOKEN_SHA256` instead if you want to store only the
SHA-256 hex digest of the bearer token in Cloudflare.
After the first admin login, set `ADMIN_USER_IDS` or `ADMIN_EMAILS` to let the
Zeroth browser session administer `id.wavey.ai` itself; email matches require a
verified primary email. The admin UI has a Zeroth sign-in link that returns to
`https://id.wavey.ai/admin`, and the same-origin API calls work without a bearer
token once that session is allowlisted. Keep `ADMIN_TOKEN` as
bootstrap/emergency access.
`JWT_PREVIOUS_PUBLIC_JWKS_JSON` is optional; set it only during signing-key
rotation when existing relying apps still need retired public ES256 keys in
Zeroth's JWKS.
`npm run zeroth:apple:status` reports local Sign in with Apple readiness without
printing key material, client secrets, or admin tokens. The local Sign in with
Apple key cache lives under `.wrangler/zeroth/AuthKey_<KEYID>.p8`; that folder
is ignored by Git and should contain only provider-login key material. The
parent folder `AppStore_AuthKey_*.p8` file is App Store Connect/admin material,
not Zeroth provider-login material, and the Zeroth secret helper refuses to use
it for `APPLE_PRIVATE_KEY_PATH`.
`npm run zeroth:providers:status` reports local Apple, Google, and Spotify
readiness without printing provider secrets. Disabled providers remain visible
but are not required. Use it before `npm run zeroth:secrets` to check that
active provider client IDs and provider secrets are present. Use
`npm run zeroth:providers:status:remote` after uploading secrets to verify the
deployed Worker secret bindings by name without reading secret values.
`npm run zeroth:secrets:check` validates the local secret environment, Apple
private-key path, Zeroth ES256 signing key format, Apple private-key PEM format,
and optional previous public JWKS without writing anything to Cloudflare.
Use `npm run zeroth:signing-key -- --kid wavey-id-2026-06-04 --format json` if
you want to archive the non-secret public JWKS record for future rotations.

Provider client IDs are non-secret Wrangler vars in `wrangler.zeroth.jsonc`:

```text
DEFAULT_LOGIN_CLIENT_ID=wavey-browser
SESSION_COOKIE_DOMAIN=.wavey.ai
APPLE_CLIENT_ID=ai.wavey.zeroth
GOOGLE_CLIENT_ID=659630448576-rdjkvjjggtj8p4ibm772tivi3m6qiqsn.apps.googleusercontent.com
SPOTIFY_CLIENT_ID=9d756b59b3af4a7ebae549b6ad3f86d4
DISABLED_PROVIDERS=spotify
```

`SESSION_COOKIE_DOMAIN=.wavey.ai` is the Zeroth-native version of the useful
shared-cookie part of `hyper-idp`: first-party Wavey subdomains can receive the
same HttpOnly browser session cookie. It does not make that cookie available to
unrelated registrable domains such as `bitneedle.com` or `infidelity.io`; those
apps still use Zeroth through OIDC redirects and their own app-local sessions.

Spotify is intentionally disabled in this deployment until its app/account
restriction is cleared. Disabled providers remain visible in admin status, but
they are not required for `/ready`, rollout checks, or public login buttons.
For Spotify development-mode apps, clear that restriction by making sure the
Spotify app owner account has Premium, the test login user is allowlisted in
the app's Users Management tab, and Spotify's current-user profile endpoint
`/v1/me` returns HTTP 200 after authorization. Zeroth needs that profile call
because Spotify does not issue an OIDC ID token for this provider path.

After changing provider client IDs or the disabled-provider list, run the strict
deployment config verifier and deployment preflight:

```sh
npm run zeroth:verify
npm run zeroth:deploy:preflight
npm run zeroth:rollout:status
```

The strict verifier and Zeroth's runtime readiness checks reject scaffold
placeholders such as `replace-with-*`, `changeme`, and `<...>`. Use
`npm run zeroth:verify:local` only for local template checks before the real D1
database ID and provider client IDs exist.
`npm run zeroth:deploy:preflight` also checks remote D1 schema access, requires
at least the five seeded Wavey client rows, checks non-mutating Workers
deployment and secret API access, and runs Worker dry-run packaging. If it fails
at `worker_api_read` or `worker_secrets_read` with Cloudflare
`Authentication error [code: 10000]`, the Cloudflare API token needs
`Workers Scripts:Read` and `Workers Scripts:Edit` for account
`c57bb20727aa3564966d2bb693abddce` before `npm run zeroth:secrets` or
`npm run zeroth:deploy` can succeed.
Use `npm run zeroth:deploy:preflight:startup` or
`npm run zeroth:rollout:status:startup` when you also want Wrangler startup
profiling. The startup profile parser fails the preflight when sampled startup
active CPU exceeds the local 10 ms guardrail; inspect the numeric result with
`npm run zeroth:startup:profile` after `npm run zeroth:startup:check`.
`npm run zeroth:rollout:status` condenses config, D1, Workers API, and live-host
state into blockers and next actions. Add `-- --with-build` to include Worker
dry-run packaging, or use `npm run zeroth:rollout:require` when automation must
fail unless the live host is fully Zeroth-ready.

After deploy and secret upload, run the live verifier. It checks discovery and
requires `GET /ready` to return `200` with `ready=true` for the active provider
set:

```sh
npm run zeroth:live:status
npm run zeroth:verify:live
```

`npm run zeroth:live:status` is non-strict rollout visibility. The live host
should report `zeroth_ready` once all active providers pass readiness; disabled
providers such as the current Spotify entry are omitted from public readiness.
Use `npm run zeroth:live:require` when a script must fail unless discovery is
Zeroth-owned.

When the bootstrap token is available locally, run the admin live verifier too.
It checks `GET /__zeroth/db/status` and the seeded registered clients so a live
deployment cannot pass with provider config but missing D1 schema or client
rows:

```sh
export ZEROTH_ADMIN_TOKEN="$ADMIN_TOKEN"
npm run zeroth:verify:live:admin
```

Before provider credentials are ready, use the bootstrap verifier to prove the
deployed backend, admin token, D1 schema, and seeded clients are working while
allowing `/ready` to remain red for whichever active providers are still
missing:

```sh
npm run zeroth:verify:live:admin:bootstrap
```

For the current "try the deployed backend" phase, use the backend status gate:

```sh
npm run zeroth:backend:status
npm run zeroth:backend:require
```

This command requires live discovery, signing config, D1 schema, seeded clients,
Workers API access, Worker secret-list access, active provider readiness,
hosted Apple/Google login redirects, D1-backed user/event/local-auth
persistence evidence, and the 10 ms startup guardrail.

To inspect only the D1-backed persistence surface, run:

```sh
npm run zeroth:persistence:status
```

It verifies the required Zeroth D1 tables and migrations, seeded clients,
persisted users, at least one admin user, audit events, local-auth credential
storage, and provider/admin status APIs without printing bearer tokens.

To inspect only the hosted login path, run:

```sh
npm run zeroth:login:status
```

It verifies that active providers set a transaction cookie and redirect to the
expected upstream authorization host, and that deployment-disabled providers are
not shown in the hosted picker.

To prove the Spotify external account gate after fixing the app owner Premium
and Users Management allowlist state, run:

```sh
SPOTIFY_ACCESS_TOKEN=... npm run zeroth:spotify:status
SPOTIFY_ACCESS_TOKEN=... npm run zeroth:spotify:require
```

The probe calls Spotify's current-user profile endpoint `/v1/me`, checks that
the profile returns HTTP 200 with `account_id` or legacy `id` for Zeroth account
linking, and does not print the access token or profile identifiers.

To inspect magic-link delivery, run:

```sh
npm run zeroth:email:status
npm run zeroth:email:send-test
```

Wavey currently uses Zeroth's default `MAGIC_LINK_DELIVERY=cloudflare_email`.
Cloudflare Email Service requires an active Workers Paid account plan. The email
status script is transport-aware: for `cloudflare_email` it checks the account
subscriptions, the `send_email` binding, sender restrictions, Email Sending
DNS/status APIs, and live Zeroth magic-link delivery evidence without printing
Cloudflare credentials or admin tokens. If the deployment switches to
`MAGIC_LINK_DELIVERY=webhook`, the same status command checks the HTTPS webhook
configuration and live delivery evidence instead of reporting Cloudflare Email
Service blockers. Zeroth also supports `MAGIC_LINK_DELIVERY=resend` with
`RESEND_API_KEY`/`MAGIC_LINK_RESEND_API_KEY`, and
`MAGIC_LINK_DELIVERY=mailchannels` with
`MAILCHANNELS_API_KEY`/`MAGIC_LINK_MAILCHANNELS_API_KEY`; in those modes the
status command checks remote Worker secret presence and live delivery evidence.
`npm run zeroth:backend:status` includes the same result as `email_summary` and
adds magic-link delivery blockers to the stricter `auth0_replacement` gate.

The output separates live issuer readiness from full Auth0 retirement. A
`phase` of `zeroth_ready` means `id.wavey.ai` is serving the Zeroth issuer and
active providers are usable. The `auth0_replacement` block is stricter: it
requires Apple, Google, and Spotify target provider coverage, the seeded relying
clients, the Zeroth-owned route, D1-backed user/admin/audit persistence, and
local-auth delivery evidence. Today that block can remain `ready:false` while
Apple/Google login is usable, for example while Spotify is disabled by
deployment or the selected magic-link sender has not proven delivery.

`DEFAULT_LOGIN_CLIENT_ID` is used by legacy browser SSO entry points such as
`/login?return_to=...` when the relying app does not send an explicit
`client_id`.

For a fresh launch, no live relying service needs migration. Create new Apple
Developer material when Zeroth is otherwise ready, but do not delete existing
Apple apps or identifiers:

```text
1. Create or choose a primary Wavey App ID with Sign in with Apple enabled.
2. Create a new Sign in with Apple key and record Team ID, Key ID, and .p8.
3. Create a new Sign in with Apple Service ID for id.wavey.ai.
4. Register https://id.wavey.ai/oauth2/callback as the Service ID return URL.
5. Set APPLE_CLIENT_ID to that Service ID in wrangler.zeroth.jsonc.
6. Store APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY_PATH through npm run zeroth:secrets:apple.
7. Set APPLE_APP_SITE_ASSOCIATION_JSON only after the final native bundle IDs are known.
```

`npm run zeroth:apple:provision` covers the API-safe part of that list. It
creates or reuses the primary `ai.wavey.id` App ID and enables Sign in with
Apple on that App ID. It defaults to a dry run; pass `-- --apply` to mutate
Apple Developer provisioning records:

```sh
export ASC_ISSUER_ID=...
npm run zeroth:apple:provision
npm run zeroth:apple:provision -- --apply
```

Apple's App Store Connect API can manage bundle IDs and their capabilities when
called with a team API key and issuer ID, but current public API coverage does
not include creating the Sign in with Apple Services ID or downloading a new
Sign in with Apple private key. Those two fresh resources are Developer portal
actions; the `AppStore_AuthKey_*.p8` API/admin key is not the provider-login
private key that Zeroth needs.

Apple's `APPLE_CLIENT_SECRET` is the Sign in with Apple client-secret JWT.
Zeroth can now mint it at runtime from `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and
`APPLE_PRIVATE_KEY` or `APPLE_PRIVATE_KEY_PATH`; the secret helper stores the
private key in Cloudflare as `APPLE_PRIVATE_KEY`. A static JWT is still accepted
if `APPLE_CLIENT_SECRET` is set. Generate a static value from the generic CLI
without mutating Apple Developer records:

Do not reuse the parent-folder `../AppStore_AuthKey_*.p8` admin credential for
Sign in with Apple provider login. Zeroth expects a fresh Sign in with Apple key,
normally downloaded as `AuthKey_<KEYID>.p8`; the secret helper can infer
`APPLE_KEY_ID` only from that exact filename shape. Zeroth still needs the Apple
Team ID and the Service ID used as `APPLE_CLIENT_ID`.

```sh
cd ../zeroth
cargo run -p zeroth-cli -- apple-client-secret \
  --team-id "$APPLE_TEAM_ID" \
  --key-id "$APPLE_KEY_ID" \
  --client-id "$APPLE_CLIENT_ID" \
  --private-key "$APPLE_PRIVATE_KEY_PATH"
```

The seeded public clients are:

```text
wavey-browser     default browser SSO client for wavey.ai, bitneedle.com, and infidelity.io
infidelity-macos  http://localhost/oidc-callback
wavey-ios         wavey://auth/callback and current Auth0.swift-style iOS bundle callbacks
bitneedle-web     https://bitneedle.com/auth/callback, https://www.bitneedle.com/auth/callback
infidelity-web    https://infidelity.io/auth/callback, https://www.infidelity.io/auth/callback
```

All seeded clients currently set `allowed_email_domains_json` to `[]`, so
provider login is not restricted by email domain. Use Zeroth's generic
`allowedEmailDomains` client policy later for first-party-only or admin-only
clients; do not apply a global Wavey domain restriction to Bitneedle,
Infidelity, native, or Spotify-facing clients.

Zeroth treats unported loopback client redirects such as
`http://localhost/oidc-callback` as a native-app policy that allows an ephemeral
loopback port on the same host/path, matching the current Infidelity Swift OIDC
client.

`wrangler.jsonc`, `src/worker.js`, and the Auth0 scripts remain only as an
archived rollback reference. `wrangler.jsonc` now deploys the legacy code as
`wavey-id-auth0-legacy-worker` on workers.dev and does not own the
`id.wavey.ai/*` route.

## Runtime Shape

Production host:

```text
https://id.wavey.ai
```

Primary Zeroth endpoints:

```text
GET  /.well-known/openid-configuration
GET  /.well-known/jwks.json
GET  /.well-known/apple-app-site-association
GET  /ready
GET  /login
GET  /account
GET  /admin
GET  /admin/clients
GET  /providers/status
GET  /clients
POST /clients
DELETE /clients?client_id=...
GET  /users
GET  /users?user_id=...
PATCH /users?user_id=...
GET  /events
GET  /__zeroth/db/status
POST /__zeroth/db/ensure
GET  /authorize
POST /oauth/token
POST /oauth/revoke
GET  /userinfo
GET  /oauth2/callback
GET  /session
GET  /sessions
GET  /profile
GET  /identities
GET  /identities/link
GET  /validate
GET  /logout
POST /logout
```

The Zeroth discovery document uses `https://id.wavey.ai` as issuer and publishes
Zeroth-owned ES256 JWKS. Native clients should validate Zeroth ID tokens, not
Auth0 tokens, after cutover. Zeroth ID tokens include `email`/`email_verified`
and `name`/`picture` only when the client requested the `email` and `profile`
scopes. Authorization-code redirects use query parameters and include
`iss=https://id.wavey.ai` so Swift and browser clients can bind responses to
this issuer. Clients that send `response_mode` must send `query`; unsupported
downstream response modes return `invalid_request` before provider login starts.
Provider callback state is consumed with a conditional D1 update before Zeroth
exchanges an Apple, Google, or Spotify code or creates local sessions/codes, so
a replayed or raced provider callback returns `invalid_request`. The callback
state must also match Zeroth's short-lived HttpOnly transaction cookie, scoped to
`/oauth2/callback` and marked `SameSite=None` for Apple's `form_post`. Clients
can use `prompt=none` for silent SSO: an active Zeroth
browser session that satisfies `max_age` returns a code, while a missing or
too-old session returns `login_required` on the registered redirect. Use
`prompt=login` or `max_age=0` when a Swift or browser client needs fresh
provider authentication. Once a client redirect URI has been validated,
authorization request failures return to that same redirect with `error`,
original `state`, and `iss` rather than JSON. Discovery also advertises
`https://id.wavey.ai/logout` as the OIDC end-session endpoint; post-logout
redirects are accepted only for the resolved registered client.

Registered clients can be seeded with `zeroth.clients.sql` or managed after
deploy through Zeroth itself. The admin gate accepts the bootstrap bearer token
or an allowlisted Zeroth browser session, and covers schema bootstrap, user
lifecycle, and provider-readiness/audit APIs. Disabling a client stops new
authorization/token exchanges and also makes `/userinfo`, `/validate`, and
session CORS checks reject that client from D1:

Zeroth authorization codes are consumed with a conditional D1 update before
credentials are minted, so a replayed or raced code returns `invalid_grant`.
Refresh tokens are rotated on every refresh-token grant and are bound to the
browser session that created the authorization code, including silent
`prompt=none` SSO, and preserve the original `auth_time` in refreshed ID tokens.
The replacement refresh token is issued only after the conditional D1 rotation
update wins. If a rotated token is presented again by the same client, or if the
rotation loses a race, Zeroth revokes the active session-scoped token family
before returning `invalid_grant`. Session logout and user-initiated session
revocation also revoke the refresh-token family bound to that browser session.

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://id.wavey.ai/clients"

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://id.wavey.ai/users"

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://id.wavey.ai/providers/status"

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://id.wavey.ai/events"

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://id.wavey.ai/events?event_type=session.login&client_id=wavey-ios"

curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://id.wavey.ai/__zeroth/db/ensure"
```

The same APIs are available through the hosted management UI at:

```text
https://id.wavey.ai/admin
https://id.wavey.ai/admin/clients
```

Use the bootstrap token on first launch. After provider login succeeds, sign in
from `/admin`, copy the created user ID or verified email into `ADMIN_USER_IDS`
or `ADMIN_EMAILS`, upload secrets again, and then the `id.wavey.ai` admin UI can
administer Zeroth through its own browser session. The admin UI shows the D1
schema/client preflight before loading users, events, and clients, so missing
schema or seed rows are visible without checking raw JSON manually.

Before connecting apps, `GET https://id.wavey.ai/ready` should return `200`.
It checks the HTTPS issuer URL, parseable Zeroth signing material, and configured
active provider credentials without reading D1 or returning secret values.
Placeholder provider IDs or secrets on active providers are reported as
unconfigured and keep readiness false.

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

Archived Auth0 deploy:

```sh
npm install
npm run legacy:auth0:check
npm run legacy:auth0:deploy:dry-run
npm run legacy:auth0:deploy
```

Do not use the archived Auth0 deploy for `id.wavey.ai`; the route belongs to
the Zeroth deployment in `wrangler.zeroth.jsonc`.

Auth0 callback smoke test:

```sh
npm run legacy:auth0:verify
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

## Legacy Auth0 Configuration

This section is migration history for the archived Auth0 Worker. It is not the
active `id.wavey.ai` path.

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
npm run legacy:auth0:verify
```

If an Auth0 Management API token is available, patch the current client in one
step:

```sh
AUTH0_MANAGEMENT_TOKEN=... npm run legacy:auth0:patch
```

Or use an Auth0 machine-to-machine app with `update:clients` access:

```sh
AUTH0_MGMT_CLIENT_ID=... AUTH0_MGMT_CLIENT_SECRET=... npm run legacy:auth0:patch
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

Sign in with Apple provider token exchange needs either `APPLE_CLIENT_SECRET`
or the runtime signing inputs `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and
`APPLE_PRIVATE_KEY`/`APPLE_PRIVATE_KEY_PATH`.

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

That uses the deployment's `DEFAULT_LOGIN_CLIENT_ID=wavey-browser`. A narrower
client can be selected explicitly with `client_id=bitneedle-web`.

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

macOS login is still disabled in the current app UI. Zeroth is the issuer to
use when that UI is wired back up. Apple and Google web login are configured on
`id.wavey.ai`; Spotify is present as a configured provider but disabled by
`DISABLED_PROVIDERS=spotify` until the Spotify app/account restriction is
cleared.

## Notes

- The Worker stores browser session state in D1 and keeps only an opaque session
  id in the secure cookie.
- No KV or Durable Object is required for the current D1-backed session model.
- Zeroth is intended to be the shared issuer of ID tokens after cutover; Auth0
  should only remain in deployment notes as migration history.
- `id.wavey.ai` is the only Worker that should own shared login. Do not deploy a
  separate `id.bitneedle.com` auth Worker.
