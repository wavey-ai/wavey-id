#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER="${WRANGLER:-npx wrangler}"
CONFIG="${CONFIG:-$ROOT/wrangler.zeroth.jsonc}"
DATABASE="${ZEROTH_D1_DATABASE:-wavey-id-zeroth}"
REMOTE_FLAG="${ZEROTH_D1_REMOTE_FLAG:---remote}"
ZEROTH_ROOT="${ZEROTH_ROOT:-$ROOT/../zeroth}"
SCHEMA_FILE="$(mktemp)"

cleanup() {
  rm -f "$SCHEMA_FILE"
}
trap cleanup EXIT

zeroth_cli() {
  (cd "$ZEROTH_ROOT" && cargo run --quiet -p zeroth-cli -- "$@")
}

ensure_column() {
  local statement="$1"
  local error_file
  error_file="$(mktemp)"
  if $WRANGLER d1 execute "$DATABASE" $REMOTE_FLAG --config "$CONFIG" \
    --command "$statement" 2>"$error_file"; then
    rm -f "$error_file"
    return
  fi
  if grep -qi "duplicate column name" "$error_file"; then
    rm -f "$error_file"
    return
  fi
  cat "$error_file" >&2
  rm -f "$error_file"
  exit 1
}

zeroth_cli schema --only migrations --format sql >"$SCHEMA_FILE"

$WRANGLER d1 execute "$DATABASE" $REMOTE_FLAG --config "$CONFIG" \
  --file "$SCHEMA_FILE"

while IFS= read -r statement; do
  if [[ -n "$statement" ]]; then
    ensure_column "$statement"
  fi
done < <(zeroth_cli schema --only compatibility --format lines)

$WRANGLER d1 execute "$DATABASE" $REMOTE_FLAG --config "$CONFIG" \
  --command "INSERT OR IGNORE INTO zeroth_schema_migrations (version, name, applied_at) VALUES (1, 'init', strftime('%s','now'))"

$WRANGLER d1 execute "$DATABASE" $REMOTE_FLAG --config "$CONFIG" \
  --command "INSERT OR IGNORE INTO zeroth_schema_migrations (version, name, applied_at) VALUES (2, 'passkeys', strftime('%s','now'))"

$WRANGLER d1 execute "$DATABASE" $REMOTE_FLAG --config "$CONFIG" \
  --command "INSERT OR IGNORE INTO zeroth_schema_migrations (version, name, applied_at) VALUES (3, 'admin_memberships', strftime('%s','now'))"

$WRANGLER d1 execute "$DATABASE" $REMOTE_FLAG --config "$CONFIG" \
  --file "$ROOT/zeroth.clients.sql"
