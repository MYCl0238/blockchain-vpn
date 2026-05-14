const popup = document.getElementById("welcomePopup");

function closePopup() {
  if (popup) {
    popup.style.animation = "fadeOut 0.3s ease forwards";
    setTimeout(() => popup.remove(), 300);
  }
}

let autoCloseTimer = setTimeout(() => {
  closePopup();
}, 5000);

function copyId() {
  const idText = document.getElementById("newUserId").innerText;

  navigator.clipboard
    .writeText(idText)
    .then(() => {
      const btn = document.querySelector(".copy-btn");
      const originalText = btn.innerText;

      btn.innerText = "Kopyalandı!";
      btn.classList.remove("btn-outline-light");
      btn.classList.add("btn-success");

      clearTimeout(autoCloseTimer);
      autoCloseTimer = setTimeout(() => closePopup(), 5000);

      setTimeout(() => {
        btn.innerText = originalText;
        btn.classList.remove("btn-success");
        btn.classList.add("btn-outline-light");
      }, 2000);
    })
    .catch((err) => {
      console.error("Kopyalama başarısız:", err);
    });
}
