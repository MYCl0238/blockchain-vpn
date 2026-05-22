import crypto from "crypto";

const GENESIS_PREVIOUS_HASH = "0";
const GENESIS_EVENT = "GENESIS";

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getBlockchainSecret() {
  return process.env.BLOCKCHAIN_SECRET || process.env.SESSION_SECRET || "dev-secret";
}

export function derivePrivateMemberId(userId) {
  return crypto
    .createHmac("sha256", getBlockchainSecret())
    .update(String(userId))
    .digest("hex");
}

export function calculateBlockHash(block) {
  return sha256(
    stableStringify({
      index: block.block_index,
      timestamp: block.timestamp,
      userId: block.user_id,
      eventType: block.event_type,
      payload: block.payload,
      previousHash: block.previous_hash,
    }),
  );
}

export async function createPrivateBlockchainTable(db) {
  await db.query(`
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
  `);
}

export async function initPrivateBlockchain(db) {
  await createPrivateBlockchainTable(db);

  const existing = await db.query(
    "SELECT block_index FROM private_blockchain WHERE block_index = 0",
  );
  if (existing.rows.length > 0) return;

  const timestamp = new Date().toISOString();
  const genesisBlock = {
    block_index: 0,
    timestamp,
    user_id: null,
    event_type: GENESIS_EVENT,
    payload: {
      network: "blockchain-vpn",
      purpose: "private partner identity chain",
    },
    previous_hash: GENESIS_PREVIOUS_HASH,
  };

  const blockHash = calculateBlockHash(genesisBlock);

  await db.query(
    `INSERT INTO private_blockchain
      (block_index, timestamp, user_id, event_type, payload, previous_hash, block_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (block_index) DO NOTHING`,
    [
      genesisBlock.block_index,
      genesisBlock.timestamp,
      genesisBlock.user_id,
      genesisBlock.event_type,
      genesisBlock.payload,
      genesisBlock.previous_hash,
      blockHash,
    ],
  );
}

export async function createBlock(db, { userId = null, eventType, payload = {} }) {
  const latest = await db.query(
    `SELECT block_index, block_hash
     FROM private_blockchain
     ORDER BY block_index DESC
     LIMIT 1`,
  );

  const previousBlock = latest.rows[0];
  if (!previousBlock) {
    throw new Error("Private blockchain not initialized (no genesis block).");
  }

  const timestamp = new Date().toISOString();
  const block = {
    block_index: previousBlock.block_index + 1,
    timestamp,
    user_id: userId,
    event_type: eventType,
    payload: userId
      ? { privateMemberId: derivePrivateMemberId(userId), ...payload }
      : payload,
    previous_hash: previousBlock.block_hash,
  };

  const blockHash = calculateBlockHash(block);

  const result = await db.query(
    `INSERT INTO private_blockchain
      (block_index, timestamp, user_id, event_type, payload, previous_hash, block_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      block.block_index,
      block.timestamp,
      block.user_id,
      block.event_type,
      block.payload,
      block.previous_hash,
      blockHash,
    ],
  );

  return result.rows[0];
}

export async function getUserBlocks(db, userId) {
  const result = await db.query(
    `SELECT block_index, timestamp, user_id, event_type, payload, previous_hash, block_hash
     FROM private_blockchain
     WHERE user_id = $1
     ORDER BY block_index ASC`,
    [userId],
  );
  return result.rows;
}

export async function getRecentBlocks(db, limit = 20) {
  const result = await db.query(
    `SELECT block_index, timestamp, user_id, event_type, payload, previous_hash, block_hash
     FROM private_blockchain
     ORDER BY block_index DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function verifyBlockchain(db) {
  const result = await db.query(
    `SELECT block_index, timestamp, user_id, event_type, payload, previous_hash, block_hash
     FROM private_blockchain
     ORDER BY block_index ASC`,
  );

  let previousHash = GENESIS_PREVIOUS_HASH;

  for (const row of result.rows) {
    const block = {
      block_index: row.block_index,
      timestamp: new Date(row.timestamp).toISOString(),
      user_id: row.user_id,
      event_type: row.event_type,
      payload: row.payload,
      previous_hash: row.previous_hash,
    };

    const expectedHash = calculateBlockHash(block);

    if (row.previous_hash !== previousHash || row.block_hash !== expectedHash) {
      return {
        valid: false,
        blockCount: result.rows.length,
        brokenAt: row.block_index,
        reason: "Block hash or previous hash does not match.",
      };
    }

    previousHash = row.block_hash;
  }

  return {
    valid: true,
    blockCount: result.rows.length,
    lastHash: previousHash,
  };
}

export async function getUserIdentitySummary(db, userId) {
  const blocks = await getUserBlocks(db, userId);
  const verification = await verifyBlockchain(db);
  const firstBlock = blocks[0] || null;
  const latestBlock = blocks[blocks.length - 1] || null;

  return {
    privateMemberId: derivePrivateMemberId(userId),
    blockCount: blocks.length,
    firstBlock,
    latestBlock,
    chainValid: verification.valid,
    chainBlockCount: verification.blockCount,
    lastHash: verification.lastHash || null,
  };
}

export async function getPrivateNetworkSummary(db) {
  const partnerResult = await db.query("SELECT COUNT(*) FROM users");
  const walletResult = await db.query(
    "SELECT COUNT(*) FROM users WHERE wallet_address IS NOT NULL",
  );
  const latestBlockResult = await db.query(
    `SELECT block_index, event_type, block_hash
     FROM private_blockchain
     ORDER BY block_index DESC
     LIMIT 1`,
  );

  return {
    partnerCount: Number(partnerResult.rows[0].count),
    walletPartnerCount: Number(walletResult.rows[0].count),
    latestBlock: latestBlockResult.rows[0] || null,
  };
}
