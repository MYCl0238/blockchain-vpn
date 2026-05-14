import express from "express";
import pool from "../db.js";
import { getUser } from "../services/userService.js";
import { requireLogin } from "../middleware/authMiddleware.js";
import { getUserDevices, setDeviceOnline } from "../services/deviceService.js";

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

router.get("/dashboard", requireLogin, async (req, res) => {
  try {
    let yeniKayıt = req.session.yeniKayıt;
    req.session.yeniKayıt = null; // console.log(req.session.yeniKayıt);

    res.render("dashboard.ejs", { yeniKayıt });
  } catch (err) {
    console.error("Dashboard yüklenirken hata:", err);
    res.status(500).send("Sunucu hatası");
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

    const profileError = req.session.profileError;
    const profileSuccess = req.session.profileSuccess;
    req.session.profileError = null;
    req.session.profileSuccess = null;

    res.render("profile", {
      user,
      devices,
      profileError,
      profileSuccess,
      currentDeviceToken,
    });
  } catch (error) {
    console.error("Profil yüklenirken hata:", error);
    res.status(500).send("Sunucu hatası");
  }
});

export default router;

/*
* /user/profile
Session'daki ID'yi kullanarak kullanıcının tüm bilgilerini DB'den çekiyoruz
Veriyi "profile.ejs" sayfasına gönderiyoruz


*/
