const ext = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_CONFIG = {
  enabled: false,
  host: "84.21.171.106",
  port: 3128,
  scheme: "http",
  username: "",
  password: "",
  bypassList: ["localhost", "127.0.0.1", "[::1]"],
};

ext.runtime.onInstalled.addListener(async () => {
  const current = await ext.storage.local.get("proxyConfig");
  if (!current.proxyConfig) {
    await ext.storage.local.set({ proxyConfig: DEFAULT_CONFIG });
  }
});

ext.runtime.onMessage.addListener((message) => {
  if (message?.type === "get-config") {
    return Promise.all([
      ext.storage.local.get("proxyConfig"),
      getPrivateBrowsingAccess(),
    ]).then(([result, privateBrowsingAllowed]) => ({
      ok: true,
      config: {
        ...(result.proxyConfig || DEFAULT_CONFIG),
        privateBrowsingAllowed,
      },
    }));
  }

  if (message?.type === "ping") {
    return getPrivateBrowsingAccess().then((privateBrowsingAllowed) => ({
      ok: true,
      name: "blockchain-vpn-proxy-extension",
      privateBrowsingAllowed,
    }));
  }

  if (message?.type === "set-config") {
    return handleSetConfig(message.config)
      .then((config) => ({ ok: true, config }))
      .catch((error) => ({ ok: false, error: error?.message || String(error) }));
  }

  if (message?.type === "toggle-proxy") {
    return handleToggle(message.enabled)
      .then((config) => ({ ok: true, config }))
      .catch((error) => ({ ok: false, error: error?.message || String(error) }));
  }

  return false;
});

ext.webRequest.onAuthRequired.addListener(
  (details) => {
    if (!details.isProxy) {
      return {};
    }
    return ext.storage.local.get("proxyConfig").then(({ proxyConfig }) => {
      if (
        proxyConfig?.enabled &&
        proxyConfig?.username &&
        proxyConfig?.password &&
        (proxyConfig.scheme === "http" || proxyConfig.scheme === "https")
      ) {
        return {
          authCredentials: {
            username: proxyConfig.username,
            password: proxyConfig.password,
          },
        };
      }
      return {};
    });
  },
  { urls: ["<all_urls>"] },
  ["blocking"],
);

async function handleSetConfig(nextConfig) {
  const config = normalizeConfig(nextConfig);
  await ext.storage.local.set({ proxyConfig: config });
  if (config.enabled) {
    await ensurePrivateBrowsingAccess();
    await applyProxy(config);
  } else {
    await ensurePrivateBrowsingAccess();
    await clearProxy();
  }
  return config;
}

async function handleToggle(enabled) {
  const { proxyConfig } = await ext.storage.local.get("proxyConfig");
  const config = normalizeConfig({
    ...(proxyConfig || DEFAULT_CONFIG),
    enabled: Boolean(enabled),
  });
  await ext.storage.local.set({ proxyConfig: config });
  if (config.enabled) {
    await ensurePrivateBrowsingAccess();
    await applyProxy(config);
  } else {
    await ensurePrivateBrowsingAccess();
    await clearProxy();
  }
  return config;
}

async function getPrivateBrowsingAccess() {
  if (!ext.extension?.isAllowedIncognitoAccess) {
    return true;
  }
  try {
    return await ext.extension.isAllowedIncognitoAccess();
  } catch {
    return false;
  }
}

async function ensurePrivateBrowsingAccess() {
  const allowed = await getPrivateBrowsingAccess();
  if (!allowed) {
    throw new Error(
      "Firefox/Zen için uzantıda private browsing access etkin olmalı. about:addons üzerinden 'Run in Private Windows' iznini açın.",
    );
  }
}

function applyProxy(config) {
  if (config.scheme === "socks4" || config.scheme === "socks5") {
    return ext.proxy.settings.set({
      value: {
        proxyType: "manual",
        socks: `${config.host}:${config.port}`,
        socksVersion: config.scheme === "socks4" ? 4 : 5,
        passthrough: config.bypassList.join(","),
      },
    });
  }

  return ext.proxy.settings.set({
    value: {
      proxyType: "manual",
      http: `${config.host}:${config.port}`,
      ssl: `${config.host}:${config.port}`,
      passthrough: config.bypassList.join(","),
      httpProxyAll: true,
    },
  });
}

function clearProxy() {
  return ext.proxy.settings.set({
    value: {
      proxyType: "none",
    },
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
