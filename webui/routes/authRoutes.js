import express from "express";
import {
  registerUser,
  loginUser,
  logoutUser,
  deleteDevice,
  updateProfileEmail,
  getCurrentUser,
} from "../controllers/authController.js";
import { requireLogin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/logout", requireLogin, logoutUser);
router.get("/me", getCurrentUser);
router.post("/devices/delete", requireLogin, deleteDevice);
// Onceki degisiklik: Profildeki e-posta ekleme/degistirme formunun endpoint'i.
router.post("/profile/email", requireLogin, updateProfileEmail);

export default router;
