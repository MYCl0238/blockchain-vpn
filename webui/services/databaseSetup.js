import { initWalletAuth } from "./walletAuthService.js";
import { initPrivateBlockchain } from "./blockchainService.js";
import { initNoiseIdentity } from "./noiseIdentityService.js";

export async function initDatabase(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(16) PRIMARY KEY,
      recovery_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER NOT NULL,
      user_id VARCHAR(16) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_type TEXT NOT NULL,
      device_token TEXT NOT NULL UNIQUE,
      last_active TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, id),
      CONSTRAINT devices_slot_range CHECK (id BETWEEN 1 AND 5)
    );
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(device_token);`);

  await initWalletAuth(db);
  await initNoiseIdentity(db);
  await initPrivateBlockchain(db);
}
