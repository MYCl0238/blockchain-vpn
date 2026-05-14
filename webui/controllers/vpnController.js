import { getVpnUiConfig, runVpnCommand } from "../services/vpnService.js";

export async function getVpnStatus(req, res) {
  return sendVpnResponse(res, await runVpnCommand("status"));
}

export async function getVpnHealth(req, res) {
  return sendVpnResponse(res, await runVpnCommand("health"));
}

export async function connectVpn(req, res) {
  return sendVpnResponse(res, await runVpnCommand("connect"));
}

export async function disconnectVpn(req, res) {
  return sendVpnResponse(res, await runVpnCommand("disconnect"));
}

export function getVpnConfig(req, res) {
  res.json({
    ok: true,
    command: "config",
    code: "config",
    message: "VPN UI config loaded",
    state: getVpnUiConfig(),
  });
}

function sendVpnResponse(res, payload) {
  const statusCode = payload.ok ? 200 : payload.code === "not_supported" ? 400 : 503;
  return res.status(statusCode).json(payload);
}
