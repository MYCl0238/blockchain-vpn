# Install — Android

The Android client is an Expo app that wraps a native module backed by
Android's built-in `VpnService` API. Once you grant the VPN consent
dialog, the app talks to the cloud control-plane and routes all device
traffic through the tunnel.

- Package: `com.anonymous.mobile`
- Min SDK: 24 (Android 7.0)
- Target SDK: 34 (Android 14)

## Option A — Sideload the prebuilt APK (recommended)

1. Download `blockchain-vpn.apk` from the latest
   [GitHub release](https://github.com/MYCl0238/blockchain-vpn/releases/latest).
   You can do this from the phone's browser directly.

2. Open the file. Android will warn you that this came from an unknown
   source — that's expected, this isn't on Play. Tap **Settings →
   Install unknown apps** for your browser, toggle "Allow", then go
   back and tap **Install**.

3. Launch **Blockchain VPN**. Either:
   - **Register** to mint a new account key (16-char ID). **Save it
     somewhere safe** — it's the only credential.
   - **Login** with an existing key.

4. Tap **Connect VPN**. Android will pop up:

   > Blockchain VPN wants to set up a VPN connection that allows it to
   > monitor network traffic. Only accept if you trust the source.

   Tap **OK**. The little key icon appears in the status bar — the
   tunnel is live.

5. Sanity check from the phone's browser:
   `https://ipinfo.io/ip` should show the server's public IP.

## Option B — Build the APK yourself

You'll need: Node 18+, JDK 17, Android SDK with platform 34 and
build-tools, and an `ANDROID_HOME` exported.

```bash
cd apps/cross-platform-app
npm install
cd android
./gradlew assembleRelease
# APK lands in app/build/outputs/apk/release/app-release.apk
```

> The release build is unsigned by default. For sideloading on your
> own devices you can use a debug build (`./gradlew assembleDebug`) or
> sign with your own keystore.

## Permissions

The manifest declares:

- `android.permission.INTERNET` — talk to the control-plane
- `android.permission.SYSTEM_ALERT_WINDOW` — overlay (vestigial, from
  Expo defaults)
- `android.permission.VIBRATE` — haptics on the dashboard
- `READ/WRITE_EXTERNAL_STORAGE` — Expo defaults; not actually used by
  the VPN

The VpnService consent dialog itself isn't an Android permission —
it's a per-app system prompt that has to be re-granted any time you
clear the app's data or reinstall.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Consent dialog never appears | Another VPN app is already holding the system VPN slot | Disconnect/disable the other VPN, try again |
| Connect spinner then "Disconnected" | Control-plane unreachable / wrong token | Force-stop the app, sign out, sign back in |
| Tunnel up but no traffic | DNS not coming through tunnel | Toggle airplane mode briefly to flush the route table |
| App keeps tunnel alive after swipe-away | This is intentional — `START_STICKY` foreground service | Use the Disconnect button to actually stop it |

## Uninstall

Long-press the app icon → **App info** → **Uninstall**.
