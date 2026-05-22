import express from "express";
import {
  logoutUser,
  deleteDevice,
  getCurrentUser,
} from "../controllers/authController.js";
import { requireLogin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/logout", requireLogin, logoutUser);
router.get("/me", getCurrentUser);
router.post("/devices/delete", requireLogin, deleteDevice);

export default router;
