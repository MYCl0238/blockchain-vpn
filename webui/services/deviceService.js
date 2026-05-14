import { customAlphabet } from "nanoid";
import {
  allocateTunnelLease,
  releaseTunnelLease,
} from "./controlPlane.js";

// Map device_token -> control-plane clientId so the tun-server can route per device.
// Best-effort: control-plane failures must not block device add/remove.
function controlClientIdFor(deviceToken) {
  return deviceToken;
}

async function tryAllocateLease({ deviceToken, deviceType }) {
  try {
    return await allocateTunnelLease({
      clientId: controlClientIdFor(deviceToken),
      platform: deviceType || null,
      deviceName: deviceToken,
    });
  } catch (err) {
    console.warn("controlPlane.allocateTunnelLease failed:", err.message);
    return null;
  }
}

async function tryReleaseLease(deviceToken) {
  try {
    await releaseTunnelLease({ clientId: controlClientIdFor(deviceToken) });
  } catch (err) {
    console.warn("controlPlane.releaseTunnelLease failed:", err.message);
  }
}

//* device_token üretir ve token'i return eder
export function generateToken() {
  const nanoid = customAlphabet("0123456789", 4);
  const token = `DEV-${nanoid()}`;
  //* burada token tabloda var mı diye kontrol etmedik bunu ederiz daha sonra
  return token;
} //! TAMAM

//* userAgent'ı alıp device_type'ı return eder
export function getDeviceType(userAgent) {
  if (!userAgent) return "Unknown"; //* bazen sistemsel arızalardan dolayı userAgent undefined dönebilir
  const ua = userAgent.toLowerCase();

  if (ua.includes("windows")) return "Windows";
  if (ua.includes("mac")) return "Mac";
  if (ua.includes("linux")) return "Linux";
  if (ua.includes("android")) return "Android";
  if (ua.includes("iphone") || ua.includes("ipad")) return "iOS";

  return "Unknown";
} //! TAMAM

//* cihaz sayısını return eder
export async function getDeviceCount(db, userId) {
  const result = await db.query(
    "SELECT COUNT(*) FROM devices WHERE user_id= $1",
    [userId],
  );
  //* COUNT(*) sonucu bize 'count' adında bir string olarak döner, onu sayıya (Number) çeviriyoruz.
  return Number(result.rows[0].count);
} //! TAMAM

//* cihazları return eder
export async function getUserDevices(db, userId) {
  const result = await db.query(
    "SELECT * FROM devices WHERE user_id = $1 ORDER BY id ASC",
    [userId],
  );
  return result.rows;
} //! TAMAM

//* yeni cihaz ekler
export async function addNewDevice(db, userId, type, token) {
  const currentDevices = await getUserDevices(db, userId);

  const usedIds = currentDevices.map((row) => row.id);
  console.log(usedIds);

  let newId = 1;

  while (usedIds.includes(newId)) {
    newId++;
  }

  const result = await db.query(
    // Aktif cihazlar last_active NULL tutulur; yeni giren cihaz pasif gorunmesin.
    "INSERT INTO devices (id, user_id, device_type, device_token, last_active) VALUES ($1, $2, $3, $4, NULL) RETURNING *",
    [newId, userId, type, token],
  );

  await tryAllocateLease({ deviceToken: token, deviceType: type });

  return result.rows[0];
} //! BU TAMAM

//* cihaz siler
export async function removeDevice(db, userId, deviceToken) {
  const device = await db.query(
    "DELETE FROM devices WHERE user_id = $1 AND device_token = $2 RETURNING *",
    [userId, deviceToken],
  );
  if (device.rows[0]) {
    await tryReleaseLease(deviceToken);
  }
  return device.rows[0];
} //! TAMAM

//* 1 token sahip cihaz var ise cihazı yok ise null döner
export async function verifyDevice(db, userId, deviceToken) {
  const result = await db.query(
    "SELECT * FROM devices WHERE user_id = $1 AND device_token = $2",
    [userId, deviceToken],
  );
  const device = result.rows[0];

  if (device) return device;
  else return null;
} //! TAMAM

export async function processDeviceSession(db, userId, userAgent, exToken) {
  if (exToken) {
    const isVerify = await verifyDevice(db, userId, exToken);
    if (isVerify) {
      await setDeviceOnline(db, exToken, userId);
      return { message: "oldToken", token: exToken };
    }
  }

  let deviceCount = await getDeviceCount(db, userId);
  if (deviceCount >= 5) {
    return { message: "deviceLimit" };
  }

  let newToken = generateToken();
  let deviceType = await getDeviceType(userAgent);
  const newDevice = await addNewDevice(db, userId, deviceType, newToken);
  return { message: "newDevice", token: newToken };
}

//* cihaz aktiflik bitince db'ye son görülmeyi yazar. device'ı döner
export async function setDeviceOffline(db, deviceToken) {
  const result = await db.query(
    "UPDATE devices SET last_active = CURRENT_TIMESTAMP WHERE device_token = $1 RETURNING *",
    [deviceToken],
  );
  return result.rows[0];
}

//* cihaz aktifken db'de son görülmeyi NULL yapar. device'ı döner
export async function setDeviceOnline(db, deviceToken, userId = null) {
  const values = userId ? [deviceToken, userId] : [deviceToken];
  const result = await db.query(
    `UPDATE devices
     SET last_active = NULL
     WHERE device_token = $1${userId ? " AND user_id = $2" : ""}
     RETURNING *`,
    values,
  );
  return result.rows[0];
}
