// Server-side companion for protocol/udp/internal/noise/identity.go:
//
//   Same canonical message text, same HKDF-SHA256 salt, same X25519 scalar
//   mult. We re-derive the pub key here from the wallet's signature so we
//   don't have to trust the client's claimed pubkey blindly.
//
// Result: a user can rotate devices and we cryptographically know each
// device derived the SAME static identity from the SAME wallet.

import crypto from "crypto";
import { verifyMessage } from "ethers";
import { normalizeWalletAddress } from "./walletAuthService.js";

const HKDF_SALT = "blockchain-vpn-noise-v1";

export async function initNoiseIdentity(db) {
  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS noise_public_key TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS noise_bound_at TIMESTAMPTZ;
  `);
}

export function walletNoiseIdentityMessage(walletAddress) {
  return [
    "Blockchain VPN — Noise identity derivation",
    `Wallet: ${String(walletAddress).toLowerCase()}`,
    "Version: 1",
    "This signature derives your private VPN identity key.",
    "Sign once per wallet; the resulting key never leaves your device.",
  ].join("\n");
}

// Deterministically computes the X25519 public key the client should have
// derived from this same signature. Mirrors DeriveStaticFromSignature in Go.
export function derivePublicKeyFromSignature(signatureHex) {
  const signature = Buffer.from(stripHexPrefix(signatureHex), "hex");
  if (signature.length < 65) {
    throw new Error("Wallet signature must be at least 65 bytes.");
  }

  // HKDF-Extract+Expand with SHA-256, salt = HKDF_SALT, info = "" — same as
  // golang.org/x/crypto/hkdf when called with no info bytes. Output 32B.
  const seed = crypto.hkdfSync(
    "sha256",
    signature,
    Buffer.from(HKDF_SALT),
    Buffer.alloc(0),
    32,
  );

  // X25519 ScalarBaseMult of the (clamped) seed.
  // Node's diffieHellman uses raw scalars; here we use createPublicKey on
  // the private key object via x25519's KeyObject support.
  const privateKey = crypto.createPrivateKey({
    key: pkcs8WrapX25519PrivateKey(Buffer.from(seed)),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" });

  // Strip the SPKI prefix to get the raw 32 bytes.
  // SPKI for X25519 is exactly 44 bytes: 12-byte algorithm-id prefix +
  // 32-byte BIT STRING payload (no unused-bits byte because Ed/X curves
  // encode raw keys per RFC 8410).
  return publicKeyDer.slice(publicKeyDer.length - 32).toString("hex");
}

export async function verifyAndBindNoiseIdentity(db, { user, signature }) {
  if (!user?.wallet_address) {
    throw new Error("User has no wallet — bind a wallet before deriving the Noise key.");
  }
  const walletAddress = normalizeWalletAddress(user.wallet_address);
  const message = walletNoiseIdentityMessage(walletAddress);

  // 1. Verify the signature was produced by the user's bound wallet over the
  //    exact canonical derivation message.
  const recovered = verifyMessage(message, signature).toLowerCase();
  if (recovered !== walletAddress) {
    throw new Error("Noise identity signature did not match the bound wallet.");
  }

  // 2. Deterministically re-derive the Noise public key from the signature
  //    so we never trust a client-claimed pubkey.
  const noisePublicKey = derivePublicKeyFromSignature(signature);

  // 3. Persist. UNIQUE(noise_public_key) so each wallet's derived key is
  //    its own row; collision = the same wallet (or — vanishingly unlikely
  //    — two different wallets that produced the same HKDF output).
  await db.query(
    `UPDATE users
     SET noise_public_key = $1,
         noise_bound_at   = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [noisePublicKey, user.id],
  );

  return { noisePublicKey };
}

export async function getNoisePublicKey(db, userId) {
  const r = await db.query(
    "SELECT noise_public_key, noise_bound_at FROM users WHERE id = $1",
    [userId],
  );
  return r.rows[0] || null;
}

function stripHexPrefix(s) {
  if (typeof s !== "string") throw new Error("signature must be a hex string");
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

// Wrap a raw 32-byte X25519 private key in the minimal PKCS#8 envelope
// Node's crypto.createPrivateKey requires. Per RFC 8410 the structure is:
//
//   SEQUENCE {
//     INTEGER 0,                              -- version
//     SEQUENCE { OID 1.3.101.110 },           -- algorithm = X25519
//     OCTET STRING { OCTET STRING <32 raw> }  -- privateKey wrapper
//   }
//
// That comes out to a fixed 16-byte prefix + the 32 raw bytes.
function pkcs8WrapX25519PrivateKey(raw32) {
  if (raw32.length !== 32) throw new Error("X25519 private key must be 32 bytes");
  const prefix = Buffer.from([
    0x30, 0x2e,                         // SEQUENCE (46)
    0x02, 0x01, 0x00,                   // INTEGER 0
    0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, // SEQUENCE { OID 1.3.101.110 (X25519) }
    0x04, 0x22,                         // OCTET STRING (34)
    0x04, 0x20,                         // inner OCTET STRING (32)
  ]);
  return Buffer.concat([prefix, raw32]);
}
