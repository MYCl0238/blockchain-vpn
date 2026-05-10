window.addEventListener("message", async (event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (!data || data.source !== "blockchain-vpn-dashboard") {
    return;
  }

  try {
    const response = await browser.runtime.sendMessage(data.payload);
    window.postMessage(
      {
        source: "blockchain-vpn-extension",
        requestId: data.requestId,
        ok: true,
        response,
      },
      window.location.origin,
    );
  } catch (error) {
    window.postMessage(
      {
        source: "blockchain-vpn-extension",
        requestId: data.requestId,
        ok: false,
        error: error?.message || String(error),
      },
      window.location.origin,
    );
  }
});
