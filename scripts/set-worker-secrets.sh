#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER="${WRANGLER:-npx wrangler}"
CONFIG="${CONFIG:-$ROOT/wrangler.jsonc}"

if [[ "${ALLOW_LEGACY_AUTH0:-}" != "1" ]]; then
  echo "archived Auth0 secret writes are disabled by default; set ALLOW_LEGACY_AUTH0=1 for this invocation" >&2
  exit 1
fi

put_secret() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "missing required secret env: $name" >&2
    exit 1
  fi
  printf "%s" "$value" | $WRANGLER secret put "$name" --config "$CONFIG"
}

put_optional_secret() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "skipping optional secret env: $name"
    return
  fi
  printf "%s" "$value" | $WRANGLER secret put "$name" --config "$CONFIG"
}

put_secret AUTH0_CLIENT_SECRET
put_secret COOKIE_SECRET
put_optional_secret APPLE_APP_SITE_ASSOCIATION_JSON
