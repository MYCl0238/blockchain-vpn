import express from "express";
import pool from "../db.js";
import { getUser } from "../services/userService.js";
import { requireLogin } from "../middleware/authMiddleware.js";
import { getUserDevices, setDeviceOnline } from "../services/deviceService.js";
import { getUserIdentitySummary } from "../services/blockchainService.js";

const router = express.Router();

router.get("/", (req, res) => {
  res.render("index");
});

router.get("/auth/register", (req, res) => {
  res.render("register");
});

router.get("/auth/login", (req, res) => {
  res.render("login.ejs");
});

router.get("/auth/desktop-pairing", requireLogin, (req, res) => {
  res.render("desktop-pairing");
});

router.get("/dashboard", requireLogin, async (req, res) => {
  try {
    const newRegistration = req.session.newRegistration;
    req.session.newRegistration = null;
    res.render("dashboard.ejs", { newRegistration });
  } catch (err) {
    console.error("Dashboard yüklenirken hata:", err);
    res.status(500).send("Server error");
  }
});

router.get("/user/profile", requireLogin, async (req, res) => {
  try {
    const user = await getUser(pool, req.session.userId);

    const currentDeviceToken = req.cookies.deviceToken;
    if (currentDeviceToken) {
      await setDeviceOnline(pool, currentDeviceToken, req.session.userId);
    }

    const devices = await getUserDevices(pool, req.session.userId);
    const blockchainIdentity = await getUserIdentitySummary(
      pool,
      req.session.userId,
    );

    res.render("profile", {
      user,
      devices,
      currentDeviceToken,
      blockchainIdentity,
      // Noise pairing's device row stores the Noise pubkey as device_token —
      // the template uses this to render "Eslestirmeyi Cikar" for that row.
      noisePublicKey: user?.noise_public_key || null,
    });
  } catch (error) {
    console.error("Profil yüklenirken hata:", error);
    res.status(500).send("Server error");
  }
});

export default router;

/*
* /user/profile
Session'daki ID'yi kullanarak kullanıcının tüm bilgilerini DB'den çekiyoruz
Veriyi "profile.ejs" sayfasına gönderiyoruz


*/
