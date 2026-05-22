import crypto from "crypto";
import { verifyMessage } from "ethers";

const NONCE_TTL_MINUTES = 5;

export async function addWalletColumnsToUsersTable(db) {
  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS wallet_address TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS wallet_verified_at TIMESTAMPTZ;
  `);
}

export async function createWalletAuthNoncesTable(db) {
  await db.query(`
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
  `);
}

export async function initWalletAuth(db) {
  await addWalletColumnsToUsersTable(db);
  await createWalletAuthNoncesTable(db);
}

export function normalizeWalletAddress(address) {
  const normalized = String(address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    throw new Error("Invalid wallet address.");
  }
  return normalized;
}

export async function issueWalletNonce(db, address, purpose = "login") {
  const walletAddress = normalizeWalletAddress(address);
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = buildWalletMessage(walletAddress, nonce, purpose);

  await db.query(
    `INSERT INTO wallet_auth_nonces
      (wallet_address, nonce, purpose, message, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)`,
    [walletAddress, nonce, purpose, message, NONCE_TTL_MINUTES],
  );

  return { walletAddress, nonce, message };
}

export async function verifyWalletSignature(db, { address, nonce, signature, purpose }) {
  const walletAddress = normalizeWalletAddress(address);
  const result = await db.query(
    `SELECT *
     FROM wallet_auth_nonces
     WHERE wallet_address = $1
       AND nonce = $2
       AND purpose = $3
       AND used = FALSE
       AND expires_at > NOW()
     ORDER BY id DESC
     LIMIT 1`,
    [walletAddress, nonce, purpose],
  );

  const challenge = result.rows[0];
  if (!challenge) {
    throw new Error("Wallet challenge expired or already used.");
  }

  const recoveredAddress = verifyMessage(challenge.message, signature).toLowerCase();
  if (recoveredAddress !== walletAddress) {
    throw new Error("Wallet signature does not match the address.");
  }

  await db.query("UPDATE wallet_auth_nonces SET used = TRUE WHERE id = $1", [challenge.id]);

  return walletAddress;
}

export async function linkWalletToUser(db, userId, walletAddress) {
  const normalizedAddress = normalizeWalletAddress(walletAddress);
  const result = await db.query(
    `UPDATE users
     SET wallet_address = $1,
         wallet_verified_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING *`,
    [normalizedAddress, userId],
  );
  return result.rows[0];
}

export async function getUserByWallet(db, walletAddress) {
  const normalizedAddress = normalizeWalletAddress(walletAddress);
  const result = await db.query(
    "SELECT * FROM users WHERE wallet_address = $1",
    [normalizedAddress],
  );
  return result.rows[0];
}

function buildWalletMessage(walletAddress, nonce, purpose) {
  return [
    "Blockchain VPN authentication",
    `Wallet: ${walletAddress}`,
    `Purpose: ${purpose}`,
    `Nonce: ${nonce}`,
    "Sign this message to prove wallet ownership.",
  ].join("\n");
}
