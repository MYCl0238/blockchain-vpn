# Browser Extensions

Cross-browser proxy extension scaffold for:

- Chrome / Chromium browsers via `chrome.proxy`
- Firefox / Zen via `browser.proxy.settings`

## Purpose

This extension is the browser-only control path.

It is separate from the full-device custom tunnel clients.

Use it when you want:

- browser traffic routed through a proxy
- connect/disconnect from the browser UI
- optional proxy authentication

It does **not** create a system TUN interface and does **not** run the custom UDP tunnel client directly.

## Structure

- `chrome/`
  Manifest V3 build for Chrome/Chromium.

- `firefox/`
  Firefox/Zen build using the Firefox proxy API.

## Current design

The popup stores:

- proxy host
- proxy port
- proxy type
- proxy username
- proxy password
- bypass list
- enabled/disabled state

The background script:

- applies proxy settings
- clears proxy settings
- supplies HTTP/HTTPS proxy credentials on `407 Proxy Authentication Required`

## Important limitation

Browser extensions can control browser proxy settings.

They cannot directly create the existing custom Linux TUN session from a normal browser context.

So this path assumes a browser-usable proxy backend on the VPS.

## Packaging

Chrome:

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Load unpacked
4. Select `browser-extensions/chrome`

Firefox / Zen:

1. Open `about:debugging`
2. Choose `This Firefox`
3. Load Temporary Add-on
4. Select `browser-extensions/firefox/manifest.json`
5. Open the extension details in `about:addons`
6. Enable `Run in Private Windows`

## Firefox / Zen note

Firefox and Zen require private-window access before an extension can change
global proxy settings. Without that permission, proxy enable/disable fails with
an error like `proxy.settings requires private browsing permission`.
