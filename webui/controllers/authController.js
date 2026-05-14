import pool from "../db.js";
import {
  generateUser,
  getUser,
  updateUserEmail,
} from "../services/userService.js";
import {
  processDeviceSession,
  setDeviceOffline,
  removeDevice,
} from "../services/deviceService.js";

export const registerUser = async (req, res) => {
  const wantsJson = clientWantsJson(req);
  try {
    let mail = req.body.email?.trim() || null;
    const newUser = await generateUser(pool, mail);

    const userAgent = req.headers["user-agent"];

    const deviceOperation = await processDeviceSession(
      pool,
      newUser.id,
      userAgent,
      null,
    );
    res.cookie("deviceToken", deviceOperation.token, {
      maxAge: 1000 * 60 * 60 * 24 * 365,
      httpOnly: true,
      // secure: true,
    });

    setLoginSession(req, res, newUser.id);

    if (wantsJson) {
      return res.json({
        ok: true,
        user: {
          id: newUser.id,
          recovery_email: newUser.recovery_email,
        },
        deviceToken: deviceOperation.token,
      });
    }

    req.session.yeniKayıt = {
      id: newUser.id,
      mail: newUser.recovery_email,
    };
    return res.redirect("/dashboard");
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    const message =
      err?.code === "23505"
        ? "Bu mail adresi başka 1 hesaba bağlı!!!"
        : "Kayıt sırasında bir hata oluştu.";
    if (wantsJson) {
      return res.status(400).json({ ok: false, error: message });
    }
    return res.render("register", { error: message });
  }
};

export const loginUser = async (req, res) => {
  const wantsJson = clientWantsJson(req);
  const respondErr = (status, message) =>
    wantsJson
      ? res.status(status).json({ ok: false, error: message })
      : res.status(status).render("login", { error: message });

  try {
    const enteredId = req.body.id?.trim().replace(/-/g, "").toUpperCase();
    if (!enteredId || enteredId.length !== 16) {
      return respondErr(400, "İd'yi eksik girdiniz");
    }

    const user = await getUser(pool, enteredId);
    if (!user) {
      return respondErr(
        404,
        "Bu anahtara ait bir kullanıcı bulunamadı. Lütfen tekrar deneyin.",
      );
    }

    const userAgent = req.headers["user-agent"];

    const cookie_token = req.cookies.deviceToken;

    //* cihaz işlemlerinin yapıldığı fonksiyon
    const deviceOperation = await processDeviceSession(
      pool,
      user.id,
      userAgent,
      cookie_token,
    );

    if (deviceOperation.message === "deviceLimit") {
      return respondErr(403, "Maximum cihaz sayısına sahipsiniz");
    } else if (
      deviceOperation.message === "newDevice" ||
      deviceOperation.message === "oldToken"
    ) {
      res.cookie("deviceToken", deviceOperation.token, {
        maxAge: 1000 * 60 * 60 * 24 * 365,
        httpOnly: true,
        // secure: true,
      });
    }

    setLoginSession(req, res, user.id);

    if (wantsJson) {
      return res.json({
        ok: true,
        user: {
          id: user.id,
          recovery_email: user.recovery_email,
        },
        deviceToken: deviceOperation.token,
      });
    }
    return res.redirect("/dashboard");
  } catch (error) {
    console.error(error);
    return respondErr(
      500,
      "Sunucu tarafında bir hata oluştu. Lütfen tekrar deneyin.",
    );
  }
};

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

export const updateProfileEmail = async (req, res) => {
  try {
    const mail = req.body.email?.trim() || null;
    // Onceki degisiklik: Bos e-posta null kabul edilir; doluysa format kontrolu yapilir.
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      req.session.profileError = "Gecerli bir e-posta adresi girin.";
      return res.redirect("/user/profile");
    }

    await updateUserEmail(pool, req.session.userId, mail);
    req.session.profileSuccess = "E-posta bilgisi guncellendi.";

    return res.redirect("/user/profile");
  } catch (error) {
    console.log("PROFILE EMAIL UPDATE error", error);

    req.session.profileError =
      error?.code === "23505"
        ? "Bu e-posta adresi baska bir hesaba bagli."
        : "E-posta guncellenirken bir hata olustu.";

    return res.redirect("/user/profile");
  }
};

function setLoginSession(req, res, userId) {
  req.session.userId = userId;
  req.session.loggedIn = true;
}

function clientWantsJson(req) {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("application/json")) return true;
  const accept = req.headers["accept"] || "";
  if (accept.includes("application/json")) return true;
  return false;
}

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
        recovery_email: user.recovery_email,
      },
    });
  } catch (err) {
    console.error("ME error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
};

/*
^ register function
fonksiyon oluşturulan user'ı return ediyor burada alıoz
yeni user ile ilgili bilgileri alıp gönderiyoruz pop-up kısmında göstermek için
o user id ile giriş yapıyor



 */
