-- Wavey ID Zeroth registered clients.
--
-- Apply after the Zeroth schema migration. Keep this file deployment-owned:
-- generic client validation stays in zeroth, while Wavey/Bitneedle/Infidelity
-- redirect policies live here.

INSERT INTO zeroth_clients (
  id,
  name,
  secret_hash,
  confidential,
  redirect_uris_json,
  allowed_origins_json,
  allowed_email_domains_json,
  created_at,
  updated_at,
  disabled_at
) VALUES (
  'wavey-browser',
  'Wavey Browser SSO',
  NULL,
  0,
  '["https://wavey.ai/auth/callback","https://www.wavey.ai/auth/callback","https://bitneedle.com/auth/callback","https://www.bitneedle.com/auth/callback","https://infidelity.io/auth/callback","https://www.infidelity.io/auth/callback"]',
  '["https://wavey.ai","https://www.wavey.ai","https://bitneedle.com","https://www.bitneedle.com","https://infidelity.io","https://www.infidelity.io"]',
  '[]',
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
  created_at,
  updated_at,
  disabled_at
) VALUES (
  'bitneedle-web',
  'Bitneedle Web',
  NULL,
  0,
  '["https://bitneedle.com/auth/callback","https://www.bitneedle.com/auth/callback","https://bitneedle.com/dataroom/auth/callback"]',
  '["https://bitneedle.com","https://www.bitneedle.com"]',
  '[]',
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
  updated_at = excluded.updated_at,
  disabled_at = NULL;
