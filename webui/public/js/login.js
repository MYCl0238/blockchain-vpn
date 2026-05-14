const inputs = document.querySelectorAll(".key-input");
const hiddenInput = document.getElementById("realLoginKey");
const form = document.getElementById("loginForm");

inputs.forEach((input, index) => {
  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

    if (input.value.length === 4 && index < inputs.length - 1) {
      inputs[index + 1].focus();
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && input.value.length === 0 && index > 0) {
      inputs[index - 1].focus();
    }
  });

  input.addEventListener("paste", (e) => {
    e.preventDefault();
    let pasted = (e.clipboardData || window.clipboardData).getData("text");
    pasted = pasted.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

    let i = 0;
    for (let j = index; j < inputs.length; j++) {
      if (i >= pasted.length) break;
      let chunk = pasted.slice(i, i + 4);
      inputs[j].value = chunk;
      i += chunk.length;
    }
  });
});

form.addEventListener("submit", () => {
  let fullKey = "";
  inputs.forEach((input) => (fullKey += input.value));
  hiddenInput.value = fullKey;
});
