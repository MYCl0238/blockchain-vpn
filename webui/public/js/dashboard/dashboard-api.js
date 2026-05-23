// Dashboard front-end. Talks to the browser-extension content script
// (browser-extensions/{chrome,firefox}/content-script.js) over window.postMessage
// instead of POSTing to the server-side /api/vpn/connect path. Without the
// extension installed there is nothing on the page that can flip the browser
// proxy, so the Bağlan button stays disabled with a hint.

(function () {
  const EXT_PROBE_TIMEOUT_MS = 1500;
  const EXT_CALL_TIMEOUT_MS = 8000;
  const PAGE_ORIGIN = window.location.origin;

  function newRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function callExtension(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = newRequestId();
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("extension_timeout"));
      }, timeoutMs);

      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "blockchain-vpn-extension") return;
        if (data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (data.ok) {
          resolve(data.response);
        } else {
          reject(new Error(data.error || "extension_error"));
        }
      }

      window.addEventListener("message", onMessage);
      window.postMessage(
        {
          source: "blockchain-vpn-dashboard",
          requestId,
          payload,
        },
        PAGE_ORIGIN,
      );
    });
  }

  function setButtonState(btn, status, label, hint) {
    btn.dataset.status = status;
    btn.textContent = label;
    btn.title = hint || "";
    btn.disabled = status !== "ready" && status !== "connected";
  }

  function setMessage(text, tone) {
    const el = document.getElementById("connectMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = "small mb-2 " + (
      tone === "error"
        ? "text-danger"
        : tone === "success"
          ? "text-success"
          : "text-muted"
    );
  }

  function describeError(err) {
    if (!err) return "Bilinmeyen hata";
    if (typeof err === "string") return err;
    if (err.message) return err.message;
    try { return JSON.stringify(err); } catch { return String(err); }
  }

  async function refreshIpInfo() {
    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    try {
      const res = await fetch("https://ipinfo.io/json");
      const data = await res.json();
      setText("serverLocation", `${data.city} / ${data.country}`);
      setText("serverIp", data.ip);
      setText("serverIsp", data.org);
    } catch (err) {
      console.error("Could not fetch IP info:", err);
      setText("serverLocation", "Unknown");
      setText("serverIp", "Connection error");
    }
  }

  // Pulls server-side proxy config (incl. squid credentials) so the
  // extension can answer the 407 Proxy-Authenticate challenge without
  // prompting the user. The login session is required (cookie-auth).
  async function fetchServerProxyConfig() {
    try {
      const res = await fetch("/api/vpn/config", { credentials: "same-origin" });
      if (!res.ok) return null;
      const json = await res.json();
      return json && json.state && json.state.proxy ? json.state.proxy : null;
    } catch (_) {
      return null;
    }
  }

  // Pushes the server-provided proxy credentials into the extension's
  // local storage, preserving whatever `enabled` value it currently has.
  // Idempotent: a no-op if the extension already has identical creds.
  async function syncCredentialsToExtension(currentCfg, serverProxy) {
    if (!serverProxy || !serverProxy.host) return;
    const same =
      currentCfg &&
      currentCfg.host === serverProxy.host &&
      Number(currentCfg.port) === Number(serverProxy.port) &&
      (currentCfg.scheme || "http") === (serverProxy.scheme || "http") &&
      (currentCfg.username || "") === (serverProxy.username || "") &&
      (currentCfg.password || "") === (serverProxy.password || "");
    if (same) return;
    await callExtension(
      {
        type: "set-config",
        config: {
          enabled: Boolean(currentCfg && currentCfg.enabled),
          host: serverProxy.host,
          port: serverProxy.port,
          scheme: serverProxy.scheme || "http",
          username: serverProxy.username || "",
          password: serverProxy.password || "",
          bypassList: serverProxy.bypassList,
        },
      },
      EXT_CALL_TIMEOUT_MS,
    );
  }

  async function detectExtension(btn) {
    try {
      const pong = await callExtension({ type: "ping" }, EXT_PROBE_TIMEOUT_MS);
      if (pong && pong.ok) {
        let cfg = null;
        try {
          cfg = await callExtension({ type: "get-config" }, EXT_PROBE_TIMEOUT_MS);
        } catch (_) {
          // Fall through to "ready" if get-config fails; we still know the extension is there.
        }
        const serverProxy = await fetchServerProxyConfig();
        try {
          await syncCredentialsToExtension(cfg && cfg.config, serverProxy);
        } catch (e) {
          console.warn("proxy credential sync failed:", e);
        }
        if (cfg && cfg.ok && cfg.config && cfg.config.enabled) {
          setButtonState(btn, "connected", "Connected", "Connected via extension (click to disconnect)");
          setMessage("Extension active, proxy enabled.", "success");
          return;
        }
        setButtonState(btn, "ready", "Connect", "Connect through the browser extension");
        setMessage("Extension ready.", "");
        return;
      }
      throw new Error("bad_pong");
    } catch (err) {
      setButtonState(
        btn,
        "no-extension",
        "Connect (extension required)",
        "Install and enable the Blockchain VPN browser extension",
      );
      setMessage("Blockchain VPN browser extension not found.", "error");
    }
  }

  async function onConnectClick(btn) {
    const wasConnected = btn.dataset.status === "connected";
    const nextEnabled = !wasConnected;
    setButtonState(
      btn,
      "busy",
      nextEnabled ? "Connecting..." : "Disconnecting...",
      "",
    );
    setMessage(nextEnabled ? "Enabling proxy..." : "Disabling proxy...", "");
    try {
      const resp = await callExtension(
        { type: "toggle-proxy", enabled: nextEnabled },
        EXT_CALL_TIMEOUT_MS,
      );
      if (resp && resp.ok && resp.config) {
        if (resp.config.enabled) {
          setButtonState(btn, "connected", "Connected", "Connected via extension (click to disconnect)");
          setMessage(
            `Proxy active: ${resp.config.scheme || "http"}://${resp.config.host}:${resp.config.port}`,
            "success",
          );
        } else {
          setButtonState(btn, "ready", "Connect", "Connect through the browser extension");
          setMessage("Proxy disabled.", "");
        }
        await refreshIpInfo();
        return;
      }
      // The extension wrapper succeeded but the inner result was a failure
      // (e.g. chrome.proxy.settings rejected by enterprise policy, Firefox
      // private-window permission missing, etc.).
      throw new Error((resp && resp.error) || "extension_rejected");
    } catch (err) {
      console.error("VPN toggle failed:", err);
      setButtonState(
        btn,
        wasConnected ? "connected" : "ready",
        wasConnected ? "Connected" : "Connect",
        wasConnected ? "Error occurred" : "Connect through the browser extension",
      );
      setMessage(`Could not connect: ${describeError(err)}`, "error");
    }
  }

  function init() {
    const btn = document.getElementById("connectBtn");
    refreshIpInfo();
    if (!btn) return;
    btn.addEventListener("click", () => {
      const status = btn.dataset.status;
      if (status === "ready" || status === "connected") {
        onConnectClick(btn);
      }
    });
    detectExtension(btn);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.addEventListener("pageshow", () => {
    const btn = document.getElementById("connectBtn");
    if (btn && btn.dataset.status !== "busy") {
      detectExtension(btn);
    }
    refreshIpInfo();
  });
})();
