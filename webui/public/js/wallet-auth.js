async function startWalletAuth(purpose) {
  const button = document.querySelector(`[data-wallet-purpose="${purpose}"]`);
  const errorBox = document.getElementById("walletError");

  if (errorBox) errorBox.textContent = "";

  if (!window.ethereum) {
    showWalletError("MetaMask bulunamadi. Once tarayici eklentisini yukleyin.");
    return;
  }

  try {
    setWalletButtonState(button, true);

    const accounts = await window.ethereum.request({
      method: "eth_requestAccounts",
    });
    const address = accounts[0];

    const nonceResponse = await fetch("/api/wallet/nonce", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, purpose }),
    });
    const challenge = await nonceResponse.json();

    if (!nonceResponse.ok) {
      throw new Error(challenge.error || "Wallet challenge olusturulamadi.");
    }

    const signature = await window.ethereum.request({
      method: "personal_sign",
      params: [challenge.message, address],
    });

    const authResponse = await fetch(`/api/wallet/${purpose}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address,
        nonce: challenge.nonce,
        signature,
      }),
    });
    const authResult = await authResponse.json();

    if (!authResponse.ok) {
      throw new Error(authResult.error || "Wallet dogrulamasi basarisiz.");
    }

    window.location.href = authResult.redirectTo || "/dashboard";
  } catch (error) {
    showWalletError(error.message || "Wallet islemi iptal edildi.");
  } finally {
    setWalletButtonState(button, false);
  }
}

function setWalletButtonState(button, loading) {
  if (!button) return;

  button.disabled = loading;
  button.dataset.defaultText = button.dataset.defaultText || button.textContent;
  button.textContent = loading ? "MetaMask bekleniyor..." : button.dataset.defaultText;
}

function showWalletError(message) {
  const errorBox = document.getElementById("walletError");

  if (errorBox) {
    errorBox.textContent = message;
  } else {
    alert(message);
  }
}

document.querySelectorAll("[data-wallet-purpose]").forEach((button) => {
  button.addEventListener("click", () => {
    startWalletAuth(button.dataset.walletPurpose);
  });
});
