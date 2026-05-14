const CONTROL_BASE_URL =
  process.env.BVPN_CONTROL_BASE_URL || "http://127.0.0.1:8787";
const CONTROL_TOKEN = process.env.BVPN_CONTROL_TOKEN || "";
const TIMEOUT_MS = Number(process.env.BVPN_CONTROL_TIMEOUT_MS || 4000);

function authHeaders() {
  return CONTROL_TOKEN ? { Authorization: `Bearer ${CONTROL_TOKEN}` } : {};
}

async function call(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(new URL(path, CONTROL_BASE_URL), {
      method,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(parsed.error || `Control plane ${method} ${path} -> ${res.status}`);
      err.status = res.status;
      err.payload = parsed;
      throw err;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function allocateTunnelLease({ clientId, platform, deviceName, requestedIp } = {}) {
  return call("POST", "/v1/tunnel/lease", {
    clientId,
    platform: platform || null,
    deviceName: deviceName || null,
    requestedIp: requestedIp || null,
  });
}

export async function releaseTunnelLease({ clientId } = {}) {
  if (!clientId) return { ok: false, removed: false };
  return call("POST", "/v1/tunnel/release", { clientId });
}

export async function listTunnelLeases() {
  return call("GET", "/v1/tunnel/leases");
}

export async function controlPlaneHealth() {
  return call("GET", "/health");
}
