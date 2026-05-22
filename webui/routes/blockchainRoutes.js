import express from "express";
import pool from "../db.js";
import { requireLogin } from "../middleware/authMiddleware.js";
import {
  getRecentBlocks,
  getPrivateNetworkSummary,
  getUserIdentitySummary,
  verifyBlockchain,
} from "../services/blockchainService.js";

const router = express.Router();

router.get("/status", requireLogin, async (req, res) => {
  try {
    const verification = await verifyBlockchain(pool);
    const blocks = await getRecentBlocks(pool, 10);
    const network = await getPrivateNetworkSummary(pool);
    return res.json({ ...verification, network, recentBlocks: blocks });
  } catch (error) {
    console.error("BLOCKCHAIN STATUS error", error);
    return res.status(500).json({ error: "Blockchain status could not be loaded." });
  }
});

router.get("/me", requireLogin, async (req, res) => {
  try {
    const identity = await getUserIdentitySummary(pool, req.session.userId);
    return res.json(identity);
  } catch (error) {
    console.error("BLOCKCHAIN ME error", error);
    return res.status(500).json({ error: "Blockchain identity could not be loaded." });
  }
});

export default router;
