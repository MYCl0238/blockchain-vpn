import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const UI_MODE = process.env.BVPN_UI_MODE || "local-bridge";
const BRIDGE_BIN =
  process.env.BVPN_APP_BRIDGE_BIN || "blockchain-vpn-app-bridge";
const BRIDGE_ENABLED = process.env.BVPN_APP_BRIDGE_ENABLED !== "false";
const CONTROL_BASE_URL =
  process.env.BVPN_CONTROL_BASE_URL || "http://127.0.0.1:8787";
const CONTROL_TOKEN = process.env.BVPN_CONTROL_TOKEN || "";
const PUBLIC_CONTROL_LABEL =
  process.env.BVPN_PUBLIC_CONTROL_LABEL || process.env.BVPN_PUBLIC_CONTROL_BASE_URL || CONTROL_BASE_URL;
const PROXY_HOST = process.env.BVPN_PROXY_HOST || "84.21.171.106";
const PROXY_PORT = Number(process.env.BVPN_PROXY_PORT || 3128);
const PROXY_SCHEME = process.env.BVPN_PROXY_SCHEME || "http";
const PROXY_USERNAME = process.env.BVPN_PROXY_USERNAME || "";
const PROXY_PASSWORD = process.env.BVPN_PROXY_PASSWORD || "";
const PROXY_BYPASS_LIST = (process.env.BVPN_PROXY_BYPASS_LIST || "localhost,127.0.0.1,[::1]")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const LOCAL_COMMAND_MAP = new Map([
  ["status", "status"],
  ["health", "health"],
  ["connect", "up"],
  ["disconnect", "down"],
  ["toggle", "toggle"],
  ["restart", "restart"],
  ["logs", "logs"],
]);

export function getVpnUiConfig() {
  return {
    mode: UI_MODE,
    bridge_enabled: BRIDGE_ENABLED,
    control_base_url: CONTROL_BASE_URL,
    public_control_label: PUBLIC_CONTROL_LABEL,
    connect_supported: UI_MODE === "local-bridge",
    browser_extension_supported: UI_MODE === "remote-monitor",
    proxy_available: UI_MODE === "remote-monitor",
    proxy: {
      host: PROXY_HOST,
      port: PROXY_PORT,
      scheme: PROXY_SCHEME,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
      bypassList: PROXY_BYPASS_LIST,
      display: `${PROXY_SCHEME.toUpperCase()} ${PROXY_HOST}:${PROXY_PORT}`,
    },
  };
}

export async function runVpnCommand(command) {
  if (UI_MODE === "remote-monitor") {
    return runRemoteMonitorCommand(command);
  }

  return runLocalBridgeCommand(command);
}

async function runLocalBridgeCommand(command) {
  if (!BRIDGE_ENABLED) {
    return unavailableResult(command, "bridge_disabled");
  }

  const bridgeCommand = LOCAL_COMMAND_MAP.get(command);
  if (!bridgeCommand) {
    return unavailableResult(command, "unsupported_command");
  }

  try {
    const { stdout } = await execFileAsync(BRIDGE_BIN, [bridgeCommand], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });

    const parsed = JSON.parse(stdout);
    return normalizeResult(command, parsed, { mode: UI_MODE });
  } catch (error) {
    return bridgeErrorResult(command, error);
  }
}

async function runRemoteMonitorCommand(command) {
  if (command === "connect" || command === "disconnect") {
    return unavailableResult(
      command,
      "not_supported",
      "Remote monitor mode expects the browser extension to control the proxy.",
      {
        mode: UI_MODE,
        connect_supported: false,
        browser_extension_supported: true,
      },
    );
  }

  if (command !== "status" && command !== "health") {
    return unavailableResult(
      command,
      "not_supported",
      "This command is not available in remote monitor mode.",
      {
        mode: UI_MODE,
        connect_supported: false,
        browser_extension_supported: true,
      },
    );
  }

  try {
    const [healthResponse, statusResponse] = await Promise.all([
      fetch(new URL("/health", CONTROL_BASE_URL)),
      fetch(new URL("/v1/status", CONTROL_BASE_URL), {
        headers: authHeaders(),
      }),
    ]);

    const healthPayload = await healthResponse.json();
    const statusPayload = await statusResponse.json();

    if (!healthResponse.ok) {
      return unavailableResult(
        command,
        "control_health_error",
        healthPayload.error || "Control-plane health check failed",
        { mode: UI_MODE, connect_supported: false, browser_extension_supported: true },
      );
    }

    if (!statusResponse.ok) {
      return unavailableResult(
        command,
        "control_status_error",
        statusPayload.error || "Control-plane status query failed",
        { mode: UI_MODE, connect_supported: false, browser_extension_supported: true },
      );
    }

    return {
      ok: true,
      command,
      code: command === "health" ? "healthy" : "status",
      message:
        command === "health"
          ? "Remote VPN control-plane is reachable"
          : "Remote VPN control-plane status collected",
      state: {
        mode: UI_MODE,
        connect_supported: false,
        browser_extension_supported: true,
        bridge_enabled: false,
        service: healthPayload.ok ? "active" : "inactive",
        enabled: "enabled",
        backend: "remote-monitor",
        tunnel: statusPayload.connected ? "up" : "down",
        default_route: "n/a",
        tun_name: "",
        server: PUBLIC_CONTROL_LABEL,
        pid: statusPayload.pid || null,
        default_route_line: "",
        server_route_line: "",
        public_ip: null,
        profile_id: statusPayload.profileId || null,
      },
    };
  } catch (error) {
    return unavailableResult(
      command,
      "control_plane_unreachable",
      error?.message || "Remote control-plane request failed",
      { mode: UI_MODE, connect_supported: false, browser_extension_supported: true },
    );
  }
}

function authHeaders() {
  if (!CONTROL_TOKEN) {
    return {};
  }
  return {
    Authorization: `Bearer ${CONTROL_TOKEN}`,
  };
}

function normalizeResult(command, payload, extraState = {}) {
  if (!payload || typeof payload !== "object") {
    return unavailableResult(command, "invalid_bridge_response");
  }

  return {
    ok: Boolean(payload.ok),
    command,
    code: payload.code || "unknown",
    message: payload.message || "VPN bridge returned no message",
    state: {
      ...(payload.state || {}),
      ...extraState,
      connect_supported:
        extraState.connect_supported ?? UI_MODE === "local-bridge",
    },
  };
}

function bridgeErrorResult(command, error) {
  const stderr = error?.stderr?.toString().trim();
  const stdout = error?.stdout?.toString().trim();

  if (stderr) {
    try {
      return normalizeResult(command, JSON.parse(stderr), { mode: UI_MODE });
    } catch {
      return unavailableResult(command, "bridge_error", stderr, { mode: UI_MODE });
    }
  }

  if (stdout) {
    try {
      return normalizeResult(command, JSON.parse(stdout), { mode: UI_MODE });
    } catch {
      return unavailableResult(command, "bridge_error", stdout, { mode: UI_MODE });
    }
  }

  if (error?.code === "ENOENT") {
    return unavailableResult(
      command,
      "bridge_missing",
      `VPN bridge binary not found: ${BRIDGE_BIN}`,
      { mode: UI_MODE },
    );
  }

  if (error?.killed) {
    return unavailableResult(
      command,
      "bridge_timeout",
      "VPN bridge timed out",
      { mode: UI_MODE },
    );
  }

  return unavailableResult(
    command,
    "bridge_error",
    error?.message || "VPN bridge call failed",
    { mode: UI_MODE },
  );
}

function unavailableResult(command, code, message, state = {}) {
  return {
    ok: false,
    command,
    code,
    message: message || "VPN bridge is unavailable",
    state,
  };
}
