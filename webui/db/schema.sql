CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(16) PRIMARY KEY,
  recovery_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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
