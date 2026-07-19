-- Wavey ID Zeroth registered clients.
--
-- Apply after the Zeroth schema migration. Keep this file deployment-owned:
-- generic client validation stays in zeroth, while Wavey/YL/Infidelity
-- redirect policies live here.

INSERT INTO zeroth_clients (
  id,
  name,
  secret_hash,
  confidential,
  redirect_uris_json,
  allowed_origins_json,
  allowed_email_domains_json,
  issuer_token_audience,
  issuer_token_ttl_seconds,
  created_at,
  updated_at,
  disabled_at
) VALUES (
  'wavey-browser',
  'Wavey Browser SSO',
  NULL,
  0,
  '["https://wavey.ai/auth/callback","https://www.wavey.ai/auth/callback","https://yl.vin/auth/callback","https://infidelity.io/auth/callback","https://www.infidelity.io/auth/callback"]',
  '["https://wavey.ai","https://www.wavey.ai","https://yl.vin","https://infidelity.io","https://www.infidelity.io","https://local.yl.vin:5187","https://127.0.0.1:5187","https://local.yl.vin:5191","https://127.0.0.1:5191"]',
  '[]',
  NULL,
  NULL,
  strftime('%s','now'),
  strftime('%s','now'),
  NULL
) ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  secret_hash = excluded.secret_hash,
  confidential = excluded.confidential,
  redirect_uris_json = excluded.redirect_uris_json,
  allowed_origins_json = excluded.allowed_origins_json,
  allowed_email_domains_json = excluded.allowed_email_domains_json,
  issuer_token_audience = excluded.issuer_token_audience,
  issuer_token_ttl_seconds = excluded.issuer_token_ttl_seconds,
  updated_at = excluded.updated_at,
  disabled_at = NULL;

INSERT INTO zeroth_clients (
  id,
  name,
  secret_hash,
  confidential,
  redirect_uris_json,
  allowed_origins_json,
  allowed_email_domains_json,
  issuer_token_audience,
  issuer_token_ttl_seconds,
  created_at,
  updated_at,
  disabled_at
) VALUES (
  'infidelity-macos',
  'Infidelity macOS',
  NULL,
  0,
  '["http://localhost/oidc-callback"]',
  '[]',
  '[]',
  NULL,
  NULL,
  strftime('%s','now'),
  strftime('%s','now'),
  NULL
) ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  secret_hash = excluded.secret_hash,
  confidential = excluded.confidential,
  redirect_uris_json = excluded.redirect_uris_json,
  allowed_origins_json = excluded.allowed_origins_json,
  allowed_email_domains_json = excluded.allowed_email_domains_json,
  issuer_token_audience = excluded.issuer_token_audience,
  issuer_token_ttl_seconds = excluded.issuer_token_ttl_seconds,
  updated_at = excluded.updated_at,
  disabled_at = NULL;

INSERT INTO zeroth_clients (
  id,
  name,
  secret_hash,
  confidential,
  redirect_uris_json,
  allowed_origins_json,
  allowed_email_domains_json,
  issuer_token_audience,
  issuer_token_ttl_seconds,
  created_at,
  updated_at,
  disabled_at
) VALUES (
  'wavey-ios',
  'Wavey iOS apps',
  NULL,
  0,
  '["wavey://auth/callback","com.waveyai.iosWavey://id.wavey.ai/ios/com.waveyai.iosWavey/callback","com.waveyai.auPlay.auPlayExtension://id.wavey.ai/ios/com.waveyai.auPlay.auPlayExtension/callback","com.waveyai.auSend.auSendExtension://id.wavey.ai/ios/com.waveyai.auSend.auSendExtension/callback"]',
  '[]',
  '[]',
  NULL,
  NULL,
  strftime('%s','now'),
  strftime('%s','now'),
  NULL
) ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  secret_hash = excluded.secret_hash,
  confidential = excluded.confidential,
  redirect_uris_json = excluded.redirect_uris_json,
  allowed_origins_json = excluded.allowed_origins_json,
  allowed_email_domains_json = excluded.allowed_email_domains_json,
  issuer_token_audience = excluded.issuer_token_audience,
  issuer_token_ttl_seconds = excluded.issuer_token_ttl_seconds,
  updated_at = excluded.updated_at,
  disabled_at = NULL;

INSERT INTO zeroth_clients (
  id,
  name,
  secret_hash,
  confidential,
  redirect_uris_json,
  allowed_origins_json,
  allowed_email_domains_json,
  issuer_token_audience,
  issuer_token_ttl_seconds,
  created_at,
  updated_at,
  disabled_at
) VALUES (
  'yl-web',
  'YL Web',
  NULL,
  0,
  '["https://yl.vin/auth/callback","https://local.yl.vin:5187/auth/callback","https://127.0.0.1:5187/auth/callback","https://local.yl.vin:5191/auth/callback","https://127.0.0.1:5191/auth/callback"]',
  '["https://yl.vin","https://local.yl.vin:5187","https://127.0.0.1:5187","https://local.yl.vin:5191","https://127.0.0.1:5191"]',
  '[]',
  'yl-record-issuer',
  300,
  strftime('%s','now'),
  strftime('%s','now'),
  NULL
) ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  secret_hash = excluded.secret_hash,
  confidential = excluded.confidential,
  redirect_uris_json = excluded.redirect_uris_json,
  allowed_origins_json = excluded.allowed_origins_json,
  allowed_email_domains_json = excluded.allowed_email_domains_json,
  issuer_token_audience = excluded.issuer_token_audience,
  issuer_token_ttl_seconds = excluded.issuer_token_ttl_seconds,
  updated_at = excluded.updated_at,
  disabled_at = NULL;

INSERT INTO zeroth_clients (
  id,
  name,
  secret_hash,
  confidential,
  redirect_uris_json,
  allowed_origins_json,
  allowed_email_domains_json,
  issuer_token_audience,
  issuer_token_ttl_seconds,
  created_at,
  updated_at,
  disabled_at
) VALUES (
  'infidelity-web',
  'Infidelity Web',
  NULL,
  0,
  '["https://infidelity.io/auth/callback","https://www.infidelity.io/auth/callback"]',
  '["https://infidelity.io","https://www.infidelity.io"]',
  '[]',
  NULL,
  NULL,
  strftime('%s','now'),
  strftime('%s','now'),
  NULL
) ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  secret_hash = excluded.secret_hash,
  confidential = excluded.confidential,
  redirect_uris_json = excluded.redirect_uris_json,
  allowed_origins_json = excluded.allowed_origins_json,
  allowed_email_domains_json = excluded.allowed_email_domains_json,
  issuer_token_audience = excluded.issuer_token_audience,
  issuer_token_ttl_seconds = excluded.issuer_token_ttl_seconds,
  updated_at = excluded.updated_at,
  disabled_at = NULL;
