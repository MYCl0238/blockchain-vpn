import express from "express";
import { requireLogin } from "../middleware/authMiddleware.js";
import {
  connectVpn,
  disconnectVpn,
  getVpnConfig,
  getVpnHealth,
  getVpnStatus,
} from "../controllers/vpnController.js";

const router = express.Router();

router.use(requireLogin);

router.get("/config", getVpnConfig);
router.get("/status", getVpnStatus);
router.get("/health", getVpnHealth);
router.post("/connect", connectVpn);
router.post("/disconnect", disconnectVpn);

export default router;
