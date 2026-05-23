import pool from "../db.js";
import { createHash } from "crypto";
import { generateUser, getUser } from "../services/userService.js";
import { processDeviceSession } from "../services/deviceService.js";
import { createBlock } from "../services/blockchainService.js";
import {
  getUserByWallet,
  issueWalletNonce,
  linkWalletToUser,
  verifyWalletSignature,
} from "../services/walletAuthService.js";
import {
  getNoisePublicKey,
  verifyAndBindNoiseIdentity,
  walletNoiseIdentityMessage,
  unbindNoiseIdentityForUser,
} from "../services/noiseIdentityService.js";

export const createWalletNonce = async (req, res) => {
  try {
    const purpose = req.body.purpose === "register" ? "register" : "login";
    const challenge = await issueWalletNonce(pool, req.body.address, purpose);
    return res.json({
      address: challenge.walletAddress,
      nonce: challenge.nonce,
      message: challenge.message,
    });
  } catch (error) {
    console.error("WALLET NONCE error", error);
    return res.status(400).json({ error: "Wallet challenge could not be created." });
  }
};

export const registerWithWallet = async (req, res) => {
  try {
    const walletAddress = await verifyWalletSignature(pool, {
      address: req.body.address,
      nonce: req.body.nonce,
      signature: req.body.signature,
      purpose: "register",
    });

    const existing = await getUserByWallet(pool, walletAddress);
    if (existing) {
      return res.status(409).json({
        error: "This wallet is already registered. Please login instead.",
      });
    }

    const newUser = await generateUser(pool, null);
    await linkWalletToUser(pool, newUser.id, walletAddress);

    const identityBlock = await createBlock(pool, {
      userId: newUser.id,
      eventType: "PARTNER_JOINED_NETWORK",
      payload: {
        authMethod: "metamask_signature",
        walletAddressHash: hashPrivateValue(walletAddress),
      },
    });

    const deviceOperation = await processDeviceSession(
      pool,
      newUser.id,
      req.headers["user-agent"],
      null,
    );
    if (deviceOperation.message === "deviceLimit") {
      return res.status(403).json({ error: "Maximum cihaz sayisina sahipsiniz." });
    }
    setDeviceTokenCookie(res, deviceOperation.token);

    setLoginSession(req, newUser.id);
    req.session.newRegistration = {
      userId: newUser.id,
      walletAddress,
      blockIndex: identityBlock.block_index,
      blockHash: identityBlock.block_hash,
    };

    return res.json({
      redirectTo: "/dashboard",
      user: { id: newUser.id, walletAddress },
      deviceToken: deviceOperation.token,
    });
  } catch (error) {
    console.error("WALLET REGISTER error", error);
    return res.status(400).json({ error: walletErrorMessage(error) });
  }
};

export const loginWithWallet = async (req, res) => {
  try {
    const walletAddress = await verifyWalletSignature(pool, {
      address: req.body.address,
      nonce: req.body.nonce,
      signature: req.body.signature,
      purpose: "login",
    });

    const user = await getUserByWallet(pool, walletAddress);
    if (!user) {
      return res.status(404).json({
        error: "No account is linked to this wallet.",
      });
    }

    await createBlock(pool, {
      userId: user.id,
      eventType: "PARTNER_WALLET_AUTHENTICATED",
      payload: {
        authMethod: "metamask_signature",
        walletAddressHash: hashPrivateValue(walletAddress),
      },
    });

    const deviceOperation = await processDeviceSession(
      pool,
      user.id,
      req.headers["user-agent"],
      req.cookies?.deviceToken,
    );
    if (deviceOperation.message === "deviceLimit") {
      return res.status(403).json({ error: "Maximum cihaz sayisina sahipsiniz." });
    }
    if (
      deviceOperation.message === "newDevice" ||
      deviceOperation.message === "oldToken"
    ) {
      setDeviceTokenCookie(res, deviceOperation.token);
    }

    setLoginSession(req, user.id);

    return res.json({
      redirectTo: "/dashboard",
      user: { id: user.id, walletAddress },
      deviceToken: deviceOperation.token,
    });
  } catch (error) {
    console.error("WALLET LOGIN error", error);
    return res.status(400).json({ error: walletErrorMessage(error) });
  }
};

function setLoginSession(req, userId) {
  req.session.userId = userId;
  req.session.loggedIn = true;
}

function setDeviceTokenCookie(res, token) {
  res.cookie("deviceToken", token, {
    maxAge: 1000 * 60 * 60 * 24 * 365,
    httpOnly: true,
  });
}

function hashPrivateValue(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function walletErrorMessage(error) {
  if (error?.code === "23505") {
    return "This wallet is already linked to another account.";
  }
  return error?.message || "Wallet authentication failed.";
}

// GET /api/wallet/noise-identity
// Returns:
//   - canonical message the client must personal_sign to derive its Noise key
//   - the currently-bound noise_public_key for this user, if any
//
// The client uses `bound` to decide whether to prompt the user to sign:
//   - bound=false: ask wallet to sign `message`, POST signature to this URL
//   - bound=true:  client re-derives locally; result must match `noisePublicKey`
export const getNoiseIdentity = async (req, res) => {
  try {
    const user = await getUser(pool, req.session.userId);
    if (!user?.wallet_address) {
      return res.status(409).json({
        error: "Wallet not bound — link a wallet before deriving a Noise identity.",
      });
    }
    const row = await getNoisePublicKey(pool, user.id);
    return res.json({
      message: walletNoiseIdentityMessage(user.wallet_address),
      bound: Boolean(row?.noise_public_key),
      noisePublicKey: row?.noise_public_key || null,
      boundAt: row?.noise_bound_at || null,
    });
  } catch (error) {
    console.error("NOISE IDENTITY GET error", error);
    return res.status(500).json({ error: "Could not load Noise identity." });
  }
};

// POST /api/wallet/noise-identity
// Body: { signature: "0x..." }
// Server verifies sig over walletNoiseIdentityMessage(wallet_address),
// re-derives the X25519 pubkey from the signature, and stores it.
export const bindNoiseIdentity = async (req, res) => {
  try {
    const user = await getUser(pool, req.session.userId);
    if (!user?.wallet_address) {
      return res.status(409).json({
        error: "Wallet not bound — link a wallet before deriving a Noise identity.",
      });
    }
    const { signature, deviceType } = req.body || {};
    if (!signature) {
      return res.status(400).json({ error: "signature required" });
    }

    const { noisePublicKey } = await verifyAndBindNoiseIdentity(pool, {
      user,
      signature,
      // 'desktop' (linux/win), 'mobile' (android), 'web' (sign-from-webui flow).
      deviceType: typeof deviceType === "string" && deviceType ? deviceType : "desktop",
    });

    await createBlock(pool, {
      userId: user.id,
      eventType: "PARTNER_NOISE_IDENTITY_BOUND",
      payload: {
        // Record only the hash of the pubkey — the pubkey itself is on
        // users.noise_public_key; keeping the chain payload terse avoids
        // duplicating identifiers in two places.
        noisePubKeyHash: hashPrivateValue(noisePublicKey),
      },
    });

    return res.json({ ok: true, noisePublicKey });
  } catch (error) {
    console.error("NOISE IDENTITY BIND error", error);
    return res.status(400).json({ error: walletErrorMessage(error) });
  }
};

// DELETE /api/wallet/noise-identity
// Clears users.noise_public_key + removes the paired-client row from
// devices. The session-bound user is authoritative here — no extra
// signature required since the user is already logged in.
export const unbindNoiseIdentity = async (req, res) => {
  try {
    const user = await getUser(pool, req.session.userId);
    if (!user) {
      return res.status(401).json({ error: "Not authenticated." });
    }
    const { previousNoisePublicKey } = await unbindNoiseIdentityForUser(pool, user.id);

    if (previousNoisePublicKey) {
      await createBlock(pool, {
        userId: user.id,
        eventType: "PARTNER_NOISE_IDENTITY_UNBOUND",
        payload: { noisePubKeyHash: hashPrivateValue(previousNoisePublicKey) },
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("NOISE IDENTITY UNBIND error", error);
    return res.status(400).json({ error: walletErrorMessage(error) });
  }
};
