CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(16) PRIMARY KEY,
  recovery_email TEXT,
  wallet_address TEXT UNIQUE,
  wallet_verified_at TIMESTAMPTZ,
  -- 32-byte X25519 Noise IK static pub key, hex-encoded (64 chars). Derived from
  -- the wallet via personal_sign of a canonical message; same wallet → same key
  -- across devices. Server pins this when authenticating Noise handshakes.
  noise_public_key TEXT UNIQUE,
  noise_bound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_auth_nonces (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  nonce TEXT UNIQUE NOT NULL,
  purpose VARCHAR(32) NOT NULL,
  message TEXT NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wallet_nonces_address ON wallet_auth_nonces(wallet_address);
CREATE INDEX IF NOT EXISTS idx_wallet_nonces_expires ON wallet_auth_nonces(expires_at);

CREATE TABLE IF NOT EXISTS private_blockchain (
  id SERIAL PRIMARY KEY,
  block_index INTEGER UNIQUE NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  user_id VARCHAR(16),
  event_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash TEXT NOT NULL,
  block_hash TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_private_blockchain_user ON private_blockchain(user_id);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER NOT NULL,
  user_id VARCHAR(16) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_type TEXT NOT NULL,
  device_token TEXT NOT NULL UNIQUE,
  -- last_active = NULL means the device is currently online;
  -- a timestamp means the device was last seen at that time.
  last_active TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, id),
  CONSTRAINT devices_slot_range CHECK (id BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(device_token);


CREATE TABLE IF NOT EXISTS user_sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire);


-- Migration: drop NOT NULL on devices.last_active so the app can mark online state.
DO $$ BEGIN
  ALTER TABLE devices ALTER COLUMN last_active DROP NOT NULL;
EXCEPTION WHEN others THEN
  -- column may already be nullable; ignore.
  NULL;
END $$;

-- Migration: add wallet + noise columns on pre-existing users tables.
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT UNIQUE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_verified_at TIMESTAMPTZ;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS noise_public_key TEXT UNIQUE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS noise_bound_at TIMESTAMPTZ;
EXCEPTION WHEN others THEN
  NULL;
END $$;
