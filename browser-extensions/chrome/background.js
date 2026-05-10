const DEFAULT_CONFIG = {
  enabled: false,
  host: "84.21.171.106",
  port: 3128,
  scheme: "http",
  username: "",
  password: "",
  bypassList: ["localhost", "127.0.0.1", "[::1]"],
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get("proxyConfig");
  if (!current.proxyConfig) {
    await chrome.storage.local.set({ proxyConfig: DEFAULT_CONFIG });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "get-config") {
    chrome.storage.local.get("proxyConfig").then((result) => {
      sendResponse({ ok: true, config: result.proxyConfig || DEFAULT_CONFIG });
    });
    return true;
  }

  if (message?.type === "ping") {
    sendResponse({ ok: true, name: "blockchain-vpn-proxy-extension" });
    return false;
  }

  if (message?.type === "set-config") {
    handleSetConfig(message.config)
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }),
      );
    return true;
  }

  if (message?.type === "toggle-proxy") {
    handleToggle(message.enabled)
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }),
      );
    return true;
  }

  return false;
});

chrome.webRequest.onAuthRequired.addListener(
  async (details, callback) => {
    try {
      if (!details.isProxy) {
        callback({});
        return;
      }
      const { proxyConfig } = await chrome.storage.local.get("proxyConfig");
      if (
        proxyConfig?.enabled &&
        proxyConfig?.username &&
        proxyConfig?.password
      ) {
        callback({
          authCredentials: {
            username: proxyConfig.username,
            password: proxyConfig.password,
          },
        });
        return;
      }
      callback({});
    } catch {
      callback({});
    }
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);

async function handleSetConfig(nextConfig) {
  const config = normalizeConfig(nextConfig);
  await chrome.storage.local.set({ proxyConfig: config });
  if (config.enabled) {
    await applyProxy(config);
  } else {
    await clearProxy();
  }
  return config;
}

async function handleToggle(enabled) {
  const { proxyConfig } = await chrome.storage.local.get("proxyConfig");
  const config = normalizeConfig({
    ...(proxyConfig || DEFAULT_CONFIG),
    enabled: Boolean(enabled),
  });
  await chrome.storage.local.set({ proxyConfig: config });
  if (config.enabled) {
    await applyProxy(config);
  } else {
    await clearProxy();
  }
  return config;
}

function applyProxy(config) {
  return chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: config.scheme,
          host: config.host,
          port: config.port,
        },
        bypassList: config.bypassList,
      },
    },
    scope: "regular",
  });
}

function clearProxy() {
  return chrome.proxy.settings.set({
    value: {
      mode: "direct",
    },
    scope: "regular",
  });
}

function normalizeConfig(input = {}) {
  return {
    enabled: Boolean(input.enabled),
    host: String(input.host || DEFAULT_CONFIG.host).trim(),
    port: Number(input.port || DEFAULT_CONFIG.port),
    scheme: ["http", "https", "socks4", "socks5"].includes(input.scheme)
      ? input.scheme
      : DEFAULT_CONFIG.scheme,
    username: String(input.username || "").trim(),
    password: String(input.password || ""),
    bypassList: normalizeBypassList(input.bypassList),
  };
}

function normalizeBypassList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return DEFAULT_CONFIG.bypassList;
}
