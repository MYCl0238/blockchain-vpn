const ext = typeof browser !== "undefined" ? browser : chrome;

const hostInput = document.getElementById("host");
const portInput = document.getElementById("port");
const schemeInput = document.getElementById("scheme");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const bypassInput = document.getElementById("bypassList");
const saveButton = document.getElementById("saveButton");
const toggleButton = document.getElementById("toggleButton");
const statusEl = document.getElementById("status");

document.addEventListener("DOMContentLoaded", async () => {
  const response = await ext.runtime.sendMessage({ type: "get-config" });
  if (!response.ok) {
    renderStatus(response.error || "Failed to load config", true);
    return;
  }
  renderForm(response.config);
  if (response.config?.privateBrowsingAllowed === false) {
    renderStatus(
      "Firefox/Zen için 'Run in Private Windows' iznini açın.",
      true,
    );
  }
});

saveButton.addEventListener("click", async () => {
  const response = await ext.runtime.sendMessage({
    type: "set-config",
    config: collectForm(),
  });
  if (!response.ok) {
    renderStatus(response.error || "Save failed", true);
    return;
  }
  renderForm(response.config);
  renderStatus("Saved.");
});

toggleButton.addEventListener("click", async () => {
  const nextEnabled = toggleButton.dataset.enabled !== "true";
  const response = await ext.runtime.sendMessage({
    type: "set-config",
    config: {
      ...collectForm(),
      enabled: nextEnabled,
    },
  });
  if (!response.ok) {
    renderStatus(response.error || "Toggle failed", true);
    return;
  }
  renderForm(response.config);
  renderStatus(nextEnabled ? "Proxy enabled." : "Proxy disabled.");
});

function collectForm() {
  return {
    enabled: toggleButton.dataset.enabled === "true",
    host: hostInput.value.trim(),
    port: Number(portInput.value || 0),
    scheme: schemeInput.value,
    username: usernameInput.value.trim(),
    password: passwordInput.value,
    bypassList: bypassInput.value,
  };
}

function renderForm(config) {
  hostInput.value = config.host || "";
  portInput.value = config.port || "";
  schemeInput.value = config.scheme || "http";
  usernameInput.value = config.username || "";
  passwordInput.value = config.password || "";
  bypassInput.value = Array.isArray(config.bypassList)
    ? config.bypassList.join(",")
    : "";
  toggleButton.dataset.enabled = config.enabled ? "true" : "false";
  toggleButton.textContent = config.enabled ? "Disable" : "Enable";
  toggleButton.disabled = config.privateBrowsingAllowed === false;
}

function renderStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}
