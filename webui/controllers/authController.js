import pool from "../db.js";
import { getUser } from "../services/userService.js";
import {
  setDeviceOffline,
  removeDevice,
} from "../services/deviceService.js";

export const logoutUser = async (req, res) => {
  try {
    let token = req.cookies.deviceToken;
    if (token) {
      await setDeviceOffline(pool, token);
      // res.clearCookie("deviceToken");
    }
    req.session.destroy(() => {
      res.redirect("/");
    });
  } catch (error) {
    console.log("LOGOUT error", error);
    res.redirect("/");
  }
};

export const deleteDevice = async (req, res) => {
  try {
    const deviceToken = req.body.deviceToken;
    if (!deviceToken) {
      return res.redirect("/user/profile");
    }

    const deletedDevice = await removeDevice(
      pool,
      req.session.userId,
      deviceToken,
    );
    if (!deletedDevice) {
      return res.redirect("/user/profile");
    }

    if (req.cookies.deviceToken === deviceToken) {
      res.clearCookie("deviceToken");
      return req.session.destroy(() => {
        res.redirect("/auth/login");
      });
    }

    return res.redirect("/user/profile");
  } catch (error) {
    console.log("DEVICE DELETE error", error);
    return res.redirect("/user/profile");
  }
};

export const getCurrentUser = async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ ok: false, error: "not_authenticated" });
  }
  try {
    const user = await getUser(pool, req.session.userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }
    return res.json({
      ok: true,
      user: {
        id: user.id,
        wallet_address: user.wallet_address,
      },
    });
  } catch (err) {
    console.error("ME error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
};
