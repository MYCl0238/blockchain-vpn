import express from "express";
import {
  createWalletNonce,
  loginWithWallet,
  registerWithWallet,
  getNoiseIdentity,
  bindNoiseIdentity,
  unbindNoiseIdentity,
} from "../controllers/walletAuthController.js";
import { requireLogin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/nonce", createWalletNonce);
router.post("/register", registerWithWallet);
router.post("/login", loginWithWallet);
router.get("/noise-identity", requireLogin, getNoiseIdentity);
router.post("/noise-identity", requireLogin, bindNoiseIdentity);
router.delete("/noise-identity", requireLogin, unbindNoiseIdentity);

export default router;
