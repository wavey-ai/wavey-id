#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER="${WRANGLER:-npx wrangler}"
CONFIG="${CONFIG:-$ROOT/wrangler.zeroth.jsonc}"
CHECK_ONLY="${ZEROTH_SECRETS_CHECK_ONLY:-0}"
BOOTSTRAP_ONLY="${ZEROTH_SECRETS_BOOTSTRAP_ONLY:-0}"
APPLE_ONLY="${ZEROTH_SECRETS_APPLE_ONLY:-0}"
ENV_FILE="${ZEROTH_SECRETS_ENV_FILE:-}"
ZEROTH_ROOT="${ZEROTH_ROOT:-$ROOT/../zeroth}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check | --dry-run)
      CHECK_ONLY=1
      ;;
    --bootstrap-only)
      BOOTSTRAP_ONLY=1
      ;;
    --apple-only)
      APPLE_ONLY=1
      ;;
    --env-file)
      if [[ $# -lt 2 ]]; then
        echo "--env-file requires a path" >&2
        exit 1
      fi
      ENV_FILE="$2"
      shift
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -r "$ENV_FILE" ]]; then
    echo "env file is not readable: $ENV_FILE" >&2
    exit 1
  fi
  # The env file is operator-owned bootstrap material; do not print it.
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

put_secret_value() {
  local name="$1"
  local value="$2"
  if [[ "$CHECK_ONLY" == "1" ]]; then
    echo "validated secret env: $name"
    return
  fi
  printf "%s" "$value" | $WRANGLER secret put "$name" --config "$CONFIG"
}

zeroth_cli() {
  (cd "$ZEROTH_ROOT" && cargo run --quiet -p zeroth-cli -- "$@")
}

validate_secret_format() {
  local name="$1"
  local kind="$2"
  local value="$3"
  if ! printf "%s" "$value" | zeroth_cli validate-secret "$kind" >/dev/null; then
    echo "invalid secret format: $name" >&2
    exit 1
  fi
}

put_secret() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "missing required secret env: $name" >&2
    exit 1
  fi
  put_secret_value "$name" "$value"
}

put_validated_secret() {
  local name="$1"
  local kind="$2"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "missing required secret env: $name" >&2
    exit 1
  fi
  validate_secret_format "$name" "$kind" "$value"
  put_secret_value "$name" "$value"
}

put_optional_secret() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "skipping optional secret env: $name"
    return
  fi
  put_secret_value "$name" "$value"
}

put_optional_validated_secret() {
  local name="$1"
  local kind="$2"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "skipping optional secret env: $name"
    return
  fi
  validate_secret_format "$name" "$kind" "$value"
  put_secret_value "$name" "$value"
}

apple_key_id_from_path() {
  local path="$1"
  local base="${path##*/}"
  if [[ "$base" =~ ^AuthKey_([A-Z0-9]{10})\.p8$ ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
  fi
}

apple_private_key_path_is_app_store_connect() {
  local path="$1"
  local base="${path##*/}"
  [[ "$base" =~ ^AppStore_AuthKey_[A-Z0-9]{10}\.p8$ ]]
}

reject_app_store_connect_apple_key_path() {
  local path="$1"
  if apple_private_key_path_is_app_store_connect "$path"; then
    echo "refusing APPLE_PRIVATE_KEY_PATH because it looks like an App Store Connect/admin key, not a Sign in with Apple login key" >&2
    echo "create a fresh Sign in with Apple key and set APPLE_PRIVATE_KEY_PATH to AuthKey_<KEYID>.p8" >&2
    exit 1
  fi
}

discover_apple_private_key_path() {
  local search_roots=("$ROOT/.wrangler/zeroth" "$ROOT/..")
  local matches=()
  local search_root
  for search_root in "${search_roots[@]}"; do
    if [[ ! -d "$search_root" ]]; then
      continue
    fi
    while IFS= read -r path; do
      matches+=("$path")
    done < <(
      find "$search_root" -maxdepth 1 -type f \
        -name 'AuthKey_*.p8' \
        -print 2>/dev/null | sort
    )
  done

  if [[ "${#matches[@]}" -eq 1 ]]; then
    printf "%s" "${matches[0]}"
  fi
}

prepare_apple_private_key_env() {
  if [[ -z "${APPLE_PRIVATE_KEY:-}" && -z "${APPLE_PRIVATE_KEY_PATH:-}" ]]; then
    local discovered_path
    discovered_path="$(discover_apple_private_key_path)"
    if [[ -n "$discovered_path" ]]; then
      APPLE_PRIVATE_KEY_PATH="$discovered_path"
      echo "using discovered Apple private key path: ${APPLE_PRIVATE_KEY_PATH}"
    fi
  fi

  if [[ -z "${APPLE_KEY_ID:-}" && -n "${APPLE_PRIVATE_KEY_PATH:-}" ]]; then
    reject_app_store_connect_apple_key_path "$APPLE_PRIVATE_KEY_PATH"
    local inferred_key_id
    inferred_key_id="$(apple_key_id_from_path "$APPLE_PRIVATE_KEY_PATH")"
    if [[ -n "$inferred_key_id" ]]; then
      APPLE_KEY_ID="$inferred_key_id"
      echo "using Apple key id inferred from private-key filename: ${APPLE_KEY_ID}"
    fi
  fi
}

put_apple_provider_secrets() {
  if [[ -n "${APPLE_CLIENT_SECRET:-}" ]]; then
    put_secret_value APPLE_CLIENT_SECRET "$APPLE_CLIENT_SECRET"
    return
  fi

  prepare_apple_private_key_env

  local private_key="${APPLE_PRIVATE_KEY:-}"
  if [[ -z "$private_key" && -n "${APPLE_PRIVATE_KEY_PATH:-}" ]]; then
    reject_app_store_connect_apple_key_path "$APPLE_PRIVATE_KEY_PATH"
    if [[ ! -r "$APPLE_PRIVATE_KEY_PATH" ]]; then
      echo "APPLE_PRIVATE_KEY_PATH is not readable: $APPLE_PRIVATE_KEY_PATH" >&2
      exit 1
    fi
    private_key="$(<"$APPLE_PRIVATE_KEY_PATH")"
  fi
  if [[ -z "${APPLE_TEAM_ID:-}" || -z "${APPLE_KEY_ID:-}" || -z "$private_key" ]]; then
    echo "missing required Apple env: APPLE_CLIENT_SECRET or APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY/APPLE_PRIVATE_KEY_PATH" >&2
    exit 1
  fi

  validate_secret_format APPLE_PRIVATE_KEY apple-private-key "$private_key"
  put_secret_value APPLE_TEAM_ID "$APPLE_TEAM_ID"
  put_secret_value APPLE_KEY_ID "$APPLE_KEY_ID"
  put_secret_value APPLE_PRIVATE_KEY "$private_key"
}

put_admin_secret() {
  if [[ -n "${ADMIN_TOKEN_SHA256:-}" ]]; then
    put_secret_value ADMIN_TOKEN_SHA256 "$ADMIN_TOKEN_SHA256"
    return
  fi
  if [[ -n "${ADMIN_TOKEN:-}" ]]; then
    put_secret_value ADMIN_TOKEN "$ADMIN_TOKEN"
    return
  fi
  echo "missing required secret env: ADMIN_TOKEN or ADMIN_TOKEN_SHA256" >&2
  exit 1
}

if [[ "$APPLE_ONLY" == "1" ]]; then
  put_optional_secret ADMIN_USER_IDS
  put_optional_secret ADMIN_EMAILS
  put_apple_provider_secrets
  put_optional_secret APPLE_APP_SITE_ASSOCIATION_JSON
  exit 0
fi

put_validated_secret JWT_ES256_PRIVATE_KEY es256-private-key
put_secret JWT_KEY_ID
put_admin_secret
put_optional_secret ADMIN_USER_IDS
put_optional_secret ADMIN_EMAILS
put_optional_validated_secret JWT_PREVIOUS_PUBLIC_JWKS_JSON previous-public-jwks

if [[ "$BOOTSTRAP_ONLY" == "1" ]]; then
  exit 0
fi

put_secret GOOGLE_CLIENT_SECRET
put_apple_provider_secrets
put_secret SPOTIFY_CLIENT_SECRET
put_optional_secret APPLE_APP_SITE_ASSOCIATION_JSON
